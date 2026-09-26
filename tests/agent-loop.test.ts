import { expect, test } from "vitest";
import { z } from "zod";
import { FakeAgentModel } from "../src/agent/fake.ts";
import { runAgent, type LoopEvent } from "../src/agent/loop.ts";
import { defineTool, MAX_RESULT_CHARS, ToolRegistry } from "../src/agent/tools.ts";

function calendarTools() {
  const calls: Array<{ days: number }> = [];
  const tools = new ToolRegistry([
    defineTool({
      name: "get_calendar",
      description: "Events for the next N days.",
      input: z.object({ days: z.number().int().min(1).max(7) }),
      run: async (input) => {
        calls.push(input);
        return `2 events in the next ${input.days} day(s)`;
      },
    }),
    defineTool({
      name: "get_sleep",
      description: "Last night's sleep.",
      input: z.object({}),
      run: async () => "5h10m asleep",
    }),
    defineTool({
      name: "broken",
      description: "Always fails.",
      input: z.object({}),
      run: async () => {
        throw new Error("sensor offline");
      },
    }),
  ]);
  return { tools, calls };
}

const ask = [{ role: "user" as const, content: "What's on today?" }];
const system = "You are DearByte.";

test("runs a tool call, sends the result back, and returns the answer", async () => {
  const { tools, calls } = calendarTools();
  const model = new FakeAgentModel([FakeAgentModel.toolUse(["get_calendar", { days: 1 }]), FakeAgentModel.text("Two meetings today.")]);
  const result = await runAgent({ model, tools, system, messages: ask });

  expect(result).toMatchObject({ stop: "done", text: "Two meetings today.", steps: 2 });
  expect(calls).toEqual([{ days: 1 }]);
  const second = model.requests[1].messages;
  expect(second.at(-1)).toEqual({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_0_get_calendar", content: "2 events in the next 1 day(s)" }],
  });
  // The kept conversation: question, tool call, result, answer.
  expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

test("parallel calls: every result goes back in one message, in call order", async () => {
  const { tools } = calendarTools();
  const model = new FakeAgentModel([FakeAgentModel.toolUse(["get_sleep", {}], ["get_calendar", { days: 2 }]), FakeAgentModel.text("ok")]);
  await runAgent({ model, tools, system, messages: ask });
  const results = model.requests[1].messages.at(-1)!.content as Array<{ tool_use_id: string }>;
  expect(results.map((r) => r.tool_use_id)).toEqual(["toolu_0_get_sleep", "toolu_1_get_calendar"]);
});

test("invalid input is returned as an error and the tool never runs", async () => {
  const { tools, calls } = calendarTools();
  const model = new FakeAgentModel([FakeAgentModel.toolUse(["get_calendar", { days: 30 }]), FakeAgentModel.text("Sorry.")]);
  const events: LoopEvent[] = [];
  const result = await runAgent({ model, tools, system, messages: ask, onEvent: (e) => events.push(e) });

  expect(calls).toEqual([]);
  const [error] = model.requests[1].messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>;
  expect(error.is_error).toBe(true);
  expect(error.content).toMatch(/^Error: Invalid input for get_calendar/);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "get_calendar", ok: false }));
  expect(result.stop).toBe("done");
});

test("an unknown tool or a failing tool becomes an error result, not a crash", async () => {
  const { tools } = calendarTools();
  const model = new FakeAgentModel([FakeAgentModel.toolUse(["no_such_tool", {}], ["broken", {}]), FakeAgentModel.text("Couldn't check.")]);
  const result = await runAgent({ model, tools, system, messages: ask });
  const contents = (model.requests[1].messages.at(-1)!.content as Array<{ content: string }>).map((r) => r.content);
  expect(contents).toEqual(["Error: There is no tool named no_such_tool.", "Error: broken failed: sensor offline"]);
  expect(result.stop).toBe("done");
});

test("a refusal stops the loop without running that turn's tools", async () => {
  const { tools, calls } = calendarTools();
  const model = new FakeAgentModel([{ ...FakeAgentModel.toolUse(["get_calendar", { days: 1 }]), stopReason: "refusal" }]);
  const result = await runAgent({ model, tools, system, messages: ask });
  expect(result).toMatchObject({ stop: "refusal", text: "", steps: 1 });
  expect(calls).toEqual([]);
  expect(result.messages).toEqual(ask); // nothing half-finished is kept
});

test("a tool call cut off at max_tokens is never run", async () => {
  const { tools, calls } = calendarTools();
  const model = new FakeAgentModel([{ ...FakeAgentModel.toolUse(["get_calendar", { days: 1 }]), stopReason: "max_tokens" }]);
  const result = await runAgent({ model, tools, system, messages: ask });
  expect(result.stop).toBe("truncated");
  expect(calls).toEqual([]);
  expect(result.messages).toEqual(ask);
});

test("stops at the step limit, with no unanswered tool call left in the conversation", async () => {
  const { tools } = calendarTools();
  const model = new FakeAgentModel(Array.from({ length: 5 }, () => FakeAgentModel.toolUse(["get_sleep", {}])));
  const result = await runAgent({ model, tools, system, messages: ask, maxSteps: 3 });
  expect(result).toMatchObject({ stop: "max_steps", steps: 3 });
  expect(result.messages.at(-1)!.role).toBe("user"); // ends on tool results
});

test("stops once the run's spending limit is reached", async () => {
  const { tools } = calendarTools();
  const model = new FakeAgentModel(Array.from({ length: 5 }, () => FakeAgentModel.toolUse(["get_sleep", {}])), 0.2);
  const result = await runAgent({ model, tools, system, messages: ask, maxCost: 0.5 });
  expect(result).toMatchObject({ stop: "budget", steps: 3 });
  expect(result.cost).toBeCloseTo(0.6);
});

test("tool definitions: JSON Schema from zod, sorted by name, same every time", () => {
  const { tools } = calendarTools();
  const defs = tools.definitions();
  expect(defs.map((d) => d.name)).toEqual(["broken", "get_calendar", "get_sleep"]);
  expect(defs[1].input_schema).toEqual({
    type: "object",
    properties: { days: { type: "integer", minimum: 1, maximum: 7 } },
    required: ["days"],
    additionalProperties: false,
  });
  expect(JSON.stringify(tools.definitions())).toBe(JSON.stringify(defs));
});

test("long tool output is cut to a fixed size", async () => {
  const tools = new ToolRegistry([defineTool({ name: "dump", description: "Lots of text.", input: z.object({}), run: async () => "x".repeat(MAX_RESULT_CHARS + 500) })]);
  const { result } = await tools.run({ type: "tool_use", id: "t1", name: "dump", input: {}, caller: { type: "direct" } });
  expect(String(result.content)).toMatch(/\[truncated: 20500 characters in total\]$/);
});

test("two tools with one name are rejected", () => {
  const t = defineTool({ name: "same", description: "", input: z.object({}), run: async () => "" });
  expect(() => new ToolRegistry([t, t])).toThrow("two tools are named same");
});
