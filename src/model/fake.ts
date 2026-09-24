import type { ChatMessage } from "../domain.ts";
import type { ChatModel, CompleteOptions, Completion, Usage } from "./provider.ts";

type Responder = (messages: ChatMessage[], opts: CompleteOptions) => string;

/** Deterministic test double. Records every call. Replies are labelled fake in the CLI. */
export class FakeModel implements ChatModel {
  readonly name = "fake";
  readonly vision = true;
  readonly calls: Array<{ messages: ChatMessage[]; opts: CompleteOptions }> = [];
  private readonly queue: Array<string | Responder>;

  constructor(responses: Array<string | Responder> = []) {
    this.queue = [...responses];
  }

  /** Default when the queue is empty: a fixed reply for chat, no facts for extraction. */
  static defaultResponder: Responder = (messages) =>
    String(messages[0]?.content).includes("记忆记录员")
      ? JSON.stringify({ facts: [] })
      : JSON.stringify({ bubbles: ["（假模型）收到", "这条回复不是真的模型生成的"] });

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion> {
    this.calls.push({ messages, opts });
    const next = this.queue.shift() ?? FakeModel.defaultResponder;
    const text = typeof next === "function" ? next(messages, opts) : next;
    return { text, usage: { promptTokens: 0, cacheHitTokens: 0, completionTokens: 0 }, ms: 0 };
  }

  cost(_usage: Usage): number {
    return 0;
  }
}
