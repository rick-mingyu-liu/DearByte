// The model behind DearByte's agent. ChatModel (src/model/) is text in, text
// out, which is all a chat reply needs. An agent step also has to return tool
// calls, so it works in content blocks: Claude's tool_use blocks come back as
// they are, and the loop answers them with tool_result blocks.

import Anthropic from "@anthropic-ai/sdk";
import { costAt, type Prices, type Usage } from "../model/provider.ts";

export type AgentMessage = Anthropic.Beta.BetaMessageParam;
export type AgentTool = Anthropic.Beta.BetaTool;
export type AgentBlock = Anthropic.Beta.BetaContentBlock;
export type AgentStopReason = Anthropic.Beta.BetaStopReason;

export type AgentRequest = {
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  maxTokens?: number;
  signal?: AbortSignal;
};

export type AgentStep = {
  content: AgentBlock[];
  /** null only if the stream ended without one; treat it like a refusal, never run its tools. */
  stopReason: AgentStopReason | null;
  /** Which model answered: differs from the requested one when a fallback took over. */
  model: string;
  usage: Usage;
  ms: number;
};

export interface AgentModel {
  readonly name: string;
  step(req: AgentRequest): Promise<AgentStep>;
  /** USD for this usage, or null when unknown. */
  cost(usage: Usage): number | null;
}

export const DEFAULT_AGENT_MODEL = "claude-opus-5";
/** Room for thinking plus a tool call or an answer. Streaming keeps large caps safe from HTTP timeouts. */
export const DEFAULT_AGENT_MAX_TOKENS = 16_000;

/** USD per 1M tokens: Anthropic list prices, cache reads at 0.1× input. Recheck when adding a model. */
export const AGENT_PRICES: Record<string, Prices> = {
  "claude-opus-5": { input: 5, cached: 0.5, output: 25 },
  // Where "default" fallbacks send cyber-category refusals; same price as Opus 5.
  "claude-opus-4-8": { input: 5, cached: 0.5, output: 25 },
};

/** Server-side fallbacks: a declined request is re-run on the model Anthropic picks for that category. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type StreamingClient = Pick<Anthropic, "beta">;

export class ClaudeAgentModel implements AgentModel {
  readonly name: string;
  private readonly client: StreamingClient;

  constructor(o: { model?: string; apiKey?: string; client?: StreamingClient } = {}) {
    this.name = o.model ?? DEFAULT_AGENT_MODEL;
    // No key given: the SDK finds ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = o.client ?? new Anthropic(o.apiKey ? { apiKey: o.apiKey } : {});
  }

  async step(req: AgentRequest): Promise<AgentStep> {
    const started = Date.now();
    const stream = this.client.beta.messages.stream(
      {
        model: this.name,
        max_tokens: req.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS,
        thinking: { type: "adaptive" },
        // The system prompt and tool list rarely change, so cache everything up to them.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: req.messages,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      },
      { signal: req.signal },
    );
    const message = await stream.finalMessage();
    const u = message.usage;
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    return {
      content: message.content,
      stopReason: message.stop_reason,
      model: message.model,
      usage: { promptTokens: u.input_tokens + read + write, cacheHitTokens: read, cacheWriteTokens: write, completionTokens: u.output_tokens },
      ms: Date.now() - started,
    };
  }

  cost(usage: Usage): number | null {
    const prices = AGENT_PRICES[this.name];
    return prices ? costAt(prices, usage) : null;
  }
}
