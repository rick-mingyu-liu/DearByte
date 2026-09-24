#!/usr/bin/env node
// Persona bake-off: runs tools/bakeoff-cases.json through one model and writes a
// readable report to data/bakeoff/. No dependencies; needs Node 18+.
//
//   node tools/bakeoff.mjs                      # all cases, deepseek-flash
//   node tools/bakeoff.mjs --case cat-photo     # one case
//   node tools/bakeoff.mjs --model deepseek-v4-pro --temperature 1.3
//
// Reads DEEPSEEK_API_KEY from the environment or .env (gitignored).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// USD per 1M tokens at peak rates (off-peak is half). Checked 2026-09-24:
// https://api-docs.deepseek.com/quick_start/pricing
const PRICES = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2, vision: true },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96, vision: false },
};

function parseArgs(argv) {
  const opts = { model: "deepseek-flash", temperature: 1.0, case: null };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--model") opts.model = value;
    else if (flag === "--temperature") opts.temperature = Number(value);
    else if (flag === "--case") opts.case = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!PRICES[opts.model]) throw new Error(`No pricing entry for ${opts.model}`);
  return opts;
}

function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("DEEPSEEK_API_KEY="));
    if (line) return line.slice("DEEPSEEK_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DEEPSEEK_API_KEY not set. Add it to .env (gitignored) or export it.");
}

// Example context/image descriptions ride along in the user turn, mirroring how
// the real runtime will present memory and history.
function userText({ context, image, user }) {
  return [context && `[背景] ${context}`, image && `[图片] ${image}`, user].filter(Boolean).join("\n");
}

// Examples live in the system prompt, not as chat turns: sent as turns, the model
// treated them as real shared history and "remembered" the dog and the exam.
function examplesSection(examples) {
  const blocks = examples.map((ex) => `用户：${userText(ex)}\n小拜：${JSON.stringify({ bubbles: ex.bubbles })}`);
  return [
    "## 示例",
    "下面是和其他虚构用户的对话片段，只用来示范说话方式。它们不是你和这位用户的聊天记录：不要引用、回忆或提起里面的任何人、事、物。",
    ...blocks,
  ].join("\n\n");
}

function buildMessages(testCase, persona, examples, safety) {
  const system = [persona, examplesSection(examples), testCase.safety && safety].filter(Boolean).join("\n\n");
  const messages = [{ role: "system", content: system }];
  for (const turn of testCase.history ?? []) {
    messages.push({
      role: turn.role,
      content: turn.role === "assistant" ? JSON.stringify({ bubbles: [turn.text] }) : turn.text,
    });
  }
  const text = userText({ context: testCase.context, user: testCase.user }) || "（用户只发了一张图）";
  if (!testCase.image) {
    messages.push({ role: "user", content: text });
  } else {
    const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[
      extname(testCase.image).toLowerCase()
    ];
    if (!mime) throw new Error(`Unsupported image type: ${testCase.image}`);
    const b64 = readFileSync(join(ROOT, testCase.image)).toString("base64");
    messages.push({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        { type: "text", text },
      ],
    });
  }
  return messages;
}

// Mirrors the reply contract: 1–4 non-empty bubbles, each ≤120 code points.
function validate(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { bubbles: [], problems: ["not valid JSON"] };
  }
  const bubbles = Array.isArray(parsed?.bubbles) ? parsed.bubbles : [];
  const problems = [];
  if (bubbles.length < 1 || bubbles.length > 4) problems.push(`${bubbles.length} bubbles`);
  bubbles.forEach((b, i) => {
    if (typeof b !== "string" || !b.trim()) problems.push(`bubble ${i + 1} empty`);
    else if ([...b].length > 120) problems.push(`bubble ${i + 1} is ${[...b].length} chars`);
  });
  return { bubbles, problems };
}

async function callModel(apiKey, model, temperature, messages) {
  const started = Date.now();
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature, messages, response_format: { type: "json_object" }, max_tokens: 800 }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  return { raw: body.choices?.[0]?.message?.content ?? "", usage: body.usage ?? {}, ms: Date.now() - started };
}

function cost(model, usage) {
  const p = PRICES[model];
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? (usage.prompt_tokens ?? 0) - hit;
  return (hit * p.hit + miss * p.miss + (usage.completion_tokens ?? 0) * p.out) / 1e6;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const persona = read("prompts/persona.zh-CN.md");
  const safety = read("prompts/safety.zh-CN.md");
  const examples = JSON.parse(read("prompts/dialogue-examples.zh-CN.json")).examples;
  let cases = JSON.parse(read("tools/bakeoff-cases.json")).cases;
  if (opts.case) cases = cases.filter((c) => c.id === opts.case);
  if (!cases.length) throw new Error(`No case matches ${opts.case}`);

  const report = [`# Bake-off: ${opts.model} · temperature ${opts.temperature}`, "", `Run at ${new Date().toISOString()}`, ""];
  let total = 0;
  for (const c of cases) {
    if (c.image && !PRICES[opts.model].vision) {
      console.log(`- ${c.id}: skipped (${opts.model} has no image input)`);
      continue;
    }
    if (c.image && !existsSync(join(ROOT, c.image))) {
      console.log(`- ${c.id}: skipped (put a photo at ${c.image})`);
      continue;
    }
    process.stdout.write(`- ${c.id} … `);
    try {
      const { raw, usage, ms } = await callModel(apiKey, opts.model, opts.temperature, buildMessages(c, persona, examples, safety));
      const { bubbles, problems } = validate(raw);
      const usd = cost(opts.model, usage);
      total += usd;
      console.log(`${ms} ms · $${usd.toFixed(5)}${problems.length ? ` · ⚠ ${problems.join(", ")}` : ""}`);
      bubbles.forEach((b) => console.log(`    ${b}`));
      report.push(`## ${c.id}`, "");
      if (c.context) report.push(`> 背景：${c.context}`);
      for (const h of c.history ?? []) report.push(`> ${h.role === "user" ? "用户" : "小拜"}：${h.text}`);
      if (c.image) report.push(`> [图片 ${c.image}]`);
      report.push(`> 用户：${c.user || "（无文字）"}`, "");
      bubbles.forEach((b) => report.push(`- ${b}`));
      if (problems.length) report.push("", `⚠ ${problems.join(", ")}`, "", "```", raw, "```");
      report.push("", `<sub>${ms} ms · ${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out · $${usd.toFixed(5)}</sub>`, "");
    } catch (err) {
      console.log(`failed: ${err.message}`);
      report.push(`## ${c.id}`, "", `Failed: ${err.message}`, "");
    }
  }
  report.push(`**Total at peak rates:** $${total.toFixed(4)}`);

  const dir = join(ROOT, "data/bakeoff");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.model}.md`);
  writeFileSync(file, report.join("\n"));
  console.log(`\nTotal $${total.toFixed(4)} at peak rates · report: ${file.replace(ROOT, "")}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
