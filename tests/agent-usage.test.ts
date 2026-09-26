import { expect, test } from "vitest";
import { z } from "zod";
import type { AgentModel, AgentRequest, AgentStep } from "../src/agent/model.ts";
import { FakeAgentModel } from "../src/agent/fake.ts";
import { runAgent } from "../src/agent/loop.ts";
import { defineTool, ToolRegistry } from "../src/agent/tools.ts";
import { MeteredAgentModel, WEEK_MS, WeeklyCapReached } from "../src/agent/usage.ts";
import { Store } from "../src/storage/store.ts";

/** A model that reports fixed usage and costs `perCall` USD per call. */
function priced(perCall: number, steps = [FakeAgentModel.text("ok")]): AgentModel {
  const fake = new FakeAgentModel(steps);
  return {
    name: "priced",
    step: async (req: AgentRequest): Promise<AgentStep> => ({
      ...(await fake.step(req)),
      model: "deepseek-flash",
      usage: { promptTokens: 1_000, cacheHitTokens: 600, cacheWriteTokens: 0, completionTokens: 200 },
      ms: 5,
    }),
    cost: () => perCall,
  };
}

const request: AgentRequest = { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] };

test("every call is logged with its purpose, tier, tokens and cost", async () => {
  const store = Store.open(":memory:");
  const model = new MeteredAgentModel(priced(0.01), { tier: "worker", store, weeklyCap: 5, now: () => new Date("2026-09-26T12:00:00Z") });
  await model.step({ ...request, purpose: "morning_brief" });
  await model.step(request);

  const rows = store.agentUsageSummary("2026-09-20T00:00:00Z");
  expect(rows).toEqual([
    expect.objectContaining({ purpose: "morning_brief", tier: "worker", model: "deepseek-flash", calls: 1, promptTokens: 1_000, cacheHitTokens: 600, completionTokens: 200, cost: 0.01, unpriced: 0 }),
    expect.objectContaining({ purpose: "other", calls: 1 }),
  ]);
  expect(store.agentSpendSince("2026-09-20T00:00:00Z")).toBeCloseTo(0.02);
});

test("calls stop once the last 7 days reach the cap, and resume as old spend ages out", async () => {
  const store = Store.open(":memory:");
  let now = new Date("2026-09-26T12:00:00Z");
  const model = new MeteredAgentModel(priced(0.4, Array.from({ length: 5 }, () => FakeAgentModel.text("ok"))), { tier: "brain", store, weeklyCap: 1, now: () => now });

  await model.step(request);
  await model.step(request);
  await model.step(request); // $1.20: this call started under the cap, so a week can end one call over
  await expect(model.step(request)).rejects.toBeInstanceOf(WeeklyCapReached);

  now = new Date(now.getTime() + WEEK_MS + 1);
  await expect(model.step(request)).resolves.toMatchObject({ stopReason: "end_turn" });
});

test("a cap of 0 turns it off", async () => {
  const store = Store.open(":memory:");
  const model = new MeteredAgentModel(priced(100, [FakeAgentModel.text("a"), FakeAgentModel.text("b")]), { tier: "brain", store, weeklyCap: 0 });
  await model.step(request);
  await expect(model.step(request)).resolves.toBeDefined();
});

test("unknown cost is logged as unpriced and counts as 0 toward the cap", async () => {
  const store = Store.open(":memory:");
  const unknown: AgentModel = { ...priced(0), cost: () => null };
  await new MeteredAgentModel(unknown, { tier: "worker", store, weeklyCap: 1 }).step(request);
  const [row] = store.agentUsageSummary("2000-01-01T00:00:00Z");
  expect(row).toMatchObject({ unpriced: 1, cost: 0 });
});

test("the loop stops cleanly at the weekly cap, without running tools", async () => {
  const store = Store.open(":memory:");
  store.recordAgentUsage({ at: new Date().toISOString(), purpose: "chat", tier: "brain", model: "m", promptTokens: 0, cacheHitTokens: 0, cacheWriteTokens: 0, completionTokens: 0, cost: 5, ms: 0 });
  let ran = false;
  const tools = new ToolRegistry([defineTool({ name: "t", description: "", input: z.object({}), run: async () => ((ran = true), "") })]);
  const model = new MeteredAgentModel(new FakeAgentModel([FakeAgentModel.toolUse(["t", {}])]), { tier: "brain", store, weeklyCap: 5 });
  const result = await runAgent({ model, tools, system: "s", messages: request.messages, purpose: "chat" });
  expect(result).toMatchObject({ stop: "weekly_cap", steps: 0, text: "" });
  expect(ran).toBe(false);
});
