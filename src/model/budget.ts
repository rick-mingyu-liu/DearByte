// A spending cap for each reply. Everything one reply sets off (the reply, a
// repair, the crisis check, memory, the summary) shares one tab. Before each
// call the worst case is reserved: the input estimate plus the full output
// cap. A call that can't fit gets a smaller output cap, or isn't made.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatMessage } from "../domain.ts";
import { DEFAULT_MAX_TOKENS, ModelHttpError, type ChatModel, type CompleteOptions, type Completion, type Prices, type Usage } from "./provider.ts";

export class BudgetExceeded extends Error {}

type Tab = { spent: number; reserved: number };
const tabs = new AsyncLocalStorage<Tab>();

/** Runs `fn` as one reply: every model call inside it, even later background ones, shares one budget. */
export function withTurnBudget<T>(fn: () => Promise<T>): Promise<T> {
  return tabs.run({ spent: 0, reserved: 0 }, fn);
}

/** Below this many output tokens a reply can't be useful, so the call isn't made. */
const MIN_OUTPUT_TOKENS = 200;
/** Generous on purpose: most models spend fewer tokens than characters, even in Chinese. */
const TOKENS_PER_CHAR = 1;
const TOKENS_PER_IMAGE = 3_000;

export function estimateInputTokens(messages: ChatMessage[]): number {
  let tokens = 0;
  for (const m of messages) {
    if (typeof m.content === "string") tokens += m.content.length * TOKENS_PER_CHAR;
    else for (const p of m.content) tokens += p.type === "text" ? p.text.length * TOKENS_PER_CHAR : TOKENS_PER_IMAGE;
  }
  return tokens + 10 * messages.length;
}

export class BudgetedModel implements ChatModel {
  readonly name: string;
  readonly vision: boolean;

  constructor(
    private readonly inner: ChatModel,
    private readonly prices: Prices,
    /** USD for one reply and everything it sets off; 0 turns the cap off. */
    readonly limit: number,
  ) {
    this.name = inner.name;
    this.vision = inner.vision;
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions): Promise<Completion> {
    if (!(this.limit > 0)) return this.inner.complete(messages, opts);
    // Outside a reply (the bake-off, a one-off call), each call is its own budget.
    const tab = tabs.getStore() ?? { spent: 0, reserved: 0 };
    const left = this.limit - tab.spent - tab.reserved;
    const inputCost = (estimateInputTokens(messages) * this.prices.input) / 1e6;
    const wanted = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const affordable =
      this.prices.output > 0 ? Math.floor(((left - inputCost) * 1e6) / this.prices.output) : inputCost > left ? 0 : wanted;
    const maxTokens = Math.min(wanted, affordable);
    if (maxTokens < MIN_OUTPUT_TOKENS) {
      const used = tab.spent + tab.reserved;
      throw new BudgetExceeded(
        used > 0
          ? `这条回复已经用了 $${used.toFixed(4)}，再调用可能超过上限 $${this.limit}，停下了`
          : `这次调用最坏要花 $${(inputCost + (MIN_OUTPUT_TOKENS * this.prices.output) / 1e6).toFixed(4)} 以上，超过每条回复的上限 $${this.limit}`,
      );
    }
    const reserve = inputCost + (maxTokens * this.prices.output) / 1e6;
    tab.reserved += reserve;
    try {
      const completion = await this.inner.complete(messages, { ...opts, maxTokens });
      // No usage reported: assume the worst case rather than free.
      tab.spent += (completion.usage.unreported ? null : this.inner.cost(completion.usage)) ?? reserve;
      return completion;
    } catch (err) {
      // A timeout, an abort or a 5xx may still have been billed. Only a 4xx refusal is known to be free.
      const refused = err instanceof ModelHttpError && err.status >= 400 && err.status < 500;
      if (!refused) tab.spent += reserve;
      throw err;
    } finally {
      tab.reserved -= reserve;
    }
  }

  cost(usage: Usage): number | null {
    return this.inner.cost(usage);
  }
}
