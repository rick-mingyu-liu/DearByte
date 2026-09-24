import { expect, test } from "vitest";
import { ReplyLoop } from "../src/channels/reply-loop.ts";
import { Companion } from "../src/companion/companion.ts";
import { dayState, planProactive, type ProactiveState } from "../src/companion/proactive.ts";
import { buildMessages, loadPromptParts, QUIET_GAP } from "../src/companion/prompt.ts";
import { ROOT } from "../src/config.ts";
import type { Fact, StoredMessage } from "../src/domain.ts";
import { FakeModel } from "../src/model/fake.ts";
import { Store } from "../src/storage/store.ts";

const TZ = "Asia/Shanghai";
/** A Shanghai wall-clock time on 2026-09-24 (UTC+8). */
const at = (hhmm: string, day = "2026-09-24") => new Date(`${day}T${hhmm}:00+08:00`);
const msg = (role: "user" | "assistant", when: Date, text = "hi"): StoredMessage => ({
  id: 0, role, text, bubbles: role === "assistant" ? [text] : null, hasImage: false, createdAt: when.toISOString(),
});
const state = (over: Partial<ProactiveState> = {}): ProactiveState => ({ date: "2026-09-24", morningAt: null, sent: [], lastAt: null, ...over });
const exam: Fact = {
  id: 1, category: "event", key: "ielts_exam", value: "用户考雅思", eventDate: "2026-09-24", evidence: "我周四考雅思",
  sourceMessageId: null, createdAt: "", updatedAt: "",
};
const yesterday = [msg("user", at("21:00", "2026-09-23")), msg("assistant", at("21:00", "2026-09-23"))];
const plan = (now: Date, over: Partial<Parameters<typeof planProactive>[0]> = {}) =>
  planProactive({ now, timeZone: TZ, state: state(), history: yesterday, facts: [], ...over });

test("good morning at today's random time, only if not talked yet today", () => {
  const s = state({ morningAt: 8 * 60 + 20 });
  expect(plan(at("08:10"), { state: s })).toBeNull();
  expect(plan(at("08:25"), { state: s })?.key).toBe("morning");
  expect(plan(at("09:30"), { state: s })).toBeNull(); // missed by more than an hour
  expect(plan(at("08:25"), { state: state({ morningAt: 500, sent: ["morning"] }) })).toBeNull();
  const talked = [msg("user", at("06:00")), msg("assistant", at("06:00"))];
  expect(plan(at("08:25"), { state: s, history: talked })).toBeNull();
});

test("an event today gets luck in the morning and a follow-up in the evening", () => {
  expect(plan(at("09:00"), { facts: [exam] })).toMatchObject({ key: "event_am:ielts_exam" });
  expect(plan(at("09:00"), { facts: [exam] })?.note).toContain("用户考雅思");
  expect(plan(at("20:00"), { facts: [exam] })).toMatchObject({ key: "event_pm:ielts_exam" });
  expect(plan(at("20:00"), { facts: [{ ...exam, eventDate: "2026-09-25" }], state: state({ sent: ["checkin"] }) })).toBeNull();
  // An event day replaces the good morning.
  expect(plan(at("08:25"), { facts: [exam], state: state({ morningAt: 500 }) })).toBeNull();
});

test("checks in after a long silence, in the afternoon", () => {
  const old = [msg("user", at("10:00", "2026-09-22")), msg("assistant", at("10:00", "2026-09-22"))];
  expect(plan(at("14:00"), { history: old })?.note).toContain("2天");
  expect(plan(at("10:00"), { history: old })).toBeNull();
  expect(plan(at("14:00"))).toBeNull(); // only 17 hours
});

test("never at night, over the daily cap, right after a chat, or after an unanswered nudge", () => {
  const facts = [exam];
  expect(plan(at("07:30"), { facts })).toBeNull();
  expect(plan(at("23:00"), { facts })).toBeNull();
  expect(plan(at("09:00"), { facts, state: state({ sent: ["a", "b"] }) })).toBeNull();
  expect(plan(at("09:00"), { facts, history: [msg("user", at("08:00"))] })).toBeNull();
  const unanswered = state({ lastAt: at("22:00", "2026-09-23").toISOString() });
  expect(plan(at("09:00"), { facts, state: unanswered })).toBeNull();
  expect(plan(at("09:00"), { facts: [], history: [] })).toBeNull(); // never talked
});

