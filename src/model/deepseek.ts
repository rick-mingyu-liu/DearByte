import type { ChatMessage } from "../domain.ts";
import type { ChatModel, CompleteOptions, Completion, Usage } from "./provider.ts";

// USD per 1M tokens at peak rates (off-peak is half). Checked 2026-09-24:
// https://api-docs.deepseek.com/quick_start/pricing
const MODELS: Record<string, { hit: number; miss: number; out: number; vision: boolean }> = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2, vision: true },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96, vision: false },
};

export class DeepSeekModel implements ChatModel {
  readonly vision: boolean;

  constructor(
    private readonly apiKey: string,
    readonly name = "deepseek-flash",
    private readonly baseUrl = "https://api.deepseek.com",
  ) {
    const info = MODELS[name];
    if (!info) throw new Error(`Unknown DeepSeek model ${name}; add its pricing to src/model/deepseek.ts`);
    this.vision = info.vision;
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.name,
        messages,
        temperature: opts.temperature ?? 1.0,
        max_tokens: opts.maxTokens ?? 800,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
      };
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${body.error?.message ?? "no error message"}`);
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        cacheHitTokens: body.usage?.prompt_cache_hit_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      },
      ms: Date.now() - started,
    };
  }

  cost(usage: Usage): number {
    const p = MODELS[this.name];
    const miss = usage.promptTokens - usage.cacheHitTokens;
    return (usage.cacheHitTokens * p.hit + miss * p.miss + usage.completionTokens * p.out) / 1e6;
  }
}
