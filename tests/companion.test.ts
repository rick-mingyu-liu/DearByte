import { expect, test } from "vitest";
import { Companion, type CompanionEvent } from "../src/companion/companion.ts";
import { FALLBACK_REPLY } from "../src/companion/output.ts";
import { loadPromptParts } from "../src/companion/prompt.ts";
import { ROOT } from "../src/config.ts";
import { extractFacts } from "../src/memory/extract.ts";
import { FakeModel } from "../src/model/fake.ts";
import { Store } from "../src/storage/store.ts";

const parts = loadPromptParts(ROOT);
const reply = (...bubbles: string[]) => JSON.stringify({ bubbles });
const facts = (...f: object[]) => JSON.stringify({ facts: f });

function setup(responses: ConstructorParameters<typeof FakeModel>[0], memory = false) {
  const store = Store.open(":memory:");
  store.setMemoryEnabled(memory);
  const model = new FakeModel(responses);
  const events: CompanionEvent[] = [];
  const companion = new Companion({
    store,
    model,
    parts,
    timeZone: "Asia/Shanghai",
    historyMessages: 40,
    now: () => new Date("2026-09-24T04:40:00Z"),
    onEvent: (e) => events.push(e),
  });
  return { store, model, events, companion };
}

test("a turn stores both sides and passes earlier turns as history", async () => {
  const { store, model, companion } = setup([reply("早啊"), reply("还行吧", "你呢")]);
  await companion.handle({ text: "早上好" });
  const turn = await companion.handle({ text: "今天怎么样" });

  expect(turn.reply.bubbles).toEqual(["还行吧", "你呢"]);
  expect(store.recentMessages(10).map((m) => m.text)).toEqual(["早上好", "早啊", "今天怎么样", "还行吧\n你呢"]);
  const second = model.calls[1].messages;
  expect(second.slice(1).map((m) => m.content)).toEqual(["早上好", reply("早啊"), "今天怎么样"]);
});

test("invalid output gets one repair attempt", async () => {
  const { companion, model, events } = setup(["好的呀", reply("修好了")]);
  const turn = await companion.handle({ text: "在吗" });
  expect(turn.reply.bubbles).toEqual(["修好了"]);
  expect(model.calls).toHaveLength(2);
  expect(String(model.calls[1].messages.at(-1)?.content)).toContain("格式不对");
  expect(events.some((e) => e.type === "reply_invalid" && e.action === "repair")).toBe(true);
});

test("after a failed repair, an over-long reply is clipped rather than dropped", async () => {
  const six = reply("1", "2", "3", "4", "5", "6");
  const { companion } = setup([six, six]);
  expect((await companion.handle({ text: "撑不下去了" })).reply.bubbles).toEqual(["1", "2", "3", "4"]);
});

test("unsalvageable output falls back to a fixed reply", async () => {
  const { companion } = setup(["???", "!!!"]);
  expect((await companion.handle({ text: "在吗" })).reply).toEqual(FALLBACK_REPLY);
});

test("memory off: no extraction call, prompt says memory is off", async () => {
  const { companion, model } = setup([reply("好")]);
  const turn = await companion.handle({ text: "下周六我考雅思" });
  expect(await turn.memory).toBeNull();
  expect(model.calls).toHaveLength(1);
  expect(String(model.calls[0].messages[0].content)).toContain("长期记忆：关闭");
});

test("memory on: facts are stored in the background and used on the next turn", async () => {
  const { companion, model, store } = setup(
    [
      reply("加油"),
      facts({ category: "event", key: "ielts_exam", value: "用户在准备雅思考试", event_date: "2026-10-03", evidence: "下周六我考雅思" }),
      reply("是雅思那事吧"),
    ],
    true,
  );
  const first = await companion.handle({ text: "下周六我考雅思" });
  const outcome = await first.memory;
  expect(outcome?.results).toEqual([{ key: "ielts_exam", value: "用户在准备雅思考试", result: "inserted" }]);

  await companion.handle({ text: "好紧张" });
  const system = String(model.calls[2].messages[0].content);
  expect(system).toContain("- 用户在准备雅思考试（event；日期 2026-10-03");
  expect(store.activeFacts()[0].evidence).toBe("下周六我考雅思");
});

test("extraction rejects facts whose evidence is not the user's own words", async () => {
  const store = Store.open(":memory:");
  const userMessage = store.addMessage("user", "嗯嗯");
  const model = new FakeModel([
    facts({ category: "pet", key: "pet_cat", value: "用户养了一只橘猫", event_date: null, evidence: "我家橘猫" }),
  ]);
  const outcome = await extractFacts({ model, store, userMessage, previousAssistant: null, timeZone: "Asia/Shanghai" });
  expect(outcome.rejected).toEqual([{ key: "pet_cat", reason: "evidence is not a quote of the user's message" }]);
  expect(store.activeFacts()).toHaveLength(0);
});

test("extraction failure is reported but the reply still arrives", async () => {
  const { companion, events } = setup(
    [
      reply("好"),
      () => {
        throw new Error("network down");
      },
    ],
    true,
  );
  const turn = await companion.handle({ text: "我喜欢喝冰美式" });
  expect(turn.reply.bubbles).toEqual(["好"]);
  expect(await turn.memory).toBeNull();
  expect(events).toContainEqual({ type: "memory_error", message: "network down" });
});
