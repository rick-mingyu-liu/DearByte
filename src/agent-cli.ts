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
//   npm run agent -- calendar          allow calendar access, and list the next 48 hours
//   npm run agent -- news              check the company watchlist once
//   npm run agent -- wallet [new]      the testnet wallet: address, balance, limits
//   npm run agent -- approvals         requests waiting for your yes
//   npm run agent -- approve|reject N  answer one in the terminal

import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, ROOT } from "./config.ts";
import { dim } from "./console.ts";
import { localDate } from "./companion/time.ts";
import { runAgent, type LoopEvent, type LoopResult } from "./agent/loop.ts";
import type { AgentMessage } from "./agent/model.ts";
import { agentSystemPrompt, loadPack, withCurrentTime } from "./agent/persona.ts";
import { createTierModels } from "./agent/tiers.ts";
import { agentToolset } from "./agent/toolset.ts";
import { WEEK_MS } from "./agent/usage.ts";
import { runCautionCheck, runMorningBrief, tick, type Notify, type Outcome, type ScheduledDeps } from "./agent/scheduled.ts";
import { approvalText, decide, proposeApproval, type ApprovalHandlers } from "./agent/approvals.ts";
import { systemNotifier } from "./alerts.ts";
import { Store } from "./storage/store.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { feedbackButtons, pollInbox, sendApproval, type InboxDeps } from "./telegram/inbox.ts";
import { checkWatchlist, type WatchlistDeps, type WatchOutcome } from "./watchlist/check.ts";
import { loadWatchlist } from "./watchlist/config.ts";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXPLORER_TX, formatUsd, RPC_URL, USDC } from "./wallet/config.ts";
import { purchaseHandler, type WalletDeps } from "./wallet/purchase.ts";
import { MacCalendar } from "./calendar/mac.ts";
import { clock } from "./calendar/rules.ts";

const USAGE = `Usage:
  npm run agent -- ask "question"   answer one question
  npm run agent -- chat             talk until /quit
  npm run agent -- status           models, tools, spending
  npm run agent -- brief [--force]  send the morning brief now
  npm run agent -- check            run the caution rules once
  npm run agent -- watch            keep running: brief at 07:30, caution checks every 15 min
  npm run agent -- alerts           recent briefs and alerts
  npm run agent -- telegram         set up Telegram, or test it
  npm run agent -- calendar         allow calendar access, list the next 48 hours
  npm run agent -- news             check the company watchlist now
  npm run agent -- wallet [new]     the testnet wallet (new: create one)
  npm run agent -- approvals        requests waiting for your yes
  npm run agent -- approve N        approve request N (or: reject N)`;

const config = loadConfig();
const [command, ...rest] = process.argv.slice(2);
if (!["ask", "chat", "status", "brief", "check", "watch", "alerts", "telegram", "calendar", "news", "wallet", "approvals", "approve", "reject"].includes(command ?? "")) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
if ("problem" in config.agent) fail(config.agent.problem);
if (typeof config.agentPersona !== "string") fail(config.agentPersona.problem);
const persona = config.agentPersona;
const tiers = config.agent;

const store = Store.open(config.dbPath);
const models = createTierModels(tiers, { store, weeklyCap: config.agentWeeklyCap });
const loadedWatchlist = loadWatchlist(config.watchlistPath);
if (loadedWatchlist && "problem" in loadedWatchlist) console.error(dim(`Watchlist ignored: ${loadedWatchlist.problem}`));
const watchlist = loadedWatchlist && !("problem" in loadedWatchlist) ? loadedWatchlist : null;
if (config.telegram && "problem" in config.telegram) fail(config.telegram.problem);
const telegramSetup = config.telegram;
/** Telegram, once both the token and the chat are known. */
const telegram = telegramSetup?.chatId ? { bot: new TelegramBot(telegramSetup.token), chatId: telegramSetup.chatId } : null;
if (config.wallet && "problem" in config.wallet) fail(config.wallet.problem);
const wallet: WalletDeps | null = config.wallet
  ? {
      wallet: config.wallet,
      store,
      timeZone: config.timeZone,
      sendApproval: telegram ? async (a) => (await sendApproval(telegram.bot, telegram.chatId, a), true) : undefined,
      // Printed by code, so what you approve is never just the model's retelling.
      announce: (a) => console.log(`\n── Approval #${a.id} ──\n${approvalText(a)}\nTo answer: /approve ${a.id} or /reject ${a.id} in chat, or npm run agent -- approve ${a.id}\n`),
    }
  : null;
