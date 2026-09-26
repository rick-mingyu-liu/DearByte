// The DearByte demo in one command: knows you, watches for you, spends for you.
//
//   npm run demo                 each part uses your real setup when it exists, sample data when it doesn't
//   npm run demo -- --sample     sample data everywhere (a rehearsal that never depends on the network)
//   npm run demo -- --testnet    pay on Base Sepolia for real (needs DEARBYTE_WALLET_KEY with test USDC, and SELLER_PAY_TO)
//   npm run demo -- --no-pause   don't wait for Enter between parts
//
// 1. Knows you: the morning brief from last night's sleep, heart rate and HRV against your own normal,
//    then a question the agent answers with its health tools.
// 2. Watches for you: one watchlist check. The worker screens the news, and the brain writes the message.
// 3. Spends for you: the agent proposes buying a recovery plan from the example seller. You approve
//    (here, or with the button in Telegram), it pays, and you get a receipt.
//
// Everything the demo records goes to data/demo.sqlite, recreated on each run, so your real alerts,
// news history and purchases are untouched, and the daily limits don't block a second take. Model
// spending is logged in the real usage log and counts toward the weekly cap like any other run.
// Sample data is labeled as sample on screen and in Telegram.

import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig, ROOT } from "../src/config.ts";
import { dim } from "../src/console.ts";
import { localDate, localMinutes } from "../src/companion/time.ts";
import { approvalText, decide, type ApprovalHandlers } from "../src/agent/approvals.ts";
import { runAgent, type LoopEvent } from "../src/agent/loop.ts";
import { agentSystemPrompt, withCurrentTime } from "../src/agent/persona.ts";
import { runMorningBrief, type Notify } from "../src/agent/scheduled.ts";
import { createTierModels } from "../src/agent/tiers.ts";
import { ToolRegistry } from "../src/agent/tools.ts";
import { memoryTools } from "../src/agent/toolset.ts";
import { HealthMcpClient } from "../src/health/mcp-client.ts";
import { healthTools } from "../src/health/tools.ts";
import { Store } from "../src/storage/store.ts";
import { TelegramBot } from "../src/telegram/bot.ts";
import { feedbackButtons, pollInbox, sendApproval } from "../src/telegram/inbox.ts";
import { DEFAULT_MAX_PER_DAY, DEFAULT_MAX_PER_PURCHASE, EXPLORER_TX, formatUsd, toUnits, type WalletConfig } from "../src/wallet/config.ts";
import { purchaseHandler, walletTools, type WalletDeps } from "../src/wallet/purchase.ts";
import { checkWatchlist } from "../src/watchlist/check.ts";
import { loadWatchlist, type Watchlist } from "../src/watchlist/config.ts";
import { watchlistTools } from "../src/watchlist/tools.ts";

const args = new Set(process.argv.slice(2));
const allSample = args.has("--sample");
const testnet = args.has("--testnet");
const pause = !args.has("--no-pause");
const SELLER_PORT = 4029;
const SELLER = `http://127.0.0.1:${SELLER_PORT}`;

// .env into process.env too, so SELLER_PAY_TO set there reaches the check below and the seller.
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // no .env
}
const config = loadConfig();
if ("problem" in config.agent) fail(config.agent.problem);
if (typeof config.agentPersona !== "string") fail(config.agentPersona.problem);
if (config.telegram && "problem" in config.telegram) fail(config.telegram.problem);
if (config.wallet && "problem" in config.wallet) fail(config.wallet.problem);
const myWallet = config.wallet && !("problem" in config.wallet) ? config.wallet : null;
if (testnet && !myWallet) fail("--testnet needs a wallet with test USDC: npm run agent -- wallet new, then the faucet.");
if (testnet && !/^0x[0-9a-fA-F]{40}$/.test(process.env.SELLER_PAY_TO?.trim() ?? "")) fail("--testnet needs SELLER_PAY_TO: the address the example seller gets paid at (use a second address you control).");

