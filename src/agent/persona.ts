// The agent's system prompt: a persona (tone, identity, crisis resources for
// its region) plus rules that hold whatever the persona. Personas are packs,
// one folder each under personas/, so anyone can add one in a PR:
//
//   personas/<id>/persona.json   manifest: name, language, authors, license, version, crisis contacts
//   personas/<id>/persona.md     who the agent is and how it talks
//   personas/<id>/examples.json  optional made-up exchanges that show the tone
//
// DEARBYTE_PERSONA picks the pack; "default" is DearByte in English. A pack
// sets the tone and never the rules: prompts/agent/rules.en.md goes after
// every persona and wins where they differ, and approvals and caps are code.
// checkPack is what CI runs on every pack. The WeChat companion keeps its own
// prompts (prompts/*.zh-CN.*) and is not affected by this.
//
// The prompt is identical for every request, so the provider's prompt cache
// covers it. Anything that changes (the time, today's data) goes in the
// messages instead: see withCurrentTime.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PERSONA_DIR = "personas";
export const DEFAULT_PERSONA = "default";
const RULES = "prompts/agent/rules.en.md";

/** Limits that keep a pack a persona, not a second system prompt. */
export const LIMITS = { personaChars: 8_000, examples: 12, exampleChars: 600 };

const Id = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "lowercase letters, digits and dashes, 2-32 characters, starting with a letter");

export const Manifest = z.strictObject({
  id: Id,
  name: z.string().min(1).max(40),
  description: z.string().min(1).max(160),
  /** A BCP 47 tag: en, zh-CN, es-MX... */
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language tag like en or zh-CN"),
  authors: z.array(z.strictObject({ name: z.string().min(1).max(60), github: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional() })).min(1),
  license: z.enum(["MIT", "CC-BY-4.0", "CC0-1.0"]),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "a version like 1.0.0"),
  added: z.iso.date(),
  /** Where the crisis contacts apply, and the numbers or services persona.md tells someone in danger to reach. */
  crisis: z.strictObject({ region: z.string().min(1).max(60), contacts: z.array(z.string().min(2).max(60)).min(1) }),
});
export type Manifest = z.infer<typeof Manifest>;

const ExampleSchema = z.object({ context: z.string().optional(), user: z.string().min(1), reply: z.string().min(1) });
// `id` and `note` are for authors and never reach the model; nothing else is allowed.
const ExamplesFile = z.object({ _readme: z.string().optional(), examples: z.array(ExampleSchema.extend({ id: z.string().optional(), note: z.string().optional() }).strict()) });
type Example = z.infer<typeof ExampleSchema>;

export type Pack = { manifest: Manifest; persona: string; examples: Example[] };

/**
 * Phrases a persona has no reason to contain: attempts to override the rules,
 * to grant itself powers the rules deny, or to smuggle in a second system
 * prompt. A match fails CI; a maintainer still reads every pack.
 */
