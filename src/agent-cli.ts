// DearByte's agent in the terminal: ask one question, chat, or check status.
// Uses the brain tier, the persona from DEARBYTE_PERSONA, and whatever tools
// are set up (health needs HEALTH_MCP_URL). Every model call is logged and
// counts toward the weekly cap.
//
//   npm run agent -- ask "How did I sleep?"
//   npm run agent -- chat
//   npm run agent -- status

import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, ROOT } from "./config.ts";
import { dim } from "./console.ts";
import { runAgent, type LoopEvent, type LoopResult } from "./agent/loop.ts";
import type { AgentMessage } from "./agent/model.ts";
import { agentSystemPrompt, withCurrentTime } from "./agent/persona.ts";
import { createTierModels } from "./agent/tiers.ts";
import { agentToolset } from "./agent/toolset.ts";
import { WEEK_MS } from "./agent/usage.ts";
import { Store } from "./storage/store.ts";

const USAGE = `Usage:
  npm run agent -- ask "question"   answer one question
  npm run agent -- chat             talk until /quit
  npm run agent -- status           models, tools, spending`;

const config = loadConfig();
const [command, ...rest] = process.argv.slice(2);
if (!["ask", "chat", "status"].includes(command ?? "")) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
if ("problem" in config.agent) fail(config.agent.problem);
if (typeof config.agentPersona !== "string") fail(config.agentPersona.problem);
const persona = config.agentPersona;
const tiers = config.agent;

const store = Store.open(config.dbPath);
const models = createTierModels(tiers, { store, weeklyCap: config.agentWeeklyCap });
const { tools, health } = agentToolset({ store, timeZone: config.timeZone, healthMcpUrl: config.healthMcpUrl });
const system = agentSystemPrompt(ROOT, persona);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function describeEvent(e: LoopEvent): string {
  return e.type === "step"
    ? `step ${e.n} · ${e.model} · ${(e.ms / 1000).toFixed(1)}s${e.cost === null ? "" : ` · $${e.cost.toFixed(5)}`}`
    : `  ${e.name} ${e.ok ? "ok" : "failed"} (${e.ms} ms)`;
}

/** What to tell the user when a run ends without an answer. */
function explainStop(r: LoopResult): string | null {
  switch (r.stop) {
    case "done":
      return null;
    case "weekly_cap":
      return `Stopped: the weekly spending cap ($${config.agentWeeklyCap}) is reached. Raise DEARBYTE_WEEKLY_CAP or wait for older spend to age out.`;
    case "budget":
      return "Stopped: this answer hit the per-run spending limit.";
    case "max_steps":
      return "Stopped: too many steps without an answer. Try a narrower question.";
    case "refusal":
      return "The model declined to answer this one.";
    case "truncated":
      return r.text ? null : "The answer was cut off. Try again, or ask for less.";
    default:
      return "The model stopped without an answer.";
  }
}

async function turn(messages: AgentMessage[], text: string, purpose: string): Promise<LoopResult> {
  const result = await runAgent({
    model: models.brain,
    tools,
    system,
    messages: [...messages, { role: "user", content: withCurrentTime(text, new Date(), config.timeZone) }],
    purpose,
    onEvent: (e) => console.log(dim(describeEvent(e))),
  });
  if (result.text) console.log(`\n${result.text}\n`);
  const why = explainStop(result);
  if (why) console.log(why);
  console.log(dim(`$${result.cost.toFixed(5)} · ${result.steps} step${result.steps === 1 ? "" : "s"}`));
  return result;
}

function status(): void {
  const weekSpend = store.agentSpendSince(new Date(Date.now() - WEEK_MS).toISOString());
  console.log(`Brain:   ${tiers.brain.provider}:${tiers.brain.model}${tiers.brain.effort ? ` (effort ${tiers.brain.effort})` : ""}`);
  console.log(`Worker:  ${tiers.worker.provider}:${tiers.worker.model}`);
  console.log(`Persona: ${persona}`);
  console.log(`Tools:   ${tools.definitions().map((t) => t.name).join(", ")}`);
  console.log(`Health:  ${health ? "connected to dearbyte-bridge (HEALTH_MCP_URL)" : "not set up (add HEALTH_MCP_URL to .env; see dearbyte-bridge docs/SETUP.md)"}`);
  console.log(`Memory:  ${store.memoryEnabled() ? `on, ${store.activeFacts().length} facts` : "off"}`);
  console.log(
    `Spend:   $${weekSpend.toFixed(4)} in the last 7 days${config.agentWeeklyCap > 0 ? ` of a $${config.agentWeeklyCap} cap` : " (no cap)"} · npm run agent:usage for details`,
  );
}

async function main(): Promise<void> {
  if (command === "status") return status();
  if (command === "ask") {
    const question = rest.join(" ").trim();
    if (!question) fail('Ask something: npm run agent -- ask "How did I sleep?"');
    const result = await turn([], question, "ask");
    process.exitCode = result.stop === "done" || result.text ? 0 : 1;
    return;
  }

  console.log(dim(`DearByte · ${tiers.brain.model} · ${health ? "health connected" : "no health data yet"} · /quit to leave\n`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let messages: AgentMessage[] = [];
  rl.setPrompt("you › ");
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/quit") break;
    if (line) {
      const result = await turn(messages, line, "chat");
      // Keep the conversation only when it ended cleanly, so the next turn never follows a half-finished one.
      if (result.stop === "done") messages = result.messages;
    }
    rl.prompt();
  }
  rl.close();
}

try {
  await main();
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("The model API key was rejected.");
  else if (err instanceof Anthropic.APIError) console.error(`Model API error ${err.status}: ${err.message}`);
  else console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