const realStore = Store.open(config.dbPath);
const demoPath = join(ROOT, "data/demo.sqlite");
for (const suffix of ["", "-wal", "-shm"]) rmSync(demoPath + suffix, { force: true });
const store = Store.open(demoPath);
{
  // Approval numbers start somewhere new on each run, so a tap on an earlier take's message can't answer this one.
  const db = new DatabaseSync(demoPath);
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('approvals', ?)").run(1000 + (Math.floor(Date.now() / 1000) % 900_000));
  db.close();
}
/** Where purchases and their approvals go: the demo database, or on testnet the real one, so real test spending counts toward the daily limit. */
const walletStore = testnet ? realStore : store;
/** Real memory, except in a sample run, which shows nothing of yours. */
const memoryStore = allSample ? store : realStore;
// Usage goes to the real log, so the weekly cap counts the demo too.
const models = createTierModels(config.agent, { store: realStore, weeklyCap: config.agentWeeklyCap });
const system = agentSystemPrompt(ROOT, config.agentPersona);
const telegram = config.telegram?.chatId ? { bot: new TelegramBot(config.telegram.token), chatId: config.telegram.chatId } : null;
const rl = createInterface({ input: process.stdin, output: process.stdout });
// Lines are queued, so answers typed (or piped) early aren't lost.
const lines: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let inputClosed = false;
rl.on("line", (line) => (waiting ? (waiting(line), (waiting = null)) : lines.push(line)));
rl.on("close", () => ((inputClosed = true), waiting?.(null), (waiting = null)));
/** The next line typed, or null when input ends or `signal` aborts. */
function question(q: string, signal?: AbortSignal): Promise<string | null> {
  process.stdout.write(q);
  if (process.stdin.isTTY) lines.length = 0; // keys pressed while the model was writing aren't answers
  if (lines.length) return Promise.resolve(lines.shift()!);
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiting = resolve;
    signal?.addEventListener("abort", () => {
      if (waiting === resolve) (waiting = null), resolve(null);
    });
  });
}
let seller = null as ChildProcess | null;
// readline takes Ctrl-C from the terminal, so it stops the demo here.
rl.on("SIGINT", () => {
  seller?.kill();
  console.log("\nStopped.");
  process.exit(130);
});
let spent = 0;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const describe = (e: LoopEvent) =>
  e.type === "step" ? `step ${e.n} · ${e.model} · ${(e.ms / 1000).toFixed(1)}s${e.cost === null ? "" : ` · $${e.cost.toFixed(5)}`}` : `  ${e.name} ${e.ok ? "ok" : "failed"} (${e.ms} ms)`;
const onEvent = (e: LoopEvent) => {
  if (e.type === "step" && e.cost) spent += e.cost;
  console.log(dim(describe(e)));
};

async function scene(n: number, title: string, source: string): Promise<void> {
  if (pause && n > 1) await question(dim("\nPress Enter for the next part..."));
  console.log(`\n${bold(`${n}. ${title}`)}  ${dim(source)}\n`);
}

/** Printed here, and sent to Telegram when it's set up; sample data says so in the title. */
function notifier(sample: boolean): Notify {
  return async (title, body, o = {}) => {
    const heading = sample ? `${title} (demo, sample data)` : title;
    console.log(`── ${heading} ──\n${body}\n`);
    if (!telegram) return true;
    try {
      await telegram.bot.send(telegram.chatId, `${heading}\n\n${body}`, o.alertId ? feedbackButtons(o.alertId) : []);
      console.log(dim("sent to Telegram"));
    } catch (err) {
      console.log(dim(`Telegram failed: ${(err as Error).message}`));
    }
    return true;
  };
}

async function ask(tools: ToolRegistry, question: string, purpose: string): Promise<void> {
  console.log(`${bold("you ›")} ${question}\n`);
  const result = await runAgent({
    model: models.brain,
    tools,
    system,
    messages: [{ role: "user", content: withCurrentTime(question, new Date(), config.timeZone) }],
    purpose,
    onEvent,
  });
  console.log(`\n${result.text || dim(`(no answer: ${result.stop})`)}\n`);
}

// ---- 1. Knows you ----

/** `hour`:00 on `date` in the user's time zone. */
function atLocal(date: string, hour: number): Date {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const shown = Date.parse(`${localDate(new Date(guess), config.timeZone)}T00:00:00Z`) + localMinutes(new Date(guess), config.timeZone) * 60_000;
  return new Date(guess - (shown - guess));
}