test("a new day starts fresh but remembers the last nudge", () => {
  const old = state({ date: "2026-09-23", sent: ["morning"], lastAt: "x" });
  const next = dayState(old, "2026-09-24", () => 0.1);
  expect(next).toEqual({ date: "2026-09-24", morningAt: 8 * 60 + 9, thinkingAt: 13 * 60 + 42, sent: [], lastAt: "x" });
  expect(dayState(next, "2026-09-24", () => 0.9)).toBe(next);
  expect(dayState(null, "2026-09-24", () => 0.9).morningAt).toBeNull();
  expect(dayState(null, "2026-09-24", () => 0.9).thinkingAt).toBeNull();
});

test("initiate stores only 小拜's message, and history marks the user's silence", async () => {
  const store = Store.open(":memory:");
  const model = new FakeModel([JSON.stringify({ bubbles: ["早啊臭宝", "吃了没", "今天忙啥"] })]);
  const companion = new Companion({ store, model, parts: loadPromptParts(ROOT), timeZone: TZ, historyMessages: 40, now: () => at("08:30") });
  store.addMessage("user", "晚安", { createdAt: at("23:00", "2026-09-23").toISOString() });
  store.addMessage("assistant", "晚安", { bubbles: ["晚安"], createdAt: at("23:00", "2026-09-23").toISOString() });

  expect((await companion.initiate("早上打个招呼")).bubbles).toEqual(["早啊臭宝", "吃了没"]);
  expect(String(model.calls[0].messages.at(-1)?.content)).toContain("主动找用户");
  expect(store.recentMessages(10).map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);

  const next = buildMessages("sys", store.recentMessages(10), { text: "早" });
  expect(next.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
  expect(next[3].content).toBe(QUIET_GAP);
});

test("the loop won't write first mid-reply, and answers messages that arrive meanwhile", async () => {
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = Store.open(":memory:");
  const companion = new Companion({ store, model: new FakeModel([JSON.stringify({ bubbles: ["回你"] })]), parts: loadPromptParts(ROOT), timeZone: TZ, historyMessages: 40 });
  const loop = new ReplyLoop<{ text: string; image: null }>({
    companion,
    sleep: async () => {},
    outlet: { merge: (b) => b.at(-1)!, loadImage: async () => new Uint8Array(), sendBubble: async (_m, b) => (sent.push(b), "sent") },
  });

  const first = loop.initiate("morning", async () => (await gate, ["早"]));
  expect(first).not.toBe(false);
  expect(loop.initiate("again", async () => ["不该发"])).toBe(false);
  loop.push([{ text: "在", image: null }]);
  release();
  await first;
  await loop.settle();
  expect(sent).toEqual(["早", "回你"]);
  expect(loop.initiate("queued", async () => ["x"])).not.toBe(false);
});

test("thinks of the user some afternoons, after a few quiet hours", () => {
  const s = state({ thinkingAt: 15 * 60 });
  const morning = [msg("user", at("10:00")), msg("assistant", at("10:00"))];
  expect(plan(at("14:59"), { state: s, history: morning })).toBeNull();
  expect(plan(at("15:30"), { state: s, history: morning })?.key).toBe("thinking");
  expect(plan(at("17:01"), { state: s, history: morning })).toBeNull(); // window passed
  const recent = [msg("user", at("13:00")), msg("assistant", at("13:00"))];
  expect(plan(at("15:30"), { state: s, history: recent })).toBeNull(); // only 2.5 quiet hours
  expect(plan(at("15:30"), { state: state({ thinkingAt: 900, sent: ["thinking"] }), history: morning })).toBeNull();
  expect(plan(at("15:30"), { state: state(), history: morning })).toBeNull(); // not today
});

test("after the user asks for space, 小拜 doesn't write first for three days", () => {
  const old = [msg("user", at("10:00", "2026-09-22"), "我想自己待一会儿，别给我发消息了"), msg("assistant", at("10:00", "2026-09-22"))];
  expect(plan(at("14:00"), { history: old })).toBeNull(); // would otherwise be a check-in
  expect(plan(at("14:00", "2026-09-25"), { history: old })?.key).toBe("checkin");
  for (const text of ["让我静静", "别烦我了", "今天不想聊", "别理我"]) {
    expect(plan(at("14:00"), { history: [msg("user", at("10:00", "2026-09-22"), text)] })).toBeNull();
  }
  expect(plan(at("14:00"), { history: [msg("user", at("10:00", "2026-09-22"), "别忘了明天考试")] })?.key).toBe("checkin");
});
