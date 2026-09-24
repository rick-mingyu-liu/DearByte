// One client for every provider that speaks OpenAI's chat completions API:
// OpenAI, DeepSeek, Gemini, Qwen, Kimi, GLM, OpenRouter, Ollama and others.

import type { ChatMessage } from "../domain.ts";
import { costAt, DEFAULT_MAX_TOKENS, ModelHttpError, type ChatModel, type CompleteOptions, type Completion, type Prices, type Usage } from "./provider.ts";

/** Parameters some models reject; each is dropped (or renamed) once, then remembered. */
type Quirk = "temperature" | "max_tokens" | "response_format" | "thinking";

export class OpenAICompatibleModel implements ChatModel {
  readonly name: string;
  readonly vision: boolean;
  private readonly quirks = new Set<Quirk>();

  constructor(
    private readonly o: {
      label: string;
      name: string;
      baseUrl: string;
      apiKey: string | null;
      vision: boolean;
      prices: Prices;
      /** Fields that turn reasoning off (the provider's own names). */
      skipThinking?: Record<string, unknown>;
    },
  ) {
    this.name = o.name;
    this.vision = o.vision;
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion> {
    const started = Date.now();
    for (;;) {
      const body: Record<string, unknown> = { model: this.name, messages };
      if (opts.temperature !== undefined && !this.quirks.has("temperature")) body.temperature = opts.temperature;
      // Newer OpenAI models only accept max_completion_tokens.
      body[this.quirks.has("max_tokens") ? "max_completion_tokens" : "max_tokens"] = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
      if (opts.json && !this.quirks.has("response_format")) body.response_format = { type: "json_object" };
      if (opts.thinking === false && this.o.skipThinking && !this.quirks.has("thinking")) Object.assign(body, this.o.skipThinking);

      const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(60_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          cached_tokens?: number;
        };
        error?: { message?: string } | string;
      };
      const message = typeof json.error === "string" ? json.error : (json.error?.message ?? "");
      if (res.status === 400) {
        const quirk = rejectedParameter(message);
        if (quirk && !this.quirks.has(quirk)) {
          this.quirks.add(quirk);
          continue;
        }
      }
      if (!res.ok) throw new ModelHttpError(`${this.o.label} HTTP ${res.status}: ${message || "no error message"}`, res.status);
      const u = json.usage ?? {};
      const prompt = u.prompt_tokens ?? 0;
      // Some providers leave thinking out of completion_tokens but not out of total_tokens.
      const completion = u.completion_tokens ?? 0;
      const output = Math.max(completion, (u.total_tokens ?? 0) - prompt);
      return {
        text: stripFences(json.choices?.[0]?.message?.content ?? ""),
        usage: {
          promptTokens: prompt,
          cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0,
          completionTokens: output,
          ...(json.usage ? {} : { unreported: true }),
        },
        ms: Date.now() - started,
      };
    }
  }

  cost(usage: Usage): number {
    return costAt(this.o.prices, usage);
  }
}

/** Which of our optional parameters a 400 error complains about, if any. */
export function rejectedParameter(message: string): Quirk | null {
  // Only the "use max_completion_tokens instead" error; a range error mentioning max_tokens must not switch names.
  if (/max_completion_tokens/.test(message)) return "max_tokens";
  if (/temperature/.test(message)) return "temperature";
  if (/response_format|json_object|json mode/i.test(message)) return "response_format";
  if (/thinking/i.test(message)) return "thinking";
  return null;
}

/** Some models wrap JSON in a Markdown code fence even when asked not to. */
export function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text;
}
