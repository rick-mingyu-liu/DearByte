import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname;

export type Config = {
  apiKey: string | null;
  model: string;
  dbPath: string;
  timeZone: string;
  historyMessages: number;
  /** Folder where WeChat for Mac saves photos received in 小拜's chat. */
  wechatMediaDir: string | null;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = { ...readDotEnv(join(ROOT, ".env")), ...env };
  return {
    apiKey: merged.DEEPSEEK_API_KEY || null,
    model: merged.DEEPSEEK_MODEL || "deepseek-flash",
    dbPath: merged.COMPANION_DB || join(ROOT, "data/companion.sqlite"),
    timeZone: merged.COMPANION_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    historyMessages: Number(merged.COMPANION_HISTORY_MESSAGES || 40),
    wechatMediaDir: merged.COMPANION_WECHAT_MEDIA_DIR || null,
  };
}