/**
 * A stand-in for dearbyte-bridge with a week of made-up data: a normal week of about 7 hours,
 * then a short night (5h10m) with resting heart rate up and HRV down.
 */
function sampleBridge(now: Date): Pick<HealthMcpClient, "callTool"> {
  const today = localDate(new Date(now.getTime() - 6 * 3_600_000), config.timeZone); // the day last night belongs to
  const day = (back: number) => new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  const wake = (back: number) => {
    const t = atLocal(day(back), 7).getTime();
    return back === 0 ? Math.min(t, now.getTime() - 5 * 60_000) : t;
  };
  const minutes = [310, 425, 410, 440, 420, 435, 415];
  const sleep = minutes.map((m, back) => ({
    value: m,
    stage: "asleep_core",
    started_at: new Date(wake(back) - (m + 15) * 60_000).toISOString(),
    sampled_at: new Date(wake(back)).toISOString(),
    source_device: "Apple Watch",
  }));
  const readings = (values: number[]) => values.map((value, back) => ({ value, sampled_at: new Date(wake(back) + 10 * 60_000).toISOString() }));
  const history: Record<string, unknown[]> = { sleep, resting_heart_rate: readings([64, 57, 56, 55]), hrv_sdnn: readings([31, 48, 46, 50]) };
  return {
    callTool: async (name, a = {}) =>
      name === "watch_get_health_history"
        ? { history: { [String(a.metric)]: history[String(a.metric)] ?? [] } }
        : { uploaded_at: new Date(now.getTime() - 20 * 60_000).toISOString(), metrics: { resting_heart_rate: history.resting_heart_rate[0], hrv_sdnn: history.hrv_sdnn[0] } },
  };
}

const healthLive = !allSample && Boolean(config.healthMcpUrl);
const bridge = healthLive ? new HealthMcpClient(config.healthMcpUrl!) : sampleBridge(new Date());

async function knowsYou(): Promise<void> {
  const live = healthLive;
  await scene(1, "Knows you", live ? "your Apple Watch, through dearbyte-bridge" : "SAMPLE health data (set HEALTH_MCP_URL for yours)");
  const tools = new ToolRegistry([...memoryTools(memoryStore, config.timeZone), ...healthTools(bridge, { timeZone: config.timeZone })]);
  console.log(dim("The morning brief: rules in code compare last night with your normal; the brain writes the words.\n"));
  const brief = await runMorningBrief({ bridge, store, model: models.brain, tools, system, timeZone: config.timeZone, notify: notifier(!live), onEvent }, { force: true });
  if (!brief.sent) console.log(dim(`No brief: ${brief.reason}`));
  else if (brief.triggers.length) console.log(dim(`Rules that fired: ${brief.triggers.map((t) => t.detail).join("; ")}`));
  console.log();
  await ask(tools, "I have leg day planned tonight. Should I still go?", "demo");
}

// ---- 2. Watches for you ----

const SAMPLE_FEED = "https://example.com/northwind/newsroom.rss";