/** The Mac's calendars (iCloud keeps them in sync with the iPhone). */
const calendar = config.calendar ? new MacCalendar() : null;
const { tools, health, bridge } = agentToolset({ store, timeZone: config.timeZone, healthMcpUrl: config.healthMcpUrl, watchlist, wallet, calendar });
const system = agentSystemPrompt(ROOT, persona);

/** What each kind of approval does once approved. A kind without a handler can't be approved. */
const approvalHandlers: ApprovalHandlers = {
  test: async () => "This was a test, so nothing else happens.",
  ...(wallet ? { purchase: purchaseHandler(wallet) } : {}),
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
  const pack = loadPack(ROOT, persona).manifest;
  console.log(`Persona: ${persona} (${pack.name} ${pack.version}, ${pack.language}; npm run personas lists them all)`);
  console.log(`Tools:   ${tools.definitions().map((t) => t.name).join(", ")}`);
  console.log(`Health:  ${health ? "connected to dearbyte-bridge (HEALTH_MCP_URL)" : "not set up (add HEALTH_MCP_URL to .env; see dearbyte-bridge docs/SETUP.md)"}`);
  console.log(`Calendar: ${calendar ? "this Mac's calendars (npm run agent -- calendar to check access)" : "off (DEARBYTE_CALENDAR=off, or not on macOS)"}`);
  console.log(`Alerts:  ${telegram ? "Telegram, then the terminal" : telegramSetup ? "the terminal (Telegram needs TELEGRAM_CHAT_ID: npm run agent -- telegram)" : "the terminal and macOS notifications (npm run agent -- telegram to set up Telegram)"}`);
  console.log(
    `News:    ${
      watchlist
        ? `${watchlist.companies.map((c) => c.name).join(", ")} (newsrooms${config.secContact ? " and SEC filings" : "; SEC filings need SEC_CONTACT_EMAIL"})`
        : "no watchlist (copy watchlist.example.json to watchlist.json)"
    }`,
  );
  console.log(
    `Wallet:  ${
      wallet ? `testnet, ${wallet.wallet.sellers.length} approved seller${wallet.wallet.sellers.length === 1 ? "" : "s"} · npm run agent -- wallet` : "not set up (npm run agent -- wallet new)"
    }`,
  );
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
  return { bridge, store, model: models.brain, tools, system, timeZone: config.timeZone, notify, calendar: calendar ?? undefined, onEvent: (e) => console.log(dim(describeEvent(e))) };
}

function watchlistDeps(): WatchlistDeps {
  if (!watchlist) fail("No watchlist: copy watchlist.example.json to watchlist.json and edit it.");
  return { store, model: models.brain, worker: models.worker, tools, system, timeZone: config.timeZone, notify, watchlist, secContact: config.secContact, onEvent: (e) => console.log(dim(describeEvent(e))) };
}

