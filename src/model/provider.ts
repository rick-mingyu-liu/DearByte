import type { ChatMessage } from "../domain.ts";

export type Usage = {
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  /** Input tokens written to the provider's prompt cache (Anthropic bills them at 1.25× input). */
  cacheWriteTokens?: number;
  /** The provider sent no usage, so the real cost is unknown. */
  unreported?: boolean;
};

export type Completion = { text: string; usage: Usage; ms: number };

export type CompleteOptions = {
  json: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

/** Output cap when a caller doesn't set one. Reasoning models count their hidden thinking here. */
export const DEFAULT_MAX_TOKENS = 2_000;

export interface ChatModel {
  readonly name: string;
  readonly vision: boolean;
  complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion>;
  /** USD for this usage at peak rates, or null when unknown. */
  cost(usage: Usage): number | null;
}

/** A provider's HTTP error. A 4xx means the request was refused before any output, so it isn't billed. */
export class ModelHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** USD per 1M tokens. `cached` is the price of a prompt-cache hit. */
export type Prices = { input: number; cached: number; output: number };

export function costAt(prices: Prices, usage: Usage): number {
  const write = usage.cacheWriteTokens ?? 0;
  const miss = Math.max(0, usage.promptTokens - usage.cacheHitTokens - write);
  return (miss * prices.input + usage.cacheHitTokens * prices.cached + write * prices.input * 1.25 + usage.completionTokens * prices.output) / 1e6;
}
