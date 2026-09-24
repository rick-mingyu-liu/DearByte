import { expect, test } from "vitest";
import { aboutName, filmChannelLine, filmCompanionLine } from "../src/film.ts";

const now = new Date("2026-09-24T12:05:00Z");

test("facts about 「用户」 read with the user's name", () => {
  expect(aboutName("用户周五有面试", "Rick")).toBe("Rick 周五有面试");
  expect(aboutName("用户喜欢猫", "张三")).toBe("张三喜欢猫");
  expect(aboutName("用户养了Mochi", "Rick")).toBe("Rick 养了Mochi");
  expect(aboutName("喜欢猫", "Rick")).toBe("喜欢猫");
});

test("the filming log shows the conversation and memories, and nothing technical", () => {
  expect(filmChannelLine({ type: "inbound", text: "你爱我吗", image: false, merged: 1 }, "Rick", now)).toContain("💬 Rick：你爱我吗");
  expect(filmChannelLine({ type: "inbound", text: "", image: true, merged: 1 }, "Rick", now)).toContain("Rick：📷");
  expect(filmChannelLine({ type: "sent", bubble: "爱啊宝贝" }, "Rick", now)).toContain("💌 小拜：爱啊宝贝");
  expect(filmChannelLine({ type: "initiated", reason: "event_am:ielts_exam" }, "Rick", now)).toContain("打气");
  expect(filmChannelLine({ type: "status", message: "已连接「张三」，从现在起…" }, "Rick", now)).toContain("上线");
  expect(filmChannelLine({ type: "status", message: "聊天记录跳动了" }, "Rick", now)).toBeNull();
  expect(filmChannelLine({ type: "error", message: "x" }, "Rick", now)).toBeNull();
  expect(filmCompanionLine({ type: "model", purpose: "reply", ms: 1, promptTokens: 1, cacheHitTokens: 0, completionTokens: 1, cost: 0 }, "Rick", now)).toBeNull();

  const memory = filmCompanionLine(
    {
      type: "memory",
      outcome: {
        results: [
          { key: "interview", value: "用户周五有面试", result: "inserted" },
          { key: "cat", value: "用户喜欢猫", result: "unchanged" },
        ],
        rejected: [],
      },
    },
    "Rick",
    now,
  );
  expect(memory).toContain("🧠 记住了：Rick 周五有面试");
  expect(memory).not.toContain("猫");
});
