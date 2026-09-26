// The agent loop: ask the model, run the tools it calls, hand back the
// results, and repeat until it answers. Everything the model asks for goes
// through the registry, so every call is validated and logged here.
//
// It stops early, without running that turn's tools, when:
//   - the model refused (a refusal can cut a tool call off mid-input)
//   - the output hit max_tokens during a tool call (the input may be truncated)
//   - the step or spending limit is reached, or the weekly cap (see usage.ts)

import type { AgentBlock, AgentMessage, AgentModel, AgentStopReason } from "./model.ts";
import type { ToolRegistry, ToolResult } from "./tools.ts";
import { WeeklyCapReached } from "./usage.ts";

export type LoopStop = "done" | "refusal" | "truncated" | "max_steps" | "budget" | "weekly_cap" | "other";

export type LoopEvent =
  | { type: "step"; n: number; model: string; stopReason: AgentStopReason | null; ms: number; cost: number | null }
  | { type: "tool"; name: string; ok: boolean; ms: number };

export type LoopResult = {
  stop: LoopStop;
  /** The final answer's text; empty when the loop stopped early. */
  text: string;
  /** The conversation to keep: the input plus every completed turn. Never ends on an unanswered tool call. */
  messages: AgentMessage[];
  steps: number;
  /** USD spent on model calls in this run. */
  cost: number;
};

export const DEFAULT_MAX_STEPS = 8;
/** USD per run. A run that reaches it finishes its current step, then stops. */
export const DEFAULT_MAX_COST = 0.5;

export async function runAgent(o: {
  model: AgentModel;
  tools: ToolRegistry;
  system: string;
  messages: AgentMessage[];
  maxSteps?: number;
  maxCost?: number;
  /** Recorded in the usage log with every call of this run. */
  purpose?: string;
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
}): Promise<LoopResult> {
  const messages = [...o.messages];
  const maxSteps = o.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxCost = o.maxCost ?? DEFAULT_MAX_COST;
  const tools = o.tools.definitions();
  let cost = 0;

  for (let n = 1; n <= maxSteps; n++) {
    if (cost >= maxCost) return { stop: "budget", text: "", messages, steps: n - 1, cost };
    let step;
    try {
      step = await o.model.step({ system: o.system, messages, tools, signal: o.signal, purpose: o.purpose });
    } catch (err) {
      if (err instanceof WeeklyCapReached) return { stop: "weekly_cap", text: "", messages, steps: n - 1, cost };
      throw err;
    }
    const stepCost = o.model.cost(step.usage);
    cost += stepCost ?? 0;
    o.onEvent?.({ type: "step", n, model: step.model, stopReason: step.stopReason, ms: step.ms, cost: stepCost });

    const calls = step.content.filter((b) => b.type === "tool_use");
    const reply = { role: "assistant" as const, content: step.content as AgentMessage["content"] };
    switch (step.stopReason) {
      case "end_turn":
      case "stop_sequence":
        messages.push(reply);
        return { stop: "done", text: textOf(step.content), messages, steps: n, cost };
      case "max_tokens":
        if (calls.length) return { stop: "truncated", text: "", messages, steps: n, cost };
        messages.push(reply);
        return { stop: "truncated", text: textOf(step.content), messages, steps: n, cost };
      case "pause_turn":
        // A server-side tool paused; sending the turn back lets it continue.
        messages.push(reply);
        continue;
      case "tool_use": {
        messages.push(reply);
        // Parallel calls run together; all results go back in one message, in call order.
        const results: ToolResult[] = await Promise.all(
          calls.map(async (call) => {
            const started = Date.now();
            const { result, ok } = await o.tools.run(call, o.signal);
            o.onEvent?.({ type: "tool", name: call.name, ok, ms: Date.now() - started });
            return result;
          }),
        );
        messages.push({ role: "user", content: results });
        continue;
      }
      case "refusal":
      case null:
        return { stop: "refusal", text: "", messages, steps: n, cost };
      default:
        return { stop: "other", text: "", messages, steps: n, cost };
    }
  }
  return { stop: "max_steps", text: "", messages, steps: maxSteps, cost };
}

function textOf(content: AgentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
