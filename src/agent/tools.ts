// The tools the agent may call. Each tool declares its input as a zod schema:
// the model sees it as JSON Schema, and every call is checked against it
// before the tool runs, because a model's arguments are untrusted output.
// A tool never throws into the loop: failures come back to the model as an
// error result it can read and recover from.

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentTool } from "./model.ts";

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
export type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type Tool<I = unknown> = {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run(input: I, signal?: AbortSignal): Promise<string>;
};

/** Keeps one tool from filling the context window. */
export const MAX_RESULT_CHARS = 20_000;

/** A tool with its input type checked where it's defined, stored without it. */
export function defineTool<I>(tool: Tool<I>): Tool {
  return tool as unknown as Tool;
}

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`two tools are named ${t.name}`);
      this.byName.set(t.name, t);
    }
  }

  /** Sorted by name, so the list is identical every request and stays in the prompt cache. */
  definitions(): AgentTool[] {
    return [...this.byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const { $schema: _, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
        return { name: t.name, description: t.description, input_schema: schema as AgentTool["input_schema"] };
      });
  }

  async run(call: ToolUse, signal?: AbortSignal): Promise<{ result: ToolResult; ok: boolean }> {
    const tool = this.byName.get(call.name);
    if (!tool) return failure(call, `There is no tool named ${call.name}.`);
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) return failure(call, `Invalid input for ${call.name}: ${z.prettifyError(parsed.error)}`);
    try {
      const output = await tool.run(parsed.data, signal);
      const content = output.length > MAX_RESULT_CHARS ? `${output.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${output.length} characters in total]` : output;
      return { result: { type: "tool_result", tool_use_id: call.id, content }, ok: true };
    } catch (err) {
      return failure(call, `${call.name} failed: ${(err as Error).message}`);
    }
  }
}

// "Error:" is in the text too: DeepSeek's Anthropic endpoint ignores is_error.
function failure(call: ToolUse, message: string): { result: ToolResult; ok: boolean } {
  return { result: { type: "tool_result", tool_use_id: call.id, content: `Error: ${message}`, is_error: true }, ok: false };
}
