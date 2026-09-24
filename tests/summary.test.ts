import { expect, test } from "vitest";
import { buildSystemPrompt, loadPromptParts } from "../src/companion/prompt.ts";
import { ROOT } from "../src/config.ts";
import { SUMMARY_SETTING, SUMMARY_UPTO_SETTING, updateSummary } from "../src/memory/summary.ts";
import { FakeModel } from "../src/model/fake.ts";
import { Store } from "../src/storage/store.ts";

const summaryOf = (s: string) => JSON.stringify({ summary: s });

function withMessages(n: number) {
  const store = Store.open(":memory:");
  for (let i = 1; i <= n; i++) store.addMessage(i % 2 ? "user" : "assistant", `消息${i}`, i % 2 ? {} : { bubbles: [`消息${i}`] });
  return store;
}

test("folds messages once enough have left the window, and only those", async () => {
  const store = withMessages(49); // window 40 → 9 aged out: not yet
  const model = new FakeModel([summaryOf("用户聊了消息1到10")]);
  expect(await updateSummary({ model, store, window: 40, timeZone: "UTC" })).toBeNull();
  expect(model.calls).toHaveLength(0);

  store.addMessage("user", "消息50"); // 10 aged out
  expect(await updateSummary({ model, store, window: 40, timeZone: "UTC" })).toEqual({ folded: 10, chars: 10 });
  const input = String(model.calls[0].messages[1].content);
  expect(input).toContain("用户：消息1");
  expect(input).toContain("你：消息10");
  expect(input).not.toContain("消息11");
  expect(store.getSetting(SUMMARY_SETTING)).toBe("用户聊了消息1到10");
  expect(store.getSetting(SUMMARY_UPTO_SETTING)).toBe("10");

  // The next fold starts where the last one ended and includes the old summary.
  for (let i = 51; i <= 60; i++) store.addMessage("user", `消息${i}`);
  const next = new FakeModel([summaryOf("更新后的备忘")]);
  expect(await updateSummary({ model: next, store, window: 40, timeZone: "UTC" })).toEqual({ folded: 10, chars: 6 });
  const second = String(next.calls[0].messages[1].content);
  expect(second).toContain("旧的备忘：用户聊了消息1到10");
  expect(second).toContain("消息11");
  expect(second).not.toContain("消息10\n");
});

test("unusable output keeps the old summary and position", async () => {
  const store = withMessages(50);
  store.setSettings({ [SUMMARY_SETTING]: "旧的", [SUMMARY_UPTO_SETTING]: "0" });
  expect(await updateSummary({ model: new FakeModel(["not json"]), store, window: 40, timeZone: "UTC" })).toBeNull();
  expect(await updateSummary({ model: new FakeModel([summaryOf("")]), store, window: 40, timeZone: "UTC" })).toBeNull();
  expect(store.getSetting(SUMMARY_SETTING)).toBe("旧的");
  expect(store.getSetting(SUMMARY_UPTO_SETTING)).toBe("0");
});

test("a long summary is cut to the limit", async () => {
  const store = withMessages(50);
  const out = await updateSummary({ model: new FakeModel([summaryOf("长".repeat(700))]), store, window: 40, timeZone: "UTC" });
  expect(out?.chars).toBe(400);
});

test("clearing history resets the summary; forgetting a fact drops its text", () => {
  const store = withMessages(3);
  store.setSettings({ [SUMMARY_SETTING]: "s", [SUMMARY_UPTO_SETTING]: "2" });
  store.clearHistory();
  expect(store.getSetting(SUMMARY_SETTING)).toBeNull();
  expect(store.getSetting(SUMMARY_UPTO_SETTING)).toBeNull();

  const source = store.addMessage("user", "我养了猫");
  store.upsertFact({ category: "pet", key: "cat", value: "用户养了猫", eventDate: null, evidence: "我养了猫" }, source);
  store.setSettings({ [SUMMARY_SETTING]: "用户说过猫", [SUMMARY_UPTO_SETTING]: "5" });
  store.forgetFact(store.activeFacts()[0].id);
  expect(store.getSetting(SUMMARY_SETTING)).toBeNull();
  expect(store.getSetting(SUMMARY_UPTO_SETTING)).toBe("5"); // old messages aren't folded in again
});

