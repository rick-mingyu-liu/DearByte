import { expect, test } from "vitest";
import { parseReply, ReplySchema } from "../src/companion/output.ts";

test("accepts short Chinese bubbles", () => {
  expect(ReplySchema.parse({ bubbles: ["这只猫看起来很会享受生活", "你在哪儿遇到它的？"] }).bubbles).toHaveLength(2);
});

test("rejects empty, too many, or oversized bubbles", () => {
  expect(ReplySchema.safeParse({ bubbles: [] }).success).toBe(false);
  expect(ReplySchema.safeParse({ bubbles: ["1", "2", "3", "4", "5"] }).success).toBe(false);
  expect(ReplySchema.safeParse({ bubbles: ["好".repeat(121)] }).success).toBe(false);
  expect(ReplySchema.safeParse({ bubbles: ["好".repeat(120)] }).success).toBe(true);
  expect(ReplySchema.safeParse({ bubbles: ["   "] }).success).toBe(false);
});

test("counts code points, not UTF-16 units", () => {
  expect(ReplySchema.safeParse({ bubbles: ["😀".repeat(120)] }).success).toBe(true);
});

test("non-JSON output has nothing to salvage", () => {
  expect(parseReply("好的呀")).toEqual({ ok: false, problems: ["not valid JSON"], salvage: null });
});

test("salvage clips an over-long reply to the contract", () => {
  const result = parseReply(JSON.stringify({ bubbles: ["一", "二", "", "三", "四", "五", "好".repeat(130)] }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.salvage?.bubbles).toEqual(["一", "二", "三", "四"]);
  expect(ReplySchema.safeParse(result.salvage).success).toBe(true);
});
