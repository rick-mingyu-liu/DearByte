// Persona bake-off: runs tools/bakeoff-cases.json through the same prompt
// builder the app uses and writes a readable report to data/bakeoff/.
//
//   npm run bakeoff
//   npm run bakeoff -- --case cat-photo
//   npm run bakeoff -- --model deepseek-v4-pro --runs 3

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReply } from "../src/companion/output.ts";
import { buildMessages, buildSystemPrompt, loadPromptParts } from "../src/companion/prompt.ts";
import { toneReport, type ToneReport } from "../src/companion/tone.ts";
import { looksLikeCrisis } from "../src/companion/safety.ts";
import { userEnergy } from "../src/companion/energy.ts";
import { loadConfig, ROOT } from "../src/config.ts";
import type { Fact, StoredMessage } from "../src/domain.ts";
import { loadImage } from "../src/media/images.ts";
import { DeepSeekModel } from "../src/model/deepseek.ts";

type Case = {
  id: string;
  user: string;
  image?: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  facts?: Array<{ value: string; category?: Fact["category"]; eventDate?: string }>;
};

function parseArgs(argv: string[]) {
  const opts = { model: loadConfig().model, case: null as string | null, runs: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--model") opts.model = value;
    else if (flag === "--case") opts.case = value;
    else if (flag === "--runs") opts.runs = Number(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  return opts;
}

const toFacts = (c: Case): Fact[] =>
  (c.facts ?? []).map((f, i) => ({
    id: i + 1,
    category: f.category ?? "event",
    key: `case_${i}`,
    value: f.value,
    eventDate: f.eventDate ?? null,
    evidence: f.value,
    sourceMessageId: null,
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
  }));

const toHistory = (c: Case): StoredMessage[] =>
  (c.history ?? []).map((h, i) => ({
    id: i + 1,
    role: h.role,
    text: h.text,
    bubbles: h.role === "assistant" ? [h.text] : null,
    hasImage: false,
    createdAt: "",
  }));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.apiKey) throw new Error("DEEPSEEK_API_KEY not set. Add it to .env (gitignored).");
  const model = new DeepSeekModel(config.apiKey, opts.model);
  const parts = loadPromptParts(ROOT);
  let cases: Case[] = JSON.parse(readFileSync(join(ROOT, "tools/bakeoff-cases.json"), "utf8")).cases;
  if (opts.case) cases = cases.filter((c) => c.id === opts.case);
  if (!cases.length) throw new Error(`No case matches ${opts.case}`);

  const now = new Date();
  const report = [`# Bake-off: ${model.name}`, "", `Run at ${now.toISOString()} · ${opts.runs} run(s) per case`, ""];
  let total = 0;
  const tones: { id: string; tone: ToneReport; warm: boolean; emoji: boolean }[] = [];

  for (const c of cases) {
    if (c.image && !model.vision) {
      console.log(`- ${c.id}: skipped (${model.name} has no image input)`);
      continue;
    }
    if (c.image && !existsSync(join(ROOT, c.image))) {
      console.log(`- ${c.id}: skipped (put a photo at ${c.image})`);
      continue;
    }
    const facts = toFacts(c);
    const system = buildSystemPrompt(parts, {
      now,
      timeZone: config.timeZone,
      memoryEnabled: facts.length > 0,
      facts,
      crisis: looksLikeCrisis(c.user),
      energy: userEnergy({ text: c.user, image: Boolean(c.image) }),
    });
    const messages = buildMessages(system, toHistory(c), {
      text: c.user,
      image: c.image ? loadImage(join(ROOT, c.image)) : undefined,
    });

    report.push(`## ${c.id}`, "");
    for (const f of facts) report.push(`> 记忆：${f.value}${f.eventDate ? `（${f.eventDate}）` : ""}`);
    for (const h of c.history ?? []) report.push(`> ${h.role === "user" ? "用户" : "小拜"}：${h.text}`);
    if (c.image) report.push(`> [图片 ${c.image}]`);
    report.push(`> 用户：${c.user || "（无文字）"}`, "");

    for (let run = 1; run <= opts.runs; run++) {
      process.stdout.write(`- ${c.id}${opts.runs > 1 ? ` #${run}` : ""} … `);
      try {
        const { text, usage, ms } = await model.complete(messages, { json: true });
        const parsed = parseReply(text);
        const cost = model.cost(usage);
        total += cost;
        const problems = parsed.ok ? [] : parsed.problems;
        const bubbles = parsed.ok ? parsed.reply.bubbles : (parsed.salvage?.bubbles ?? []);
        console.log(`${ms} ms · $${cost.toFixed(5)}${problems.length ? ` · ⚠ ${problems.join(", ")}` : ""}`);
        bubbles.forEach((b) => console.log(`    ${b}`));
        const tone = toneReport(bubbles);
        tones.push({ id: c.id, tone, warm: WARM.test(bubbles.join(" ")), emoji: EMOJI.test(bubbles.join(" ")) });
        if (tone.score) console.log(`    · AI 味 ${tone.score}：${describeTone(tone)}`);
        if (opts.runs > 1) report.push(`**Run ${run}**`, "");
        bubbles.forEach((b) => report.push(`- ${b}`));
        if (problems.length) report.push("", `⚠ ${problems.join(", ")}`, "", "```", text, "```");
        report.push("", `<sub>AI 味 ${tone.score}${tone.score ? `（${describeTone(tone)}）` : ""} · 平均 ${tone.avgChars} 字/条</sub>`);
        report.push("", `<sub>${ms} ms · ${usage.promptTokens} in (${usage.cacheHitTokens} cached) / ${usage.completionTokens} out · $${cost.toFixed(5)}</sub>`, "");
      } catch (err) {
        console.log(`failed: ${(err as Error).message}`);
        report.push(`Failed: ${(err as Error).message}`, "");
      }
    }
  }
  const warm = tones.filter((t) => t.warm).length;
  const emoji = tones.filter((t) => t.emoji).length;
  const summary = `${summarizeTone(tones.map((t) => t.tone))} · warm ${warm}/${tones.length} · emoji ${emoji}/${tones.length}`;
  report.push(`**AI tone:** ${summary} (lower is more human)`, "");
  report.push(`**Total at peak rates:** $${total.toFixed(4)}`);

  const dir = join(ROOT, "data/bakeoff");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}-${model.name}.md`);
  writeFileSync(file, report.join("\n"));
  console.log(`\nAI 味：${summary}`);
  console.log(`Total $${total.toFixed(4)} at peak rates · report: ${file.replace(ROOT, "")}`);
}

/** A pet name, missing or waiting for the user, or an affectionate emoji. */
const EMOJI = /\p{Extended_Pictographic}|\[[^\]\s]{1,4}\]/u;
const WARM = /臭宝|宝贝|宝宝|小乖|笨蛋|想你|想我|等你|找我|陪你|惦记|抱抱|爱你|❤️|🤗|🥺|\[(爱心|拥抱|可怜)\]/;

function describeTone(t: ToneReport): string {
  return [...t.flags, t.longBubbles && `长气泡×${t.longBubbles}`, t.periods && `句号×${t.periods}`].filter(Boolean).join("、");
}

function summarizeTone(ts: ToneReport[]): string {
  if (!ts.length) return "no replies";
  const avg = (f: (t: ToneReport) => number) => (ts.reduce((n, t) => n + f(t), 0) / ts.length).toFixed(1);
  return `score ${avg((t) => t.score)} per reply · ${avg((t) => t.avgChars)} chars per bubble · ${avg((t) => t.bubbles)} bubbles per reply`;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
