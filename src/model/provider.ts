import type { ChatMessage } from "../domain.ts";

export type Usage = { promptTokens: number; cacheHitTokens: number; completionTokens: number };

export type Completion = { text: string; usage: Usage; ms: number };

export type CompleteOptions = {
  json: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export interface ChatModel {
  readonly name: string;
  readonly vision: boolean;
  complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion>;
  /** USD for this usage at peak rates, or null when unknown. */
  cost(usage: Usage): number | null;
}
