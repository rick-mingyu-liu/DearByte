// Which model does which kind of work. The "brain" makes the calls a person
// would notice: health cautions, news analysis, anything about money. The
// "worker" does repetitive work that is easy to check: filtering, summaries.
// Each is "provider:model" in .env. Both default to DeepSeek so building and
// testing stay cheap; point the brain at Claude for real use:
//
//   DEARBYTE_BRAIN=anthropic:claude-opus-5-5
//   DEARBYTE_BRAIN_EFFORT=high
//   DEARBYTE_WORKER=deepseek:deepseek-flash

import { AGENT_PROVIDERS, agentPrices, MessagesAgentModel, type AgentModel, type AgentProvider, type Effort } from "./model.ts";
import { MeteredAgentModel, type UsageStore } from "./usage.ts";

export const TIERS = ["brain", "worker"] as const;
export type Tier = (typeof TIERS)[number];

export type TierSettings = { provider: AgentProvider; model: string; apiKey?: string; effort?: Effort };

const DEFAULT_TIER = "deepseek:deepseek-flash";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Reads both tiers from env; returns what's wrong instead when a setting is incomplete. */
export function resolveTiers(env: Record<string, string | undefined>): Record<Tier, TierSettings> | { problem: string } {
  const out = {} as Record<Tier, TierSettings>;
  for (const tier of TIERS) {
    const name = `DEARBYTE_${tier.toUpperCase()}`;
    const [provider, ...rest] = (env[name] || DEFAULT_TIER).split(":");
    const model = rest.join(":");
    if (!(provider in AGENT_PROVIDERS) || !model) {
      return { problem: `${name} should be provider:model, with provider one of ${Object.keys(AGENT_PROVIDERS).join(", ")}` };
    }
    const p = provider as AgentProvider;
    // Without known prices the spending cap can't work, so refuse rather than guess.
    if (!agentPrices(p, model)) return { problem: `${name}: no known price for ${provider}:${model}; add it to the price table first` };
    const apiKey = env[AGENT_PROVIDERS[p].keyEnv] || undefined;
    // Anthropic's SDK can also find an `ant auth login` profile; DeepSeek needs its key.
    if (!apiKey && p !== "anthropic") return { problem: `${name} uses ${provider}: set ${AGENT_PROVIDERS[p].keyEnv} in .env` };
    const effortValue = env[`${name}_EFFORT`];
    if (effortValue && !EFFORTS.includes(effortValue as Effort)) return { problem: `${name}_EFFORT should be one of ${EFFORTS.join(", ")}` };
    out[tier] = { provider: p, model, ...(apiKey ? { apiKey } : {}), ...(effortValue ? { effort: effortValue as Effort } : {}) };
  }
  return out;
}

/** Both tier models; with `meter`, every call is logged and the weekly cap applies. */
export function createTierModels(settings: Record<Tier, TierSettings>, meter?: { store: UsageStore; weeklyCap: number }): Record<Tier, AgentModel> {
  const make = (tier: Tier): AgentModel => {
    const model = new MessagesAgentModel(settings[tier]);
    return meter ? new MeteredAgentModel(model, { tier, ...meter }) : model;
  };
  return { brain: make("brain"), worker: make("worker") };
}
