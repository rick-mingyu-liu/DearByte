// The agent's system prompt: a persona (tone, identity, crisis resources for
// its region) plus rules that hold whatever the persona. DEARBYTE_PERSONA
// picks the persona; "default" is DearByte in English, "xiaobai" is the
// opt-in Chinese pack. The WeChat companion keeps its own prompts
// (prompts/*.zh-CN.*) and is not affected by this.
//
// The prompt is identical for every request, so the provider's prompt cache
// covers it. Anything that changes (the time, today's data) goes in the
// messages instead: see withCurrentTime.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PERSONAS = ["default", "xiaobai"] as const;
export type Persona = (typeof PERSONAS)[number];

const FILES: Record<Persona, { persona: string; examples?: string }> = {
  default: { persona: "prompts/agent/persona.default.en.md", examples: "prompts/agent/examples.default.en.json" },
  xiaobai: { persona: "prompts/agent/persona.xiaobai.zh-CN.md" },
};
const RULES = "prompts/agent/rules.en.md";

const ExampleSchema = z.object({ context: z.string().optional(), user: z.string(), reply: z.string() });
const ExamplesFile = z.object({ examples: z.array(ExampleSchema.passthrough()) });
type Example = z.infer<typeof ExampleSchema>;

/** The whole system prompt for this persona. Throws if a prompt file is missing or malformed. */
export function agentSystemPrompt(root: string, persona: Persona): string {
  const read = (p: string) => readFileSync(join(root, p), "utf8").trim();
  const files = FILES[persona];
  const examples = files.examples && existsSync(join(root, files.examples)) ? ExamplesFile.parse(JSON.parse(read(files.examples))).examples : [];
  // Persona and examples first, rules last: the rules win where they differ, and sit nearest the conversation.
  return [read(files.persona), examplesSection(examples), read(RULES)].filter(Boolean).join("\n\n");
}

// Examples are labelled fictional and live in the system prompt, never as chat
// turns: as turns, a model treats them as real shared history.
function examplesSection(examples: Example[]): string {
  if (!examples.length) return "";
  return [
    "# Examples of your tone",
    "These are exchanges with made-up users, only to show how you talk. They are not this user's history: never refer to anything in them.",
    // Only the fields meant for the model: `note` and `id` are for authors.
    ...examples.map(({ context, user, reply }) => [context && `(${context})`, `User: ${user}`, `You: ${reply}`].filter(Boolean).join("\n")),
  ].join("\n\n");
}

/** The user's message with the current local time in front, so the system prompt can stay the same all day. */
export function withCurrentTime(text: string, now: Date, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  return `[Now: ${stamp}, ${timeZone}]\n${text}`;
}
