import { expect, test } from "vitest";
import { resolveTiers } from "../src/agent/tiers.ts";

test("both tiers default to DeepSeek flash", () => {
  expect(resolveTiers({ DEEPSEEK_API_KEY: "sk-test" })).toEqual({
    brain: { provider: "deepseek", model: "deepseek-flash", apiKey: "sk-test" },
    worker: { provider: "deepseek", model: "deepseek-flash", apiKey: "sk-test" },
  });
});

test("the brain can be Claude with an effort, while the worker stays cheap", () => {
  const tiers = resolveTiers({ DEEPSEEK_API_KEY: "sk-test", DEARBYTE_BRAIN: "anthropic:claude-opus-5-5", DEARBYTE_BRAIN_EFFORT: "high" });
  expect(tiers).toMatchObject({ brain: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, worker: { provider: "deepseek" } });
});

test("Claude needs no key in env: the SDK can find a login profile", () => {
  const tiers = resolveTiers({ DEARBYTE_BRAIN: "anthropic:claude-opus-5", DEARBYTE_WORKER: "anthropic:claude-opus-5" });
  expect(tiers).not.toHaveProperty("problem");
});

test("incomplete settings are explained, not guessed", () => {
  expect(resolveTiers({})).toMatchObject({ problem: expect.stringContaining("DEEPSEEK_API_KEY") });
  expect(resolveTiers({ DEEPSEEK_API_KEY: "k", DEARBYTE_BRAIN: "openai:gpt-5" })).toMatchObject({ problem: expect.stringContaining("provider:model") });
  expect(resolveTiers({ DEEPSEEK_API_KEY: "k", DEARBYTE_BRAIN: "anthropic:claude-mystery" })).toMatchObject({ problem: expect.stringContaining("no known price") });
  expect(resolveTiers({ DEEPSEEK_API_KEY: "k", DEARBYTE_WORKER_EFFORT: "huge" })).toMatchObject({ problem: expect.stringContaining("EFFORT") });
});
