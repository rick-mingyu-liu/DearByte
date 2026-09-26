import { expect, test } from "vitest";
import { MessagesAgentModel, type AgentRequest } from "../src/agent/model.ts";
import { FakeAgentModel } from "../src/agent/fake.ts";

/** A stand-in for the SDK client: records the request and returns a fixed message. */
function clientReturning(message: Record<string, unknown>) {
  const sent: Array<{ params: Record<string, unknown>; options: unknown }> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>, options: unknown) => {
          sent.push({ params, options });
          return { finalMessage: async () => message };
        },
      },
    },
  };
  return { client: client as never, sent };
}

const claude = (client: never) => new MessagesAgentModel({ provider: "anthropic", model: "claude-opus-5", client });

const toolUseMessage = {
  model: "claude-opus-5",
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "get_calendar", input: { days: 1 } }],
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200 },
};

const request: AgentRequest = {
  system: "You are DearByte.",
  messages: [{ role: "user", content: "What's on today?" }],
  tools: [{ name: "get_calendar", description: "Events", input_schema: { type: "object", properties: {} } }],
};

test("Claude: sends adaptive thinking, default fallbacks and a cached system prompt", async () => {
  const { client, sent } = clientReturning(toolUseMessage);
  await claude(client).step(request);
  const params = sent[0].params;
  expect(params.model).toBe("claude-opus-5");
  expect(params.thinking).toEqual({ type: "adaptive" });
  expect(params.fallbacks).toBe("default");
  expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
  expect(params.system).toEqual([{ type: "text", text: "You are DearByte.", cache_control: { type: "ephemeral" } }]);
  expect(params.tools).toBe(request.tools);
  expect(params.max_tokens).toBe(16_000);
});

test("returns tool calls as blocks, and counts cached input in the prompt total", async () => {
  const { client } = clientReturning(toolUseMessage);
  const step = await claude(client).step(request);
  expect(step.stopReason).toBe("tool_use");
  expect(step.content[0]).toMatchObject({ type: "tool_use", name: "get_calendar", input: { days: 1 } });
  expect(step.usage).toEqual({ promptTokens: 1_300, cacheHitTokens: 1_000, cacheWriteTokens: 200, completionTokens: 50 });
});

test("prices Opus 5: cache reads at a tenth, cache writes at 1.25×", async () => {
  const model = claude(clientReturning(toolUseMessage).client);
  const cost = model.cost({ promptTokens: 1_300, cacheHitTokens: 1_000, cacheWriteTokens: 200, completionTokens: 50 });
  // 100 × $5 + 1,000 × $0.5 + 200 × $6.25 + 50 × $25, per million
  expect(cost).toBeCloseTo((500 + 500 + 1_250 + 1_250) / 1e6, 10);
  expect(new MessagesAgentModel({ provider: "anthropic", model: "claude-unknown", client: clientReturning(toolUseMessage).client }).cost({ promptTokens: 1, cacheHitTokens: 0, completionTokens: 1 })).toBeNull();
});

test("reports which model answered, so a fallback is visible", async () => {
  const { client } = clientReturning({ ...toolUseMessage, model: "claude-opus-4-8", stop_reason: "end_turn", content: [] });
  const step = await claude(client).step(request);
  expect(step.model).toBe("claude-opus-4-8");
});

test("passes a refusal through for the loop to handle", async () => {
  const { client } = clientReturning({ ...toolUseMessage, stop_reason: "refusal" });
  const step = await claude(client).step(request);
  expect(step.stopReason).toBe("refusal");
});

test("the abort signal reaches the SDK", async () => {
  const { client, sent } = clientReturning(toolUseMessage);
  const signal = AbortSignal.timeout(1_000);
  await claude(client).step({ ...request, signal });
  expect(sent[0].options).toEqual({ signal });
});

test("the fake plays back scripted steps and records requests", async () => {
  const fake = new FakeAgentModel([FakeAgentModel.toolUse(["get_calendar", { days: 1 }]), FakeAgentModel.text("Two meetings.")]);
  expect((await fake.step(request)).stopReason).toBe("tool_use");
  const last = await fake.step(request);
  expect(last.content).toEqual([{ type: "text", text: "Two meetings.", citations: null }]);
  expect(fake.requests).toHaveLength(2);
});

test("DeepSeek: no Claude-only fields, and its own prices", async () => {
  const { client, sent } = clientReturning({ ...toolUseMessage, model: "deepseek-flash" });
  const model = new MessagesAgentModel({ provider: "deepseek", model: "deepseek-flash", client });
  const step = await model.step(request);
  const params = sent[0].params;
  expect(params).not.toHaveProperty("fallbacks");
  expect(params).not.toHaveProperty("betas");
  expect(params).not.toHaveProperty("thinking");
  expect(step.stopReason).toBe("tool_use");
  // deepseek-flash: $0.3 in, $0.006 cached, $1.2 out per million
  expect(model.cost({ promptTokens: 1_000, cacheHitTokens: 0, completionTokens: 1_000 })).toBeCloseTo(1.5 / 1e3, 10);
});

test("effort is sent only when set", async () => {
  const { client, sent } = clientReturning(toolUseMessage);
  await new MessagesAgentModel({ provider: "anthropic", model: "claude-opus-5-5", effort: "high", client }).step(request);
  await claude(client).step(request);
  expect(sent[0].params.output_config).toEqual({ effort: "high" });
  expect(sent[1].params).not.toHaveProperty("output_config");
});

/** A client whose first streams die midway with `error`, then succeed. */
function flakyClient(failures: number, error: () => Error) {
  let calls = 0;
  const client = {
    beta: {
      messages: {
        stream: () => {
          calls++;
          const fail = calls <= failures;
          return { finalMessage: async () => (fail ? Promise.reject(error()) : toolUseMessage) };
        },
      },
    },
  };
  return { client: client as never, calls: () => calls };
}

test("a stream that drops midway is asked again, up to twice", async () => {
  const ok = flakyClient(2, () => new TypeError("terminated"));
  expect((await claude(ok.client).step(request)).stopReason).toBe("tool_use");
  expect(ok.calls()).toBe(3);

  const down = flakyClient(3, () => new TypeError("terminated"));
  await expect(claude(down.client).step(request)).rejects.toThrow("terminated");
  expect(down.calls()).toBe(3);
});

test("other errors and cancelled requests are not retried", async () => {
  const other = flakyClient(1, () => new Error("bad request"));
  await expect(claude(other.client).step(request)).rejects.toThrow("bad request");
  expect(other.calls()).toBe(1);

  const cancelled = flakyClient(1, () => new TypeError("terminated"));
  const controller = new AbortController();
  controller.abort();
  await expect(claude(cancelled.client).step({ ...request, signal: controller.signal })).rejects.toThrow("terminated");
  expect(cancelled.calls()).toBe(1);
});
