// Claude through Anthropic's Messages API, which differs from OpenAI's: the
// system prompt is separate, images are base64 blocks, and there's no JSON mode.

import type { ChatMessage, ContentPart } from "../domain.ts";
import { rejectedParameter, stripFences } from "./openai-compatible.ts";
import { costAt, DEFAULT_MAX_TOKENS, ModelHttpError, type ChatModel, type CompleteOptions, type Completion, type Prices, type Usage } from "./provider.ts";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } };

export class AnthropicModel implements ChatModel {
  readonly name: string;
  readonly vision: boolean;
  private noTemperature = false;

  constructor(private readonly o: { name: string; baseUrl: string; apiKey: string; vision: boolean; prices: Prices }) {
    this.name = o.name;
    this.vision = o.vision;
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion> {
    const started = Date.now();
    const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(toBlock) }));
    // The history window can start on one of 小拜's messages; the Messages API wants a user turn first.
    if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "（聊天记录从这里开始）" });
    for (;;) {
      const body: Record<string, unknown> = {
        model: this.name,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        // The persona and examples come first and rarely change, so cache them.
        ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
        messages: turns,
      };
      if (opts.temperature !== undefined && !this.noTemperature) body.temperature = opts.temperature;
      const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.o.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(60_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        error?: { message?: string };
      };
      const message = json.error?.message ?? "";
      if (res.status === 400 && !this.noTemperature && rejectedParameter(message) === "temperature") {
        this.noTemperature = true;
        continue;
      }
      if (!res.ok) throw new ModelHttpError(`Anthropic HTTP ${res.status}: ${message || "no error message"}`, res.status);
      const u = json.usage ?? {};
      const read = u.cache_read_input_tokens ?? 0;
      const write = u.cache_creation_input_tokens ?? 0;
      return {
        text: stripFences((json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")),
        usage: { promptTokens: (u.input_tokens ?? 0) + read + write, cacheHitTokens: read, cacheWriteTokens: write, completionTokens: u.output_tokens ?? 0, ...(json.usage ? {} : { unreported: true }) },
        ms: Date.now() - started,
      };
    }
  }

  cost(usage: Usage): number {
    return costAt(this.o.prices, usage);
  }
}

function textOf(content: string | ContentPart[]): string {
  return typeof content === "string" ? content : content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Our messages carry images as data URLs, OpenAI-style. */
export function toBlock(part: ContentPart): Block {
  if (part.type === "text") return { type: "text", text: part.text };
  const m = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url: part.image_url.url } };
}
