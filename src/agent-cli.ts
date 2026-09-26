// DearByte's agent in the terminal: ask one question, chat, or check status.
// Uses the brain tier, the persona from DEARBYTE_PERSONA, and whatever tools
// are set up (health needs HEALTH_MCP_URL). Every model call is logged and
// counts toward the weekly cap.
//
//   npm run agent -- ask "How did I sleep?"
//   npm run agent -- chat
//   npm run agent -- status
//   npm run agent -- brief [--force]   the morning brief now
//   npm run agent -- check             run the caution rules once
//   npm run agent -- watch             keep running: brief at 07:30, checks every 15 min
//   npm run agent -- alerts            what DearByte sent on its own lately
//   npm run agent -- telegram          set up Telegram, or test it with a sample approval

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
import { runCautionCheck, runMorningBrief, tick, type Notify, type Outcome, type ScheduledDeps } from "./agent/scheduled.ts";
import { proposeApproval, type ApprovalHandlers } from "./agent/approvals.ts";
import { systemNotifier } from "./alerts.ts";
import { Store } from "./storage/store.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { feedbackButtons, pollInbox, sendApproval, type InboxDeps } from "./telegram/inbox.ts";

const USAGE = `Usage:
  npm run agent -- ask "question"   answer one question
  npm run agent -- chat             talk until /quit
  npm run agent -- status           models, tools, spending
  npm run agent -- brief [--force]  send the morning brief now
  npm run agent -- check            run the caution rules once
  npm run agent -- watch            keep running: brief at 07:30, caution checks every 15 min
  npm run agent -- alerts           recent briefs and alerts
  npm run agent -- telegram         set up Telegram, or test it`;

const config = loadConfig();
const [command, ...rest] = process.argv.slice(2);
if (!["ask", "chat", "status", "brief", "check", "watch", "alerts", "telegram"].includes(command ?? "")) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
if ("problem" in config.agent) fail(config.agent.problem);
if (typeof config.agentPersona !== "string") fail(config.agentPersona.problem);
const persona = config.agentPersona;
const tiers = config.agent;

const store = Store.open(config.dbPath);
const models = createTierModels(tiers, { store, weeklyCap: config.agentWeeklyCap });
const { tools, health, bridge } = agentToolset({ store, timeZone: config.timeZone, healthMcpUrl: config.healthMcpUrl });
const system = agentSystemPrompt(ROOT, persona);
if (config.telegram && "problem" in config.telegram) fail(config.telegram.problem);
const telegramSetup = config.telegram;
/** Telegram, once both the token and the chat are known. */
const telegram = telegramSetup?.chatId ? { bot: new TelegramBot(telegramSetup.token), chatId: telegramSetup.chatId } : null;

/** What each kind of approval does once approved. The wallet adds "purchase". */
const approvalHandlers: ApprovalHandlers = {
  test: async () => "This was a test, so nothing else happens.",
};

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
  console.log(`Alerts:  ${telegram ? "Telegram, then the terminal" : telegramSetup ? "the terminal (Telegram needs TELEGRAM_CHAT_ID: npm run agent -- telegram)" : "the terminal and macOS notifications (npm run agent -- telegram to set up Telegram)"}`);
  const fb = store.alertFeedback(new Date(Date.now() - WEEK_MS).toISOString().slice(0, 10));
  if (fb.sent) console.log(`Rated:   ${fb.sent} alerts in the last 7 days, ${fb.useful} useful, ${fb.noise} not useful`);
  console.log(`Memory:  ${store.memoryEnabled() ? `on, ${store.activeFacts().length} facts` : "off"}`);
  console.log(
    `Spend:   $${weekSpend.toFixed(4)} in the last 7 days${config.agentWeeklyCap > 0 ? ` of a $${config.agentWeeklyCap} cap` : " (no cap)"} · npm run agent:usage for details`,
  );
}

/** Always printed here; sent to Telegram when it's set up, otherwise (or if Telegram fails) shown as a macOS notification. */
const notify: Notify = async (title, body, o = {}) => {
  console.log(`\n── ${title} ──\n${body}\n`);
  if (telegram) {
    try {
      await telegram.bot.send(telegram.chatId, `${title}\n\n${body}`, o.alertId ? feedbackButtons(o.alertId) : []);
      return true;
    } catch (err) {
      console.error(dim(`${(err as Error).message}; showing a macOS notification instead`));
    }
  }
  systemNotifier(config.alertUrl, (m) => console.error(m))(title, body.slice(0, 200));
  return true;
};

function inboxDeps(): InboxDeps & { bot: TelegramBot } {
  if (!telegram) fail("Telegram isn't set up: npm run agent -- telegram");
  return { ...telegram, store, handlers: approvalHandlers };
}