test("the summary appears in the prompt only with memory on", () => {
  const parts = loadPromptParts(ROOT);
  const now = new Date("2026-09-24T12:00:00Z");
  const on = buildSystemPrompt(parts, { now, timeZone: "UTC", memoryEnabled: true, facts: [], crisis: false, summary: "上周聊过搬家" });
  expect(on).toContain("## 更早聊过的");
  expect(on).toContain("上周聊过搬家");
  const off = buildSystemPrompt(parts, { now, timeZone: "UTC", memoryEnabled: false, facts: [], crisis: false, summary: "上周聊过搬家" });
  expect(off).not.toContain("上周聊过搬家");
});

test("retention deletes old history, but with memory on only what the summary already holds", async () => {
  const { applyRetention } = await import("../src/memory/summary.ts");
  const store = Store.open(":memory:");
  const day = (d: number) => new Date(Date.UTC(2026, 8, d)).toISOString();
  for (const d of [1, 2, 3]) store.addMessage("user", `九月${d}日`, { createdAt: day(d) });
  store.addMessage("user", "今天", { createdAt: day(24) });
  const now = new Date(day(25));

  expect(applyRetention(store, 0, now)).toBe(0); // 0 keeps everything
  store.setMemoryEnabled(true);
  expect(applyRetention(store, 22, now)).toBe(0); // nothing folded yet
  store.setSetting(SUMMARY_UPTO_SETTING, "2");
  expect(applyRetention(store, 23, now)).toBe(1); // only 1 Sep is older than 23 days, and it is folded
  store.setMemoryEnabled(false);
  expect(applyRetention(store, 20, now)).toBe(2); // memory off: everything older goes
  expect(store.recentMessages(10).map((m) => m.text)).toEqual(["今天"]);
});

test("a fold in flight doesn't write back over /history clear or /memory forget", async () => {
  for (const interrupt of ["clear", "forget"] as const) {
    const store = withMessages(50);
    const source = store.addMessage("user", "我养了猫");
    store.upsertFact({ category: "pet", key: "cat", value: "用户养了猫", eventDate: null, evidence: "我养了猫" }, source);
    const model = new FakeModel([
      () => {
        if (interrupt === "clear") store.clearHistory();
        else store.forgetFact(store.activeFacts()[0].id);
        return summaryOf("用户养了猫");
      },
    ]);
    expect(await updateSummary({ model, store, window: 40, timeZone: "UTC" })).toBeNull();
    expect(store.getSetting(SUMMARY_SETTING)).toBeNull();
  }
});

test("after a forget, messages the summary hadn't reached are never folded in", async () => {
  const store = withMessages(60);
  store.setSettings({ [SUMMARY_SETTING]: "旧", [SUMMARY_UPTO_SETTING]: "5" });
  const source = store.addMessage("user", "我养了猫");
  store.upsertFact({ category: "pet", key: "cat", value: "用户养了猫", eventDate: null, evidence: "我养了猫" }, source);
  store.forgetFact(store.activeFacts()[0].id);
  expect(store.getSetting(SUMMARY_UPTO_SETTING)).toBe(String(source.id));
  for (let i = 0; i < 9; i++) store.addMessage("user", `之后${i}`);
  // Only messages newer than the forget can be folded now, and not enough have aged out.
  expect(await updateSummary({ model: new FakeModel([summaryOf("x")]), store, window: 40, timeZone: "UTC" })).toBeNull();
});

test("a long history is folded 100 at a time", async () => {
  const store = withMessages(300);
  const model = new FakeModel([summaryOf("第一批")]);
  expect(await updateSummary({ model, store, window: 40, timeZone: "UTC" })).toMatchObject({ folded: 100 });
  expect(store.getSetting(SUMMARY_UPTO_SETTING)).toBe("100");
});
