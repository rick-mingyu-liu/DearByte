import { expect, test } from "vitest";
import { buildSystemPrompt, loadPromptParts } from "../src/companion/prompt.ts";
import { bubbleHint, emojiRecently, userEnergy } from "../src/companion/energy.ts";
import { ROOT } from "../src/config.ts";

test("short, flat messages are low energy", () => {
  for (const text of ["嗯", "哦", "在干嘛", "早", "吃了", "今天好累"]) expect(userEnergy({ text })).toBe("low");
});

test("long, excited or photo messages are high energy", () => {
  expect(userEnergy({ text: "我今天终于把拖了三个月的PPT交了！！" })).toBe("high");
  expect(userEnergy({ text: "室友又把我的外卖拿错了，第三次了，这次还是我最爱的那家烧鹅饭" })).toBe("high");
  expect(userEnergy({ text: "", image: true })).toBe("high");
});

test("a short message with excitement isn't low", () => {
  expect(userEnergy({ text: "哈哈哈哈" })).toBe("mid");
  expect(userEnergy({ text: "你爱我吗[偷笑]" })).toBe("mid");
  expect(userEnergy({ text: "下班了，地铁好挤" })).toBe("low");
  expect(userEnergy({ text: "室友又把我的外卖拿错了" })).toBe("mid");
});

test("the bubble hint goes last, and never in a crisis", () => {
  const parts = loadPromptParts(ROOT);
  const base = { now: new Date("2026-09-24T12:00:00Z"), timeZone: "Asia/Shanghai", memoryEnabled: false, facts: [], recent: ["哈哈哈哈哈"] };
  const low = buildSystemPrompt(parts, { ...base, crisis: false, energy: "low" });
  expect(low.trimEnd().endsWith(bubbleHint("low")!)).toBe(true);
  expect(buildSystemPrompt(parts, { ...base, crisis: true, energy: "low" })).not.toContain("## 这一轮");
  expect(buildSystemPrompt(parts, { ...base, crisis: false, energy: "high" })).not.toContain("## 这一轮");
});

test("an emoji in one of the last two replies rules one out this turn", () => {
  const said = (text: string) => ({ role: "assistant", text });
  const you = (text: string) => ({ role: "user", text });
  expect(emojiRecently([said("笑死😂"), you("哈哈"), said("行吧")])).toBe(true);
  expect(emojiRecently([said("就这？[裂开]"), you("嗯")])).toBe(true);
  expect(emojiRecently([said("笑死😂"), said("行吧"), said("去吧")])).toBe(false);
  const parts = loadPromptParts(ROOT);
  const base = { now: new Date("2026-09-24T12:00:00Z"), timeZone: "Asia/Shanghai", memoryEnabled: false, facts: [], crisis: false };
  expect(buildSystemPrompt(parts, { ...base, emojiRecently: true })).toContain("这一轮不要用");
  expect(buildSystemPrompt(parts, { ...base, crisis: true, emojiRecently: true })).not.toContain("这一轮不要用");
});