function scheduledDeps(): ScheduledDeps {
  if (!bridge) fail("Health isn't set up: add HEALTH_MCP_URL to .env (see dearbyte-bridge docs/SETUP.md).");
  return { bridge, store, model: models.brain, tools, system, timeZone: config.timeZone, notify, onEvent: (e) => console.log(dim(describeEvent(e))) };
}

function report(o: Outcome): void {
  if (!o.sent) console.log(dim(`nothing sent: ${o.reason}${o.triggers.length ? ` (rules: ${o.triggers.map((t) => t.kind).join(", ")})` : ""}`));
  else if (!o.delivered) console.log("Written, but delivery failed; it's saved in npm run agent -- alerts.");
}

function listAlerts(): void {
  const alerts = store.recentAlerts(10);
  if (!alerts.length) return console.log("Nothing sent yet.");
  for (const a of alerts.reverse()) {
    const rated = a.feedback ? ` · rated ${a.feedback === "useful" ? "useful" : "not useful"}` : "";
    console.log(dim(`${a.at.slice(0, 16).replace("T", " ")} UTC · ${a.kind}${a.triggers.length ? ` · ${a.triggers.join(", ")}` : ""}${a.delivered ? "" : " · not delivered"}${rated}`));
    console.log(`${a.text}\n`);
  }
}

const TICK_MS = 15 * 60_000;

async function watch(): Promise<void> {
  const deps = scheduledDeps();
  console.log(dim(`Watching: morning brief after 07:30, caution checks every 15 minutes, quiet 23:00-07:00 (${config.timeZone}). Ctrl-C to stop.`));
  if (telegram) {
    // Button taps are handled alongside the checks, for as long as watch runs.
    const stop = new AbortController();
    process.once("SIGINT", () => (stop.abort(), process.exit(0)));
    void pollInbox(inboxDeps(), { signal: stop.signal, log: (line) => console.log(dim(`telegram: ${line}`)) });
    console.log(dim("Telegram: sending alerts and listening for button taps."));
  }
  for (;;) {
    try {
      report(await tick(deps));
    } catch (err) {
      // One failed tick (bridge down, model error) must not stop the loop.
      console.error(dim(`check failed: ${(err as Error).message}`));
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

const TELEGRAM_STEPS = `Telegram setup:
  1. In Telegram, message @BotFather, send /newbot, and follow the steps. It gives you a token.
  2. Add it to .env:  TELEGRAM_BOT_TOKEN=<token>   (keep it secret: whoever has it controls the bot)
  3. Send your new bot any message (for example "hi").
  4. Run  npm run agent -- telegram  again to find your chat id.`;

/** Setup in steps: without a token, the instructions; without a chat id, find it; with both, a live test. */
async function telegramCommand(): Promise<void> {
  if (!telegramSetup) return console.log(TELEGRAM_STEPS);
  if (!telegram) {
    const updates = await new TelegramBot(telegramSetup.token).updates(0, 0);
    const chats = new Map<number, string>();
    for (const u of updates) {
      const chat = u.message?.chat;
      if (chat?.type === "private") chats.set(chat.id, chat.first_name ?? chat.username ?? "unknown");
    }
    if (!chats.size) return console.log("No messages yet. Send your bot any message in Telegram, then run this again.");
    for (const [id, name] of chats) console.log(`Chat with ${name}: add  TELEGRAM_CHAT_ID=${id}  to .env`);
    console.log(dim("Only this chat will be able to use the buttons; messages from anyone else are ignored."));
    return;
  }
  const deps = inboxDeps();
  await deps.bot.send(deps.chatId, "DearByte is connected. Alerts and approval requests will come here.");
  const approval = proposeApproval(store, { kind: "test", summary: "Test: tap Approve or Reject to check the buttons work. Nothing happens either way.", payload: null }, new Date());
  await sendApproval(deps.bot, deps.chatId, approval);
  console.log("Sent a test approval to Telegram. Tap a button there (waiting up to 2 minutes)...");
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 120_000);
  await pollInbox(deps, {
    signal: stop.signal,
    log: (line) => {
      console.log(dim(`telegram: ${line}`));
      if (line.startsWith(`approval ${approval.id}:`)) stop.abort();
    },
  });
  clearTimeout(timer);
  const decided = store.approval(approval.id);
  console.log(decided?.status === "pending" ? "No tap arrived. Check the bot token and chat id, then try again." : `Telegram works: the test was ${decided?.status}.`);
}

async function main(): Promise<void> {
  if (command === "telegram") return telegramCommand();
  if (command === "status") return status();
  if (command === "alerts") return listAlerts();
  if (command === "brief") return report(await runMorningBrief(scheduledDeps(), { force: rest.includes("--force") }));
  if (command === "check") return report(await runCautionCheck(scheduledDeps()));
  if (command === "watch") return watch();
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
