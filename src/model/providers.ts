// Which providers DearByte knows, and how settings in .env become a model.
// Every provider below except Anthropic speaks OpenAI's chat completions API.

import { AnthropicModel } from "./anthropic.ts";
import { BudgetedModel } from "./budget.ts";
import { OpenAICompatibleModel } from "./openai-compatible.ts";
import type { ChatModel, Prices } from "./provider.ts";

type Preset = {
  label: string;
  /** Empty for "custom": COMPANION_BASE_URL is required. */
  baseUrl: string;
  /** Env vars checked for the key, after COMPANION_API_KEY. Empty: no key needed. */
  keyEnv: string[];
  api: "openai" | "anthropic";
  /** Whether its models usually read images; COMPANION_VISION overrides. */
  vision: boolean;
  /** Runs locally and costs nothing. */
  free?: boolean;
  defaultModel?: string;
};

export const PROVIDERS: Record<string, Preset> = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", keyEnv: ["DEEPSEEK_API_KEY"], api: "openai", vision: true, defaultModel: "deepseek-flash" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"], api: "openai", vision: true },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", keyEnv: ["ANTHROPIC_API_KEY"], api: "anthropic", vision: true },
  gemini: { label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], api: "openai", vision: true },
  qwen: { label: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyEnv: ["DASHSCOPE_API_KEY"], api: "openai", vision: false },
  moonshot: { label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", keyEnv: ["MOONSHOT_API_KEY"], api: "openai", vision: false },
  zhipu: { label: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyEnv: ["ZHIPU_API_KEY"], api: "openai", vision: false },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"], api: "openai", vision: false },
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", keyEnv: [], api: "openai", vision: false, free: true },
  custom: { label: "Custom", baseUrl: "", keyEnv: [], api: "openai", vision: false },
};

/**
 * USD per 1M tokens at peak rates for models we've checked. Anything else needs
 * COMPANION_PRICE_INPUT and COMPANION_PRICE_OUTPUT, so the per-reply cap works.
 */
const KNOWN_PRICES: Record<string, Prices & { vision?: boolean }> = {
  // https://api-docs.deepseek.com/quick_start/pricing, checked 2026-09-24. Off-peak is half.
  "deepseek/deepseek-flash": { input: 0.3, cached: 0.006, output: 1.2, vision: true },
  "deepseek/deepseek-v4-pro": { input: 1.32, cached: 0.044, output: 3.96, vision: false },
};

export type ModelSettings = {
  provider: string;
  label: string;
  api: "openai" | "anthropic";
  model: string;
  baseUrl: string;
  apiKey: string | null;
  vision: boolean;
  prices: Prices;
  /** USD per reply and everything it sets off; 0 turns the cap off. */
  maxCostPerReply: number;
};

/** Reads the model settings from env; returns what's wrong instead when they're incomplete. */
export function resolveModel(env: Record<string, string | undefined>): ModelSettings | { problem: string } {
  const provider = (env.COMPANION_PROVIDER || "deepseek").toLowerCase();
  const preset = PROVIDERS[provider];
  if (!preset) return { problem: `不认识 COMPANION_PROVIDER=${provider}。可选：${Object.keys(PROVIDERS).join("、")}` };

  const model = env.COMPANION_MODEL || (provider === "deepseek" ? env.DEEPSEEK_MODEL : undefined) || preset.defaultModel;
  if (!model) return { problem: `用 ${preset.label} 要写明模型：COMPANION_MODEL=…（模型名见服务商文档）` };

  const baseUrl = env.COMPANION_BASE_URL || preset.baseUrl;
  if (!baseUrl) return { problem: "custom 服务商要写 COMPANION_BASE_URL（OpenAI 兼容接口的地址，比如 https://…/v1）" };

  const keyNames = ["COMPANION_API_KEY", ...preset.keyEnv];
  const apiKey = keyNames.map((k) => env[k]).find(Boolean) ?? null;
  if (!apiKey && preset.keyEnv.length) return { problem: `缺少 API 密钥：在 .env 里写 ${preset.keyEnv[0]}=…（或 COMPANION_API_KEY）` };
  if (!apiKey && preset.api === "anthropic") return { problem: "缺少 ANTHROPIC_API_KEY" };

  const known = KNOWN_PRICES[`${provider}/${model}`];
  const input = price(env.COMPANION_PRICE_INPUT);
  const output = price(env.COMPANION_PRICE_OUTPUT);
  if ((input === null) !== (output === null)) return { problem: "COMPANION_PRICE_INPUT 和 COMPANION_PRICE_OUTPUT 要一起写" };
  let prices: Prices;
  if (input !== null && output !== null) prices = { input, output, cached: price(env.COMPANION_PRICE_CACHED) ?? input };
  else if (known) prices = { input: known.input, cached: known.cached, output: known.output };
  else if (preset.free) prices = { input: 0, cached: 0, output: 0 };
  else {
    return {
      problem:
        `不知道 ${model} 的价格，没法限制每条回复的花费。在 .env 里写上服务商公布的价格（美元 / 百万 token）：` +
        "COMPANION_PRICE_INPUT=… 和 COMPANION_PRICE_OUTPUT=…（有缓存价的话再加 COMPANION_PRICE_CACHED=…）",
    };
  }

  // Blank or invalid falls back to $1; only an explicit 0 turns the cap off.
  const cap = price(env.COMPANION_MAX_COST_PER_REPLY) ?? 1;
  const vision = env.COMPANION_VISION
    ? /^(1|true|yes|on)$/i.test(env.COMPANION_VISION)
    : (known?.vision ?? guessVision(model) ?? preset.vision);
  return {
    provider,
    label: preset.label,
    api: preset.api,
    model,
    baseUrl,
    apiKey,
    vision,
    prices,
    maxCostPerReply: cap,
  };
}

/** Names that say a model is text-only; checked first, so "qwen-coder-vl" style oddities stay text-only. */
const TEXT_ONLY = /embed|whisper|tts|rerank|gpt-3\.5|o1-mini|o3-mini|deepseek-(chat|reasoner|coder)|qwq|coder/i;
/** Names of model families that read images, as providers and OpenRouter spell them. */
const READS_IMAGES =
  /(^|[-_/.:])vl([-_/.:]|$)|vision|omni|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4o|claude|gemini|gemma-?3|pixtral|llava|minicpm-v|moondream|internvl|qvq|glm-[\d.]+v|llama-?4|llama-?3\.2-\d+b-vision/i;

/**
 * Whether a model reads images, guessed from its name; null when the name says
 * nothing, so the provider's default applies. COMPANION_VISION overrides.
 */
export function guessVision(model: string): boolean | null {
  if (TEXT_ONLY.test(model)) return false;
  if (READS_IMAGES.test(model)) return true;
  return null;
}

function price(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The model for these settings, wrapped in the per-reply spending cap. */
export function createModel(s: ModelSettings): ChatModel {
  const inner =
    s.api === "anthropic"
      ? new AnthropicModel({ name: s.model, baseUrl: s.baseUrl, apiKey: s.apiKey!, vision: s.vision, prices: s.prices })
      : new OpenAICompatibleModel({ label: s.label, name: s.model, baseUrl: s.baseUrl, apiKey: s.apiKey, vision: s.vision, prices: s.prices });
  return new BudgetedModel(inner, s.prices, s.maxCostPerReply);
}