function reportNews(o: WatchOutcome): void {
  for (const e of o.errors) console.error(dim(`source failed: ${e}`));
  console.log(dim(`news: ${o.added} new, ${o.screened} screened, ${o.relevant} worth a message`));
  if (o.message) report(o.message);
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
/** The watchlist is checked every this many ticks (hourly). */
const NEWS_EVERY = 4;

async function watch(): Promise<void> {
  // Health and news each run when they're set up; at least one must be.
  const deps = bridge ? scheduledDeps() : null;
  const news = watchlist ? watchlistDeps() : null;
  if (!deps && !news) fail("Nothing to watch: set up health (HEALTH_MCP_URL) or a watchlist (watchlist.json).");
  if (deps) console.log(dim(`Health: morning brief after 07:30, caution checks every 15 minutes, quiet 23:00-07:00 (${config.timeZone}).`));
  if (news) console.log(dim(`News: checking ${news.watchlist.companies.length} companies every hour.`));
  console.log(dim("Ctrl-C to stop."));
  if (telegram) {
    // Button taps are handled alongside the checks, for as long as watch runs.
    const stop = new AbortController();
    const listening = pollInbox(inboxDeps(), { signal: stop.signal, log: (line) => console.log(dim(`telegram: ${line}`)) });
    // Ctrl-C lets a tap that's being handled (an approval running) finish before exiting.
    process.once("SIGINT", () => {
      stop.abort();
      void listening.finally(() => process.exit(0));
    });
    console.log(dim("Telegram: sending alerts and listening for button taps."));
  }
  for (let n = 0; ; n++) {
    try {
      if (deps) report(await tick(deps));
    } catch (err) {
      // One failed tick (bridge down, model error) must not stop the loop.
      console.error(dim(`check failed: ${(err as Error).message}`));
    }
    if (news && n % NEWS_EVERY === 0) {
      try {
        reportNews(await checkWatchlist(news));
      } catch (err) {
        console.error(dim(`news check failed: ${(err as Error).message}`));
      }
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

/** Asks macOS for calendar access the first time, then lists the next 48 hours, as the agent will see them. */
async function calendarCommand(): Promise<void> {
  if (!calendar) return console.log("The calendar is off: it needs macOS, and DEARBYTE_CALENDAR not set to off.");
  let access = await calendar.access();
  if (access === "not_determined") {
    console.log("macOS will ask whether DearByte Calendar may access your calendars. DearByte reads titles and times only, skips invites you declined or haven't answered, and sends the titles it uses to your model provider (they can appear in its messages, including Telegram).");
    access = await calendar.requestAccess();
    if (access === "not_determined") {
      return console.log(
        "No answer from macOS yet. If the dialog is still open (it can hide behind other windows), click Allow, then run this again. If no dialog appeared: System Settings → Privacy & Security → Calendars, turn on DearByte Calendar.",
      );
    }
  }
  const now = new Date();
  const result = await calendar.events(now, new Date(now.getTime() + 48 * 3_600_000));
  if (result.status !== "ok") return console.log(result.message);
  console.log(`Calendar access works. The next 48 hours (${config.timeZone}):`);
  if (!result.events.length) console.log("  nothing scheduled");
  for (const e of result.events) console.log(`  ${localDate(e.start, config.timeZone)} ${e.allDay ? "all day" : `${clock(e.start, config.timeZone)}-${clock(e.end, config.timeZone)}`}  ${e.title}`);
  console.log(dim("If events you see on your iPhone are missing, check that those calendars sync through iCloud (not \"On My iPhone\")."));
}

/** Answers an approval request from the terminal. */
async function answerApproval(id: number, verdict: "approve" | "reject"): Promise<void> {
  const d = await decide(store, approvalHandlers, id, verdict, { now: new Date(), via: "terminal" });
  if (d.status === "approved") console.log(`✅ Approved. ${d.result}`);
  else if (d.status === "rejected") console.log(verdict === "approve" ? "❌ Not done: nothing here can carry this out (is the wallet set up?)." : "❌ Rejected. Nothing was done.");
  else if (d.status === "expired") console.log("⌛ That request expired. Nothing was done.");
  else if (d.status === "already_decided") console.log(`Request ${id} was already ${d.approval?.status}.`);
  else console.log(`There's no request ${id}.`);
}

function listApprovals(): void {
  const pending = store.pendingApprovals(new Date().toISOString());
  if (!pending.length) return console.log("Nothing is waiting for your approval.");
  for (const a of pending) {
    console.log(dim(`#${a.id} · ${a.kind} · expires ${a.expiresAt.slice(11, 16)} UTC`));
    console.log(`${a.summary}\n`);
  }
  console.log(dim("npm run agent -- approve N, or reject N"));
}

async function walletCommand(): Promise<void> {
  if (rest[0] === "new") {
    const envPath = join(ROOT, ".env");
    let env = "";
    try {
      env = readFileSync(envPath, "utf8");
    } catch {
      // no .env yet: it's created below
    }
    if (/^\s*DEARBYTE_WALLET_KEY\s*=/m.test(env)) fail("There's already a DEARBYTE_WALLET_KEY in .env. Remove it first if you really want a new wallet.");
    const key = generatePrivateKey();
    // The key goes straight into .env (ignored by Git) and is never printed.
    appendFileSync(envPath, `${env && !env.endsWith("\n") ? "\n" : ""}# DearByte testnet wallet (Base Sepolia). Test funds only; never send real money here.\nDEARBYTE_WALLET_KEY=${key}\n`, { mode: 0o600 });
    chmodSync(envPath, 0o600); // only you can read the key
    console.log(`Created a testnet wallet and saved its key to .env.\nAddress: ${privateKeyToAccount(key).address}`);
    console.log("Next: get free test USDC at https://faucet.circle.com (network: Base Sepolia), and set DEARBYTE_SELLERS to the sellers you allow.");
    return;
  }
  if (!wallet) return console.log("No wallet yet: npm run agent -- wallet new");
  const w = wallet.wallet;
  console.log(`Address:  ${w.address}`);
  console.log("Network:  Base Sepolia (testnet), test USDC");
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL, { timeout: 10_000 }) });
    const balance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [w.address] });
    console.log(`Balance:  ${formatUsd(balance)} test USDC${balance === 0n ? " (get some at https://faucet.circle.com)" : ""}`);
  } catch {
    console.log("Balance:  couldn't reach Base Sepolia right now");
  }
  const today = store.paidOn(localDate(new Date(), config.timeZone));
  console.log(`Limits:   ${formatUsd(w.maxPerPurchase)} per purchase, ${formatUsd(w.maxPerDay)} per day (${formatUsd(today)} spent today)`);
  console.log(`Sellers:  ${w.sellers.length ? w.sellers.join(", ") : "none approved yet (set DEARBYTE_SELLERS)"}`);
  const recent = store.recentPurchases(5);
  if (recent.length) console.log("Recent:");
  for (const p of recent) {
    console.log(`  #${p.id} ${p.at.slice(0, 16).replace("T", " ")} ${formatUsd(BigInt(p.amount))} ${p.description} · ${p.status}${p.tx ? ` · ${EXPLORER_TX}${p.tx}` : ""}${p.error ? ` · ${p.error}` : ""}`);
  }
}

