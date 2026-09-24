import { expect, test } from "vitest";
import { Companion, CRISIS_AT_SETTING, type CompanionEvent } from "../src/companion/companion.ts";
import { loadPromptParts } from "../src/companion/prompt.ts";
import { ROOT } from "../src/config.ts";
import type { ChatMessage } from "../src/domain.ts";
import { FakeModel } from "../src/model/fake.ts";
import { Store } from "../src/storage/store.ts";

const isCheck = (m: ChatMessage[]) => String(m[0].content).includes("人身安全风险");
const isSafetyPrompt = (m: ChatMessage[]) => String(m[0].content).includes("# 安全模式（仅在检测到危机信号时插入）");

function setup(risk: boolean | "junk") {
  const store = Store.open(":memory:");
  const model = new FakeModel(
    Array.from({ length: 4 }, () => (m: ChatMessage[]) => {
      if (isCheck(m)) return risk === "junk" ? "??" : JSON.stringify({ risk });
      return JSON.stringify({ bubbles: isSafetyPrompt(m) ? ["你现在人安全吗", "想找人说说可以打 12356"] : ["哈哈 早点睡"] });
    }),
  );
  const events: CompanionEvent[] = [];
  const companion = new Companion({ store, model, parts: loadPromptParts(ROOT), timeZone: "UTC", historyMessages: 40, crisisCheck: true, onEvent: (e) => events.push(e) });
  return { store, model, companion, events };
}

test("a crisis the keywords miss is caught by the model, and the reply is rewritten in safety mode", async () => {
  const { store, model, companion, events } = setup(true);
  const turn = await companion.handle({ text: "活着好没意思" });
  expect(turn.reply.bubbles).toEqual(["你现在人安全吗", "想找人说说可以打 12356"]);
  expect(events.some((e) => e.type === "crisis_detected")).toBe(true);
  expect(model.calls.filter((c) => isCheck(c.messages))).toHaveLength(1);
  expect(store.getSetting(CRISIS_AT_SETTING)).not.toBeNull();
  expect(store.recentMessages(5).at(-1)?.bubbles).toEqual(turn.reply.bubbles); // only the rewrite is stored
});

test("no risk, or unusable check output, keeps the normal reply", async () => {
  for (const risk of [false, "junk"] as const) {
    const { store, model, companion } = setup(risk);
    expect((await companion.handle({ text: "今天累死了" })).reply.bubbles).toEqual(["哈哈 早点睡"]);
    expect(model.calls.filter((c) => isSafetyPrompt(c.messages))).toHaveLength(0);
    expect(store.getSetting(CRISIS_AT_SETTING)).toBeNull();
  }
});

test("a keyword crisis skips the check and records the time", async () => {
  const { store, model, companion } = setup(false);
  await companion.handle({ text: "我不想活了" });
  expect(model.calls.filter((c) => isCheck(c.messages))).toHaveLength(0);
  expect(model.calls.filter((c) => isSafetyPrompt(c.messages))).toHaveLength(1);
  expect(store.getSetting(CRISIS_AT_SETTING)).not.toBeNull();
});
