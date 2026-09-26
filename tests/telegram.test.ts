import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { APPROVAL_TTL_MS, decide, proposeApproval } from "../src/agent/approvals.ts";
import { FakeAgentModel } from "../src/agent/fake.ts";
import type { AgentModel } from "../src/agent/model.ts";
import { CAP_NOTICE, runCautionCheck, type ScheduledDeps } from "../src/agent/scheduled.ts";
import { ToolRegistry } from "../src/agent/tools.ts";
import { WeeklyCapReached } from "../src/agent/usage.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/storage/store.ts";
import { fitText, MAX_TEXT, TelegramBot, TelegramError, type Update } from "../src/telegram/bot.ts";
import { handleUpdate, pollInbox, type InboxDeps } from "../src/telegram/inbox.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const ME = 4242;
const T0 = new Date("2026-09-26T09:00:00-04:00");

// ---- The API client ----

function fakeApi(answers: Array<Record<string, unknown> | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const a = answers.shift() ?? { ok: true, result: true };
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a), { status: a.ok ? 200 : Number(a.error_code ?? 400) });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("bot: sends plain text with buttons and returns the message id", async () => {
  const api = fakeApi([{ ok: true, result: { message_id: 7, chat: { id: ME } } }]);
  const id = await new TelegramBot(TOKEN, { fetch: api.fetch }).send(ME, "hello", [{ text: "Yes", data: "ap:1:y" }]);
  expect(id).toBe(7);
  expect(api.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(api.calls[0].body).toMatchObject({ chat_id: ME, text: "hello", reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "ap:1:y" }]] } });
  expect(api.calls[0].body).not.toHaveProperty("parse_mode");
  expect(fitText("x".repeat(MAX_TEXT + 10))).toHaveLength(MAX_TEXT);
});

