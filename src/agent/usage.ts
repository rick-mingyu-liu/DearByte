// Every agent model call is logged with its tokens and cost, and a weekly cap
// stops new calls once the last 7 days' spend reaches it. The cap is checked
// before each call, so a week can end at most one call over it.

import type { AgentModel, AgentRequest, AgentStep } from "./model.ts";
import type { Store } from "../storage/store.ts";
import type { Usage } from "../model/provider.ts";

export class WeeklyCapReached extends Error {}

export const WEEK_MS = 7 * 86_400_000;
/** USD over the last 7 days; DEARBYTE_WEEKLY_CAP overrides, 0 turns the cap off. */
export const DEFAULT_WEEKLY_CAP = 5;

export type UsageStore = Pick<Store, "recordAgentUsage" | "agentSpendSince">;

export class MeteredAgentModel implements AgentModel {
  readonly name: string;

  constructor(
    private readonly inner: AgentModel,
    private readonly o: { tier: string; store: UsageStore; weeklyCap: number; now?: () => Date },
  ) {
    this.name = inner.name;
  }

  async step(req: AgentRequest): Promise<AgentStep> {
    const now = this.o.now ?? (() => new Date());
    if (this.o.weeklyCap > 0) {
      const spent = this.o.store.agentSpendSince(new Date(now().getTime() - WEEK_MS).toISOString());
      if (spent >= this.o.weeklyCap) {
        throw new WeeklyCapReached(`$${spent.toFixed(2)} spent in the last 7 days, at or over the weekly cap of $${this.o.weeklyCap}`);
      }
    }
    const step = await this.inner.step(req);
    this.o.store.recordAgentUsage({
      at: now().toISOString(),
      purpose: req.purpose ?? "other",
      tier: this.o.tier,
      model: step.model,
      promptTokens: step.usage.promptTokens,
      cacheHitTokens: step.usage.cacheHitTokens,
      cacheWriteTokens: step.usage.cacheWriteTokens ?? 0,
      completionTokens: step.usage.completionTokens,
      cost: this.inner.cost(step.usage),
      ms: step.ms,
    });
    return step;
  }

  cost(usage: Usage): number | null {
    return this.inner.cost(usage);
  }
}