/** A made-up company's newsroom: two items worth a message, two that aren't. */
function sampleFetch(now: Date): typeof fetch {
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toUTCString();
  const items = [
    ["atlas-2", "Northwind AI releases Atlas-2, an open model for on-device agents", "The model runs on a phone and is free for research and commercial use.", 2],
    ["cfo", "Northwind AI names a new Chief Financial Officer", "The former CFO of a cloud company joins on October 1.", 5],
    ["meetup", "Recap: highlights from the Northwind community meetup", "Photos and talks from last week's meetup.", 8],
    ["tips", "Five tips for getting more out of Northwind Notes", "Keyboard shortcuts and templates.", 20],
  ] as const;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Northwind AI newsroom (sample)</title>${items
    .map(([id, title, text, h]) => `<item><title>${title}</title><link>https://example.com/northwind/${id}</link><guid>northwind-${id}</guid><pubDate>${ago(h)}</pubDate><description>${text}</description></item>`)
    .join("")}</channel></rss>`;
  return (async (url: string | URL | Request) =>
    String(url) === SAMPLE_FEED ? new Response(xml, { headers: { "content-type": "application/rss+xml" } }) : new Response("not found", { status: 404 })) as typeof fetch;
}

async function watchesForYou(): Promise<Watchlist | null> {
  const loaded = loadWatchlist(config.watchlistPath);
  const mine = loaded && !("problem" in loaded) ? loaded : null;
  const live = !allSample && mine;
  await scene(2, "Watches for you", live ? `official news for ${mine.companies.map((c) => c.name).join(", ")}` : "a SAMPLE newsroom for a made-up company (add watchlist.json for yours)");
  const watchlist: Watchlist = live
    ? mine
    : {
        interests: mine?.interests ?? "Tell me about AI model launches, leadership changes, earnings and big legal news. Skip marketing, event recaps and small feature tips.",
        companies: [{ name: "Northwind AI", feeds: [SAMPLE_FEED] }],
      };
  console.log(dim(`What you care about: ${watchlist.interests}\n`));
  const tools = new ToolRegistry(watchlistTools(store, watchlist));
  const o = await checkWatchlist({
    store,
    model: models.brain,
    worker: models.worker,
    tools,
    system,
    timeZone: config.timeZone,
    notify: notifier(!live),
    watchlist,
    secContact: live ? config.secContact : null,
    onEvent,
    ...(live ? {} : { fetch: sampleFetch(new Date()) }),
  });
  for (const e of o.errors) console.log(dim(`source failed: ${e}`));
  console.log(dim(`${o.added} items found, ${o.screened} screened by the worker, ${o.relevant} worth a message`));
  for (const i of store.recentWatchItems(new Date(Date.now() - 7 * 86_400_000).toISOString())) {
    if (i.status === "relevant" || i.status === "skipped" || i.status === "sent") console.log(dim(`  ${i.status === "skipped" ? "skip" : "keep"} · ${i.title}${i.reason ? ` · ${i.reason}` : ""}`));
  }
  if (o.message && !o.message.sent) console.log(dim(`No message: ${o.message.reason}${o.message.reason === "quiet hours" ? " (DearByte stays quiet 23:00-07:00)" : ""}`));
  if (live && !o.screened) console.log(dim("Nothing from the last 48 hours to screen. npm run demo -- --sample shows the flow with a sample newsroom."));
  return watchlist;
}

// ---- 3. Spends for you ----

async function startSeller(): Promise<void> {
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["examples/seller/server.ts", ...(testnet ? [] : ["--dev"])], {
    cwd: ROOT,
    env: { ...process.env, SELLER_PORT: String(SELLER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  seller = child;
  let errors = "";
  child.stderr!.on("data", (b) => (errors += String(b)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the example seller didn't start within 20 seconds")), 20_000);
    child.stdout!.on("data", (b) => {
      if (String(b).includes("Example seller on")) (clearTimeout(timer), resolve());
    });
    child.once("exit", (code) => (clearTimeout(timer), reject(new Error(`the example seller stopped (${code}): ${errors.trim().slice(0, 300)}`))));
  });
  child.stdout!.on("data", (b) => {
    for (const line of String(b).trim().split("\n")) console.log(dim(`seller: ${line}`));
  });
}

/** Waits for the user's answer here, or for a tap in Telegram, whichever comes first. */
async function answer(id: number, handlers: ApprovalHandlers): Promise<void> {
  const stop = new AbortController();
  const listening = telegram ? pollInbox({ ...telegram, store: walletStore, handlers }, { signal: stop.signal, log: (line) => console.log(dim(`telegram: ${line}`)) }) : null;
  const tapped = (async () => {
    while (!stop.signal.aborted && walletStore.approval(id)?.status === "pending") await new Promise((r) => setTimeout(r, 500));
  })();
  const typed = (async () => {
    for (;;) {
      const line = await question(telegram ? "Type yes to approve or no to reject, or tap a button in Telegram: " : "Type yes to approve or no to reject: ", stop.signal);
      if (line === null || line.trim()) return line;
    }
  })();
  const line = await Promise.race([typed, tapped.then(() => null)]);
  stop.abort();
  await Promise.all([tapped, listening]);
  console.log();
  if (line === null) {
    if (walletStore.approval(id)?.status !== "pending") return; // answered in Telegram; the handler already ran
    await decide(walletStore, handlers, id, "reject", { now: new Date(), via: "terminal" });
    return console.log("No answer, so nothing was paid.");
  }
  const d = await decide(walletStore, handlers, id, /^y(es)?$/i.test(line.trim()) ? "approve" : "reject", { now: new Date(), via: "terminal" });
  if (d.status === "approved") console.log(`✅ ${d.result}`);
  else if (d.status === "rejected") console.log("❌ Rejected. Nothing was paid.");
  else if (d.status === "already_decided") console.log(`Already answered in Telegram: ${d.approval?.status}.`);
  else console.log(`Nothing done (${d.status}).`);
}

async function spendsForYou(): Promise<void> {
  const key = testnet && myWallet ? myWallet.key : generatePrivateKey();
  await scene(3, "Spends for you", `${testnet ? "your testnet wallet, paying on Base Sepolia" : "the example seller in dev mode: the payment is signed and checked, nothing moves on chain"}${healthLive ? "" : " · SAMPLE health data"}`);
  await startSeller();
  const wallet: WalletConfig = {
    key,
    address: privateKeyToAccount(key).address,
    sellers: [SELLER],
    maxPerPurchase: myWallet?.maxPerPurchase ?? toUnits(DEFAULT_MAX_PER_PURCHASE)!,
    maxPerDay: myWallet?.maxPerDay ?? toUnits(DEFAULT_MAX_PER_DAY)!,
  };
  console.log(dim(`Limits, enforced in code: ${formatUsd(wallet.maxPerPurchase)} per purchase, ${formatUsd(wallet.maxPerDay)} per day, only from ${SELLER}.\n`));
  let proposed: number | null = null;
  const deps: WalletDeps = {
    wallet,
    store: walletStore,
    timeZone: config.timeZone,
    sendApproval: telegram ? async (a) => (await sendApproval(telegram.bot, telegram.chatId, a), true) : undefined,
    announce: (a) => {
      proposed = a.id;
      console.log(dim(`\n── Approval #${a.id}, written by code, not the model ──`));
      console.log(`${approvalText(a)}\n`);
    },
  };
  const handlers: ApprovalHandlers = { purchase: purchaseHandler(deps) };
  const tools = new ToolRegistry([...memoryTools(memoryStore, config.timeZone), ...healthTools(bridge, { timeZone: config.timeZone }), ...walletTools(deps)]);
  await ask(tools, `Rough night and a long day ahead. Can you get me the recovery plan from ${SELLER}/recovery-plan?`, "demo");
  if (proposed === null) return console.log(dim("The agent didn't propose a purchase this time, so there's nothing to approve."));
  await answer(proposed, handlers);
  const [receipt] = walletStore.recentPurchases(1);
  if (!receipt) return;
  console.log(dim(`\nReceipt #${receipt.id}: ${formatUsd(BigInt(receipt.amount))} · ${receipt.status}${receipt.tx ? ` · ${EXPLORER_TX}${receipt.tx}` : ""}${receipt.error ? ` · ${receipt.error}` : ""}\n`));
  if (receipt.result) await ask(tools, "What did you buy me, and what should I do with it?", "demo");
}

try {
  console.log(bold("DearByte demo"));
  console.log(dim(`brain ${config.agent.brain.model} · worker ${config.agent.worker.model} · ${telegram ? "Telegram on" : "Telegram off"} · records to data/demo.sqlite`));
  if (telegram) {
    // Taps left over from earlier takes are dropped, not applied to this run.
    const backlog = await telegram.bot.updates(0, 0);
    if (backlog.length) await telegram.bot.updates(backlog[backlog.length - 1].update_id + 1, 0);
    console.log(dim("Telegram: stop npm run agent -- watch while the demo runs, or both will answer the same taps."));
  }
  await knowsYou();
  await watchesForYou();
  await spendsForYou();
  console.log(dim(`\nDone. Model cost for this run: $${spent.toFixed(4)}.`));
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("The model API key was rejected.");
  else if (err instanceof Anthropic.APIError) console.error(`Model API error ${err.status}: ${err.message}`);
  else console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  seller?.kill();
  rl.close();
  store.close();
  realStore.close();
}
