// The model behind DearByte's agent. ChatModel (src/model/) is text in, text
// out, which is all a chat reply needs. An agent step also has to return tool
// calls, so it works in content blocks: tool_use blocks come back as they
// are, and the loop answers them with tool_result blocks.
//
// Every agent provider speaks Anthropic's Messages format through the same
// SDK: Claude natively, DeepSeek through its Anthropic-compatible endpoint.
// So one class serves both; the provider decides the address and which
// Claude-only features to send.

import Anthropic from "@anthropic-ai/sdk";
import { costAt, type Prices, type Usage } from "../model/provider.ts";
import { KNOWN_PRICES } from "../model/providers.ts";

export type AgentMessage = Anthropic.Beta.BetaMessageParam;
export type AgentTool = Anthropic.Beta.BetaTool;
export type AgentBlock = Anthropic.Beta.BetaContentBlock;
export type AgentStopReason = Anthropic.Beta.BetaStopReason;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

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

/** Room for thinking plus a tool call or an answer. Streaming keeps large caps safe from HTTP timeouts. */
export const DEFAULT_AGENT_MAX_TOKENS = 16_000;

export type AgentProvider = "anthropic" | "deepseek";

type ProviderPreset = {
  /** Undefined: the SDK's default, Anthropic's API. */
  baseURL?: string;
  keyEnv: string;
  /** Claude-only: re-run a request a safety classifier declined on the model Anthropic picks for it. */
  fallbacks: boolean;
  /** Claude-only: adaptive thinking. DeepSeek thinks by default and ignores thinking budgets. */
  adaptiveThinking: boolean;
};

export const AGENT_PROVIDERS: Record<AgentProvider, ProviderPreset> = {
  anthropic: { keyEnv: "ANTHROPIC_API_KEY", fallbacks: true, adaptiveThinking: true },
  // https://api-docs.deepseek.com/guides/anthropic_api: tools, tool_use/tool_result and thinking
  // blocks are supported; beta headers and cache_control are ignored. An unknown model name is
  // silently mapped to deepseek-flash, so a typo still answers: check AgentStep.model.
  deepseek: { baseURL: "https://api.deepseek.com/anthropic", keyEnv: "DEEPSEEK_API_KEY", fallbacks: false, adaptiveThinking: false },
};

/** USD per 1M tokens: Anthropic list prices, cache reads at 0.1× input. Recheck when adding a model. */
const CLAUDE_PRICES: Record<string, Prices> = {
  "claude-opus-5-5": { input: 4, cached: 0.4, output: 20 },
  "claude-opus-5": { input: 5, cached: 0.5, output: 25 },
  // Where "default" fallbacks send cyber-category refusals.
  "claude-opus-4-8": { input: 5, cached: 0.5, output: 25 },
};

export function agentPrices(provider: AgentProvider, model: string): Prices | null {
  if (provider === "anthropic") return CLAUDE_PRICES[model] ?? null;
  const known = KNOWN_PRICES[`${provider}/${model}`];
  return known ? { input: known.input, cached: known.cached, output: known.output } : null;
}

/** Server-side fallbacks, "default" form: Anthropic picks the fallback model by refusal category. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type StreamingClient = Pick<Anthropic, "beta">;

export class MessagesAgentModel implements AgentModel {
  readonly name: string;
  readonly provider: AgentProvider;
  private readonly client: StreamingClient;
  private readonly preset: ProviderPreset;
  private readonly effort: Effort | undefined;

  constructor(o: { provider: AgentProvider; model: string; apiKey?: string; effort?: Effort; client?: StreamingClient }) {
    this.provider = o.provider;
    this.name = o.model;
    this.preset = AGENT_PROVIDERS[o.provider];
    this.effort = o.effort;
    // Anthropic with no key given: the SDK finds ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = o.client ?? new Anthropic({ ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(this.preset.baseURL ? { baseURL: this.preset.baseURL } : {}) });
  }

  async step(req: AgentRequest): Promise<AgentStep> {
    const started = Date.now();
    const { fallbacks, adaptiveThinking } = this.preset;
    const stream = this.client.beta.messages.stream(
      {
        model: this.name,
        max_tokens: req.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS,
        // The system prompt and tool list rarely change, so cache everything up to them.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: req.messages,
        ...(adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
        ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
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
    const prices = agentPrices(this.provider, this.name);
    return prices ? costAt(prices, usage) : null;
  }
}
