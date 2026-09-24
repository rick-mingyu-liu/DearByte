import { expect, test } from "vitest";
import { bubbleDelay, readDelay } from "../src/channels/reply-loop.ts";
import { buildSystemPrompt, loadPromptParts, recentPhrases } from "../src/companion/prompt.ts";
import { toneReport } from "../src/companion/tone.ts";
import { ROOT } from "../src/config.ts";
import type { StoredMessage } from "../src/domain.ts";

test("tone report flags assistant habits and scores human texting as zero", () => {
  expect(toneReport(["第三次？", "这已经不是拿错了 是认领"]).score).toBe(0);

  const ai = toneReport([
    "首先，你要照顾好自己的情绪。",
    "此外，我建议你找个合适的时间和领导好好沟通一下，希望能帮到你",
    "我只是一段代码",
  ]);
  expect(ai.flags).toEqual(expect.arrayContaining(["列表", "客服腔", "书面语", "提到自己是AI"]));
  expect(ai.periods).toBe(1);
  expect(ai.longBubbles).toBe(1);
  expect(ai.score).toBeGreaterThanOrEqual(6);
});

const said = (id: number, bubbles: string[]): StoredMessage =>
  ({ id, role: "assistant", text: bubbles.join("\n"), bubbles, hasImage: false, createdAt: "" }) as StoredMessage;
const user = (id: number, text: string): StoredMessage =>
  ({ id, role: "user", text, bubbles: null, hasImage: false, createdAt: "" }) as StoredMessage;

test("recent phrases: last few turns, skipping tiny bubbles and duplicates", () => {
  const history = [
    said(1, ["很早以前说的一句话"]),
    user(2, "a"),
    said(3, ["在", "那你早点休息呀"]),
    user(4, "b"),
    said(5, ["那你早点休息呀", "明天还要早起吧"]),
    user(6, "c"),
    said(7, ["哈哈哈这猫太胖了"]),
  ];
  expect(recentPhrases(history)).toEqual(["那你早点休息呀", "明天还要早起吧", "哈哈哈这猫太胖了"]);
});

test("recent phrases go at the very end of the system prompt", () => {
  const system = buildSystemPrompt(loadPromptParts(ROOT), {
    now: new Date("2026-09-24T12:00:00Z"),
    timeZone: "Asia/Shanghai",
    memoryEnabled: false,
    facts: [],
    crisis: false,
    recent: ["那你早点休息呀"],
  });
  expect(system.trimEnd().endsWith("- 那你早点休息呀")).toBe(true);
  expect(buildSystemPrompt(loadPromptParts(ROOT), { now: new Date(), timeZone: "Asia/Shanghai", memoryEnabled: false, facts: [], crisis: false })).not.toContain("最近说过的话");
});

test("typing pauses grow with length, vary, and stay capped", () => {
  expect(bubbleDelay("好", 0.5)).toBeLessThan(bubbleDelay("这句话要打好一会儿才能打完", 0.5));
  expect(bubbleDelay("好", 0)).toBeLessThan(bubbleDelay("好", 0.99));
  expect(bubbleDelay("长".repeat(200), 0.99)).toBeLessThanOrEqual(5_000);
  expect(readDelay(0)).toBe(1_500);
  expect(readDelay(0.99)).toBeLessThan(3_500);
});
