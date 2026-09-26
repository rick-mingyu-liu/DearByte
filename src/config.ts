import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTiers, type Tier, type TierSettings } from "./agent/tiers.ts";
import { DEFAULT_WEEKLY_CAP } from "./agent/usage.ts";
import { PERSONAS, type Persona } from "./agent/persona.ts";
import { resolveModel, type ModelSettings } from "./model/providers.ts";

export const ROOT = new URL("..", import.meta.url).pathname;

export type Config = {
  /** Which provider, model, key and prices; or what's missing from .env. */
  model: ModelSettings | { problem: string };
  /** The agent's brain and worker models; or what's missing from .env. */
  agent: Record<Tier, TierSettings> | { problem: string };
  /** USD the agent may spend over any 7 days (0 turns the cap off). */
  agentWeeklyCap: number;
  /** The dearbyte-bridge MCP address (it contains a secret), or null when health data isn't set up. */
  healthMcpUrl: string | null;
  /** Telegram for alerts and approvals: null when not set up; chatId is null until the setup step finds it. */
  telegram: { token: string; chatId: number | null } | { problem: string } | null;
  /** The agent's persona, or what's wrong with DEARBYTE_PERSONA. */
  agentPersona: Persona | { problem: string };
  dbPath: string;
  timeZone: string;
  historyMessages: number;
  /** Chat history older than this many days is deleted (0 keeps it all). */
  historyDays: number;
  /** Folder where WeChat for Mac saves photos received in 小拜's chat. */
  wechatMediaDir: string | null;
  /** Optional push URL (e.g. https://ntfy.sh/<topic>) for alerts when 小拜 gets stuck. */
  alertUrl: string | null;
};

// Minimal .env reader: KEY=value lines, optional quotes. Real env vars win.
function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** A number ≥ 0 from the environment, or the default when it's missing or not a number. */
function nonNegative(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = { ...readDotEnv(join(ROOT, ".env")), ...env };
  return {
    model: resolveModel(merged),
    agent: resolveTiers(merged),
    agentWeeklyCap: nonNegative(merged.DEARBYTE_WEEKLY_CAP, DEFAULT_WEEKLY_CAP),
    agentPersona: resolvePersona(merged.DEARBYTE_PERSONA),
    healthMcpUrl: merged.HEALTH_MCP_URL?.trim() || null,
    telegram: resolveTelegram(merged.TELEGRAM_BOT_TOKEN, merged.TELEGRAM_CHAT_ID),
    dbPath: merged.COMPANION_DB || join(ROOT, "data/companion.sqlite"),
    timeZone: merged.COMPANION_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    historyMessages: Number(merged.COMPANION_HISTORY_MESSAGES || 40),
    historyDays: nonNegative(merged.COMPANION_HISTORY_DAYS, 30),
    wechatMediaDir: merged.COMPANION_WECHAT_MEDIA_DIR || null,
    alertUrl: merged.COMPANION_ALERT_URL || null,
  };
}

function resolveTelegram(token: string | undefined, chat: string | undefined): Config["telegram"] {
  token = token?.trim();
  chat = chat?.trim();
  if (!token) return chat ? { problem: "TELEGRAM_CHAT_ID is set but TELEGRAM_BOT_TOKEN isn't" } : null;
  if (!/^\d+:[\w-]{30,}$/.test(token)) return { problem: "TELEGRAM_BOT_TOKEN doesn't look like a bot token (it should be like 123456:ABC..., from @BotFather)" };
  if (!chat) return { token, chatId: null };
  return /^-?\d+$/.test(chat) ? { token, chatId: Number(chat) } : { problem: "TELEGRAM_CHAT_ID should be a number (npm run agent -- telegram finds it)" };
}

function resolvePersona(value: string | undefined): Persona | { problem: string } {
  const name = (value || "default").trim().toLowerCase();
  return (PERSONAS as readonly string[]).includes(name) ? (name as Persona) : { problem: `DEARBYTE_PERSONA should be one of ${PERSONAS.join(", ")}` };
}