const RULE_WORDS = String.raw`(rules|instructions|directions|system prompt|guidelines)`;
const OVERRIDES: [RegExp, string][] = [
  // "the rules below", "all previous instructions", "everything that follows" — not "fad diet rules" or "the rules of chess".
  [new RegExp(String.raw`\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,20}\b(the|these|your|all|any|previous|prior|above|below|following|operator'?s?)\s+${RULE_WORDS}\b(?!\s+(of|on|about)\b)|\b(ignore|disregard)\s+(everything|anything|all)\s+(that\s+)?(follows|below|after this|above)|\bdisregard the next section`, "i"), "tries to override the rules"],
  [new RegExp(String.raw`\b${RULE_WORDS}\b[^.\n]{0,30}\b(don'?t|do not|no longer)\s+apply\b`, "i"), "tries to override the rules"],
  [/\b(approve|make|authori[sz]e|complete)\s+(a\s+|the\s+|any\s+)?(purchases?|payments?|transactions?|bookings?)\b|\b(pay|spend)\b[^.\n]{0,20}\b(money|\$\d|usdc|funds)\b|\bpay\s+(for\s+it|for\s+things|for\s+anything|the\s+seller)\b|\b(buy|purchase)\s+(it|things|anything|items)\s+(yourself|for them|without asking)\b|\bapproval\b[^.\n]{0,20}\balready (given|granted)\b|\bpermission to (pay|spend|buy|purchase)\b/i, "gives itself power over money"],
  [/\b(reveal|print|repeat|share|show)\b[^.\n]{0,20}\b(system prompt|(these|your|the operator'?s) (rules|instructions) verbatim)\b/i, "asks to reveal the prompt"],
  [/<\/?\s*(system|instructions?|rules?)\b|^#{1,6}\s*Rules that apply/im, "imitates the system prompt's structure"],
  [/(忽略|无视|绕过|不用遵守|不必遵守|无需遵守|不要遵守)[^。\n]{0,20}(规则|指令|规定|系统提示)/, "tries to override the rules"],
  [/https?:\/\//i, "contains a link (persona text shouldn't point anywhere)"],
  [/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/, "contains invisible characters"],
];

/** Pack ids found under personas/, sorted. A folder counts once it has a manifest. */
export function listPersonas(root: string): string[] {
  const dir = join(root, PERSONA_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && Id.safeParse(d.name).success && existsSync(join(dir, d.name, "persona.json")))
    .map((d) => d.name)
    .sort();
}

/** Reads a pack without judging it; checkPack does that. Throws if a file is missing or malformed. */
export function loadPack(root: string, id: string): Pack {
  if (!Id.safeParse(id).success) throw new Error(`"${id}" isn't a persona id`);
  const dir = join(root, PERSONA_DIR, id);
  for (const file of ["persona.json", "persona.md"]) {
    if (!existsSync(join(dir, file))) throw new Error(`there's no ${file} in ${PERSONA_DIR}/${id}`);
  }
  const manifest = parseFile(join(dir, "persona.json"), Manifest);
  const persona = readFileSync(join(dir, "persona.md"), "utf8").trim();
  const examplesPath = join(dir, "examples.json");
  const examples = existsSync(examplesPath) ? parseFile(examplesPath, ExamplesFile).examples.map(({ context, user, reply }) => ({ context, user, reply })) : [];
  return { manifest, persona, examples };
}

/** A JSON file checked against its schema; errors name the file. */
function parseFile<T>(path: string, schema: z.ZodType<T>): T {
  const name = path.split("/").at(-1);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${name} isn't valid JSON: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${name} doesn't match the format:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** What's in personas/ that isn't a pack: CI fails on these so a misnamed folder can't be merged unnoticed. */
export function strayEntries(root: string): string[] {
  const dir = join(root, PERSONA_DIR);
  if (!existsSync(dir)) return [];
  const packs = new Set(listPersonas(root));
  return readdirSync(dir)
    .filter((name) => name !== "INDEX.md" && !packs.has(name))
    .map((name) => `personas/${name} isn't a pack: a pack is a folder named like "my-persona" (lowercase letters, digits and dashes, 2-32 characters) holding persona.json`);
}

/** Everything wrong with a pack, as sentences a contributor can act on. Empty means it passes. */
export function checkPack(root: string, id: string): string[] {
  let pack: Pack;
  try {
    pack = loadPack(root, id);
  } catch (err) {
    return [(err as Error).message];
  }
  const { manifest, persona, examples } = pack;
  const problems: string[] = [];
  // A symlink in a PR could point a pack at any file on the user's machine (.env) and send it to the model.
  for (const file of ["persona.json", "persona.md", "examples.json"]) {
    const path = join(root, PERSONA_DIR, id, file);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) problems.push(`${file} is a symlink; packs must hold real files`);
  }
  for (const file of readdirSync(join(root, PERSONA_DIR, id))) {
    if (!["persona.json", "persona.md", "examples.json"].includes(file)) problems.push(`${file} isn't part of a pack (only persona.json, persona.md and examples.json)`);
  }
  for (const [field, text] of [["name", manifest.name], ["description", manifest.description]]) {
    if (/https?:\/\/|[<>\[\]]/.test(text!)) problems.push(`persona.json's ${field} has a link or markup; keep it plain text`);
  }
  if (manifest.id !== id) problems.push(`persona.json says id "${manifest.id}" but the folder is "${id}"`);
  if (!persona) problems.push("persona.md is empty");
  if (persona.length > LIMITS.personaChars) problems.push(`persona.md is ${persona.length} characters; the limit is ${LIMITS.personaChars}`);
  if (examples.length > LIMITS.examples) problems.push(`examples.json has ${examples.length} examples; the limit is ${LIMITS.examples}`);
  examples.forEach((e, i) => {
    const size = (e.context ?? "").length + e.user.length + e.reply.length;
    if (size > LIMITS.exampleChars) problems.push(`example ${i + 1} is ${size} characters; the limit is ${LIMITS.exampleChars}`);
  });
  const texts: [string, string][] = [["persona.md", persona], ...examples.map((e, i): [string, string] => [`example ${i + 1}`, [e.context, e.user, e.reply].join("\n")])];
  for (const [where, text] of texts) {
    for (const [pattern, why] of OVERRIDES) {
      const hit = text.match(pattern);
      if (hit) problems.push(`${where} ${why}: "${hit[0].slice(0, 60)}"`);
    }
  }
  for (const contact of manifest.crisis.contacts) {
    if (!persona.includes(contact)) problems.push(`persona.md never gives the crisis contact "${contact}" listed in persona.json`);
  }
  return problems;
}

/** The whole system prompt for this persona. Throws if the pack is missing or malformed. */
export function agentSystemPrompt(root: string, id: string): string {
  const { persona, examples } = loadPack(root, id);
  // Persona and examples first, rules last: the rules win where they differ, and sit nearest the conversation.
  return [persona, examplesSection(examples), readFileSync(join(root, RULES), "utf8").trim()].filter(Boolean).join("\n\n");
}

// Examples are labelled fictional and live in the system prompt, never as chat
// turns: as turns, a model treats them as real shared history.
function examplesSection(examples: Example[]): string {
  if (!examples.length) return "";
  return [
    "# Examples of your tone",
    "These are exchanges with made-up users, only to show how you talk. They are not this user's history: never refer to anything in them.",
    ...examples.map(({ context, user, reply }) => [context && `(${context})`, `User: ${user}`, `You: ${reply}`].filter(Boolean).join("\n")),
  ].join("\n\n");
}

/** personas/INDEX.md: the record of every pack, generated from the manifests (CI checks it's current). */
export function personaIndex(root: string): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = listPersonas(root).flatMap((id) => {
    let m: Manifest;
    try {
      m = loadPack(root, id).manifest;
    } catch {
      return []; // checkPack reports it
    }
    const authors = m.authors.map((a) => (a.github ? `[${cell(a.name)}](https://github.com/${a.github})` : cell(a.name))).join(", ");
    return [`| [\`${id}\`](${id}/persona.md) | ${cell(m.name)} | ${m.language} | ${cell(m.description)} | ${authors} | ${m.version} | ${m.added} | ${m.license} |`];
  });
  return [
    "# Persona packs",
    "",
    "<!-- Generated from each persona.json by `npm run personas -- index`. Don't edit by hand; CI checks it's current. -->",
    "",
    "Pick one with `DEARBYTE_PERSONA=<id>` in `.env`. To add your own, see [docs/personas.md](../docs/personas.md).",
    "",
    "| Id | Name | Language | Description | Authors | Version | Added | License |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** The user's message with the current local time in front, so the system prompt can stay the same all day. */
export function withCurrentTime(text: string, now: Date, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  return `[Now: ${stamp}, ${timeZone}]\n${text}`;
}