/** Shows the request in code's words and asks for a yes before anything is paid. */
async function confirmApproval(id: number, ask: (q: string) => Promise<string>): Promise<boolean> {
  const a = store.approval(id);
  if (!a || a.status !== "pending") return true; // answerApproval explains
  console.log(`\n${approvalText(a)}\n`);
  const yes = /^y(es)?$/i.test((await ask("Approve this? Type yes to confirm: ")).trim());
  if (!yes) console.log("Not approved. Nothing was done.");
  return yes;
}

/** "approve 3" / "reject 3" → the id, or null. */
function approvalId(arg: string | undefined): number | null {
  const id = Number(arg);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function main(): Promise<void> {
  if (command === "wallet") return walletCommand();
  if (command === "approvals") return listApprovals();
  if (command === "approve" || command === "reject") {
    const id = approvalId(rest[0]);
    if (id === null) fail(`Which one? npm run agent -- ${command} N (see npm run agent -- approvals)`);
    if (command === "approve") {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const yes = await confirmApproval(id, (q) => rl.question(q)).finally(() => rl.close());
      if (!yes) return;
    }
    return answerApproval(id, command);
  }
  if (command === "telegram") return telegramCommand();
  if (command === "calendar") return calendarCommand();
  if (command === "news") {
    if (loadedWatchlist && "problem" in loadedWatchlist) fail(loadedWatchlist.problem);
    return reportNews(await checkWatchlist(watchlistDeps()));
  }
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

  console.log(dim(`DearByte · ${tiers.brain.model} · ${health ? "health connected" : "no health data yet"} · /quit to leave${wallet ? ", /approve N or /reject N to answer a purchase" : ""}\n`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let messages: AgentMessage[] = [];
  /** An approval waiting for the user's "yes". */
  let confirming: number | null = null;
  rl.setPrompt("you › ");
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/quit") break;
    // Approvals are answered by code here, never passed to the model.
    if (confirming !== null) {
      const id = confirming;
      confirming = null;
      if (/^y(es)?$/i.test(line)) await answerApproval(id, "approve");
      else console.log("Not approved. Nothing was done.");
      rl.prompt();
      continue;
    }
    const answer = line.match(/^\/(approve|reject)\s+(\d+)$/);
    if (answer) {
      const id = Number(answer[2]);
      const a = store.approval(id);
      if (answer[1] === "approve" && a?.status === "pending") {
        // Show code's summary and wait for a yes on the next line.
        console.log(`\n${approvalText(a)}\n`);
        console.log("Approve this? Type yes to confirm.");
        confirming = id;
      } else {
        await answerApproval(id, answer[1] as "approve" | "reject");
      }
      rl.prompt();
      continue;
    }
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