test("bot: errors explain the problem and never contain the token", async () => {
  const bot = (a: Record<string, unknown> | Error) => new TelegramBot(TOKEN, { fetch: fakeApi([a]).fetch });
  const failure = (p: Promise<unknown>) => p.then(() => null, (e) => e as TelegramError);

  const rejected = await failure(bot({ ok: false, error_code: 401, description: "Unauthorized" }).send(ME, "x"));
  expect(rejected?.message).toBe("Telegram sendMessage: the bot token was rejected (check TELEGRAM_BOT_TOKEN)");
  const busy = await failure(bot({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }).send(ME, "x"));
  expect(busy).toMatchObject({ code: 429, retryAfter: 3 });
  const leaky = await failure(bot({ ok: false, error_code: 400, description: `bad request for ${TOKEN}` }).send(ME, "x"));
  expect(leaky?.message).not.toContain(TOKEN);
  const offline = await failure(bot(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`)).send(ME, "x"));
  expect(offline?.message).toBe("Telegram sendMessage could not connect");
  await expect(new TelegramBot(TOKEN).send(ME, "x", [{ text: "x", data: "d".repeat(65) }])).rejects.toThrow("64 bytes");
});

// ---- Approvals ----

test("approvals: decided once, only in time, and only for a kind that can run", async () => {
  const store = Store.open(":memory:");
  const ran: number[] = [];
  const handlers = { test: async (a: { id: number }) => (ran.push(a.id), "done") };
  const via = { now: T0, via: "test" };

  const a = proposeApproval(store, { kind: "test", summary: "Buy a thing", payload: { usd: 1 } }, T0);
  expect(a).toMatchObject({ status: "pending", payload: { usd: 1 }, expiresAt: new Date(T0.getTime() + APPROVAL_TTL_MS).toISOString() });
  expect(await decide(store, handlers, a.id, "approve", via)).toMatchObject({ status: "approved", result: "done" });
  expect(await decide(store, handlers, a.id, "approve", via)).toMatchObject({ status: "already_decided" });
  expect(ran).toEqual([a.id]); // a double tap runs it once

  const late = proposeApproval(store, { kind: "test", summary: "late", payload: null }, T0);
  expect(await decide(store, handlers, late.id, "approve", { now: new Date(T0.getTime() + APPROVAL_TTL_MS), via: "test" })).toMatchObject({ status: "expired" });
  expect(store.approval(late.id)?.status).toBe("pending");

  const unknown = proposeApproval(store, { kind: "purchase", summary: "no handler yet", payload: null }, T0);
  expect(await decide(store, handlers, unknown.id, "approve", via)).toMatchObject({ status: "rejected" });
  expect(await decide(store, handlers, 999, "approve", via)).toMatchObject({ status: "unknown" });
  expect(ran).toHaveLength(1);

  const failing = proposeApproval(store, { kind: "boom", summary: "x", payload: null }, T0);
  const d = await decide(store, { boom: async () => Promise.reject(new Error("seller down")) }, failing.id, "approve", via);
  expect(d).toMatchObject({ status: "approved", result: "It was approved, but the action failed: seller down" });
});

// ---- The inbox ----

function fakeBot() {
  const log: string[] = [];
  return {
    log,
    bot: {
      send: async (chat: number, text: string) => (log.push(`send ${chat}: ${text}`), 1),
      answerCallback: async (_id: string, text?: string) => void log.push(`answer: ${text}`),
      replaceText: async (_c: number, m: number, text: string) => void log.push(`edit ${m}: ${text}`),
      removeButtons: async (_c: number, m: number) => void log.push(`unbutton ${m}`),
    },
  };
}

const tap = (data: string, from = ME, update_id = 1): Update => ({
  update_id,
  callback_query: { id: `q${update_id}`, from: { id: from }, data, message: { message_id: 50, chat: { id: from }, text: "old" } },
});

function inbox() {
  const store = Store.open(":memory:");
  const { bot, log } = fakeBot();
  const d: InboxDeps = { bot, chatId: ME, store, handlers: { test: async () => "Test done." }, now: () => T0 };
  return { d, store, log };
}

test("inbox: approve and reject buttons decide the approval and show the outcome", async () => {
  const { d, store, log } = inbox();
  const a = proposeApproval(store, { kind: "test", summary: "Buy coffee, $4", payload: null }, T0);
  expect(await handleUpdate(d, tap(`ap:${a.id}:y`))).toBe(`approval ${a.id}: approved`);
  expect(log).toContain("answer: Working on it…");
  expect(log.find((l) => l.startsWith("edit 50"))).toContain("Buy coffee, $4");
  expect(store.approval(a.id)).toMatchObject({ status: "approved", decidedVia: "telegram" });

  const b = proposeApproval(store, { kind: "test", summary: "Buy tea", payload: null }, T0);
  expect(await handleUpdate(d, tap(`ap:${b.id}:n`))).toBe(`approval ${b.id}: rejected`);
  expect(log.at(-1)).toContain("❌ Rejected. Nothing was done.");

  // A second tap on an already-decided request says so as a message; nothing runs again.
  expect(await handleUpdate(d, tap(`ap:${a.id}:y`))).toBe(`approval ${a.id}: already_decided`);
  expect(log.at(-1)).toBe(`send ${ME}: Already approved.`);
});

test("inbox: a failing tap answer doesn't stop the approval, and a failed edit still tells the user", async () => {
  const { d, store, log } = inbox();
  d.bot.answerCallback = async () => Promise.reject(new Error("query is too old"));
  d.bot.replaceText = async () => Promise.reject(new Error("message can't be edited"));
  const a = proposeApproval(store, { kind: "test", summary: "x", payload: null }, T0);
  expect(await handleUpdate(d, tap(`ap:${a.id}:y`))).toBe(`approval ${a.id}: approved`);
  expect(log).toEqual([`send ${ME}: ✅ Approved. Test done.`]);
});

test("poll loop: a rejected token stops it instead of retrying forever", async () => {
  const { d } = inbox();
  const lines: string[] = [];
  const bot = { ...d.bot, updates: async () => Promise.reject(new TelegramError("Telegram getUpdates: the bot token was rejected", 401)) };
  await pollInbox({ ...d, bot }, { signal: new AbortController().signal, log: (l) => lines.push(l) });
  expect(lines).toEqual(["Telegram getUpdates: the bot token was rejected; stopped listening to Telegram"]);
});

test("inbox: only the user's chat counts", async () => {
  const { d, store, log } = inbox();
  const a = proposeApproval(store, { kind: "test", summary: "x", payload: null }, T0);
  expect(await handleUpdate(d, tap(`ap:${a.id}:y`, 999))).toBe("ignored a button from another chat");
  expect(await handleUpdate(d, { update_id: 2, message: { message_id: 3, chat: { id: 999 }, text: "hi" } })).toBe("ignored a message from another chat");
  expect(log).toEqual([]); // no reply at all to strangers
  expect(store.approval(a.id)?.status).toBe("pending");

  await handleUpdate(d, { update_id: 3, message: { message_id: 4, chat: { id: ME }, text: "hi" } });
  expect(log[0]).toContain("npm run agent -- chat");
});

test("inbox: feedback buttons rate the alert; bad buttons are answered, not trusted", async () => {
  const { d, store, log } = inbox();
  const id = store.recordAlert({ at: T0.toISOString(), date: "2026-09-26", kind: "caution", triggers: ["short_sleep"], text: "x", delivered: true });
  expect(await handleUpdate(d, tap(`fb:${id}:n`))).toBe(`alert ${id} marked noise`);
  expect(log).toContain("unbutton 50");
  expect(store.alertsOn("2026-09-26")[0].feedback).toBe("noise");
  expect(store.alertFeedback("2026-09-20")).toEqual({ sent: 1, useful: 0, noise: 1 });

  expect(await handleUpdate(d, tap("ap:abc:y"))).toBe("ignored a malformed button");
  expect(await handleUpdate(d, tap("zz:1:y"))).toBe("ignored an unknown button");
});

test("poll loop: advances the offset, survives a failed call and a failing update", async () => {
  const { d } = inbox();
  const offsets: number[] = [];
  const stop = new AbortController();
  const lines: string[] = [];
  let call = 0;
  const bot = {
    ...d.bot,
    updates: async (offset: number) => {
      offsets.push(offset);
      call++;
      if (call === 1) throw new TelegramError("Telegram getUpdates: busy", 429, 0.001);
      if (call === 2) return [tap("fb:1:u", ME, 10), { update_id: 11, message: { message_id: 1, chat: { id: ME } } }];
      stop.abort();
      return [];
    },
    send: async () => Promise.reject(new Error("network")),
  };
  await pollInbox({ ...d, bot }, { signal: stop.signal, log: (l) => lines.push(l) });
  expect(offsets).toEqual([0, 0, 12, 12]); // the last call confirms what was handled
  expect(lines).toEqual(["Telegram getUpdates: busy; retrying in 0s", "feedback for unknown alert 1", "telegram update 11 failed: network"]);
});

// ---- Scheduled messages and the weekly cap ----

test("weekly cap: a fixed notice once a day instead of silence", async () => {
  const store = Store.open(":memory:");
  const sent: Array<{ body: string; alertId?: number }> = [];
  const capped: AgentModel = {
    name: "capped",
    step: async () => {
      throw new WeeklyCapReached("over");
    },
    cost: () => 0,
  };
  const d: ScheduledDeps = {
    bridge: { callTool: async () => ({ history: { sleep: [{ value: 200, stage: "asleep_core", started_at: "2026-09-26T03:00:00Z", sampled_at: "2026-09-26T10:00:00Z", source_device: "watch" }] } }) },
    store,
    model: capped,
    tools: new ToolRegistry([]),
    system: "s",
    timeZone: "America/Toronto",
    notify: async (_t, body, o) => (sent.push({ body, alertId: o?.alertId }), true),
    now: () => T0,
  };
  expect(await runCautionCheck(d)).toMatchObject({ sent: true, kind: "notice" });
  expect(sent).toEqual([{ body: CAP_NOTICE, alertId: undefined }]); // no rating buttons on a notice
  expect(await runCautionCheck(d)).toMatchObject({ sent: false, reason: "weekly spending cap reached" });
  expect(sent).toHaveLength(1);

  // A model that writes normally passes its alert id to the channel, for the feedback buttons.
  d.model = new FakeAgentModel([FakeAgentModel.text("Go easy.")]);
  const store2 = Store.open(":memory:");
  await runCautionCheck({ ...d, store: store2 });
  expect(sent[1].alertId).toBe(store2.alertsOn("2026-09-26")[0].id);
});

// ---- Setup and storage ----

test("config: Telegram needs a real-looking token and a numeric chat id", () => {
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }).telegram).toBeNull();
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "" }).telegram).toEqual({ token: TOKEN, chatId: null });
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "4242" }).telegram).toEqual({ token: TOKEN, chatId: 4242 });
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: "nope", TELEGRAM_CHAT_ID: "" }).telegram).toHaveProperty("problem");
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "@me" }).telegram).toHaveProperty("problem");
  expect(loadConfig({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "4242" }).telegram).toHaveProperty("problem");
});

test("store: an agent_alerts table from before feedback gets the column", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dearbyte-")), "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE agent_alerts (id INTEGER PRIMARY KEY, at TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, triggers TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)");
  old.exec(`INSERT INTO agent_alerts (at, date, kind, triggers, text) VALUES ('${T0.toISOString()}', '2026-09-26', 'caution', '[]', 'x')`);
  old.close();
  const store = Store.open(path);
  expect(store.setAlertFeedback(1, "useful")).toBe(true);
  expect(store.recentAlerts(1)[0]).toMatchObject({ text: "x", feedback: "useful" });
  store.close();
});
