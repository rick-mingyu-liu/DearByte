// The filming log (--film): only what a viewer should see on screen. Who said
// what, when 小拜 writes first, and what it remembers. No tokens, costs or
// diagnostics; alerts still reach the operator by notification.

import type { DesktopEvent } from "./channels/desktop/channel.ts";
import type { CompanionEvent } from "./companion/companion.ts";

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = color(2);
const pink = color(95);
const cyan = color(96);
const gold = color(93);

const clock = (now: Date) => dim(now.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }));

/** "用户周五有面试" → "Rick 周五有面试". Facts are stored about 「用户」. */
export function aboutName(value: string, name: string): string {
  if (!value.startsWith("用户")) return value;
  const rest = value.slice(2);
  return /[A-Za-z0-9]$/.test(name) && /^[A-Za-z0-9]/.test(rest) ? `${name} ${rest}` : `${name}${/^[A-Za-z]/.test(name) ? " " : ""}${rest}`;
}

const OPENERS: Record<string, string> = {
  morning: "☀️ 小拜主动来说早安",
  event_am: "✨ 小拜来给你打气",
  event_pm: "✨ 小拜来问问结果",
  checkin: "✨ 小拜来找你了",
  thinking: "💭 小拜想你了",
};

export function filmChannelLine(e: DesktopEvent, name: string, now = new Date()): string | null {
  const t = clock(now);
  switch (e.type) {
    case "inbound": {
      const text = [e.text, e.image ? "📷" : ""].filter(Boolean).join(" ") || "📷";
      return `${t}  💬 ${cyan(name)}：${text}\n${t}  ${dim("💭 小拜在想……")}`;
    }
    case "sent":
      return `${t}  💌 ${pink("小拜")}：${e.bubble}`;
    case "drafted":
      return `${t}  📝 ${pink("小拜")}（草稿）：${e.bubble}`;
    case "initiated":
      return `${t}  ${OPENERS[e.reason.split(":")[0]] ?? "✨ 小拜主动找你"}`;
    case "status":
      return e.message.startsWith("已连接") ? `${t}  ✅ 小拜上线了` : null;
    default:
      return null;
  }
}

export function filmCompanionLine(e: CompanionEvent, name: string, now = new Date()): string | null {
  if (e.type !== "memory") return null;
  const changed = e.outcome.results.filter((r) => r.result === "inserted" || r.result === "updated");
  if (!changed.length) return null;
  return changed.map((r) => `${clock(now)}  🧠 ${gold(`记住了：${aboutName(r.value, name)}`)}`).join("\n");
}
