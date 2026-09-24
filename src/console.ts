// Terminal helpers shared by the simulator (cli.ts) and the WeChat runner (wechat.ts).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplyEvent } from "./channels/reply-loop.ts";
import type { CompanionEvent } from "./companion/companion.ts";
import { localDate } from "./companion/time.ts";
import { ROOT } from "./config.ts";
import type { ModelSettings } from "./model/providers.ts";
import type { Store } from "./storage/store.ts";

export const COMMON_HELP = `  /memory               列出记得的事
  /memory on | off      开启 / 关闭长期记忆
  /memory forget <id>   删除一条记忆（更早聊天的摘要也一起清掉）
  /memory export        导出记忆到 data/memory-export.md
  /history clear        清空聊天记录（记忆保留）
  /status               当前状态
  /help                 显示帮助
  /quit                 退出`;

export const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
export const time = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
export const log = (s: string) => console.log(dim(`${time()}  ${s}`));
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function describeEvent(e: CompanionEvent): string | null {
  switch (e.type) {
    case "context":
      return `上下文 · ${e.historyMessages} 条历史 · 记忆${e.memoryEnabled ? ` ${e.facts} 条` : "关闭"}${e.image ? " · 含图片" : ""}${e.crisis ? " · 安全模式" : ""}`;
    case "model": {
      const cost = e.cost === null ? "" : ` · $${e.cost.toFixed(5)}`;
      const label = { reply: "生成回复", repair: "修正格式", memory: "整理记忆", safety: "安全检查" }[e.purpose];
      return `${label} · ${(e.ms / 1000).toFixed(1)}s · ${e.promptTokens} 入（${e.cacheHitTokens} 缓存）/ ${e.completionTokens} 出${cost}`;
    }
    case "reply_invalid":
      return `回复格式不合规（${e.problems.join("；")}）→ ${{ repair: "重试一次", salvage: "截断使用", fallback: "使用兜底回复" }[e.action]}`;
    case "crisis_detected":
      return "模型判断这条消息可能有安全风险（关键词没抓到）→ 用安全模式重写了回复";
    case "reply_trimmed":
      return `超过 2 条，删掉了：${e.dropped.join(" / ")}`;
    case "memory": {
      const changed = e.outcome.results.filter((r) => r.result === "inserted" || r.result === "updated");
      const parts = [
        ...changed.map((r) => `${r.result === "inserted" ? "+" : "~"} ${r.value}`),
        ...e.outcome.results.filter((r) => r.result === "blocked").map((r) => `已删除的 ${r.key} 不再记录`),
        ...e.outcome.rejected.map((r) => `拒绝 ${r.key}：${r.reason}`),
      ];
      return parts.length ? `记忆 · ${parts.join(" · ")}` : null;
    }
    case "memory_error":
      return `记忆整理失败（不影响回复）：${e.message}`;
    case "summary":
      return `更早的 ${e.outcome.folded} 条聊天并进了摘要（${e.outcome.chars} 字）`;
  }
}

/** Log line for a WeChat reply-loop event (null when there's nothing to show). */
export function describeReplyEvent(e: ReplyEvent): string | null {
  switch (e.type) {
    case "inbound":
      return `微信 › ${e.text || "（无文字）"}${e.image ? " [图片]" : ""}${e.merged > 1 ? dim(`（${e.merged} 条合并为一轮）`) : ""}`;
    case "sent":
      return `小拜 › ${e.bubble}`;
    case "drafted":
      return `小拜（草稿，未发送）› ${e.bubble}`;
    case "turn":
      return null;
    case "initiated":
      return `小拜主动发消息：${e.reason}`;
    case "error":
      return `出错：${e.message}`;
  }
}

export function exportMemory(store: Store, timeZone: string): string {
  const facts = store.activeFacts();
  const lines = [
    "# 小拜记得的事",
    "",
    `导出于 ${localDate(new Date(), timeZone)} · 共 ${facts.length} 条`,
    "",
    ...facts.map(
      (f) => `- **${f.value}**${f.eventDate ? `（${f.eventDate}）` : ""}\n  - 原话：「${f.evidence}」 · ${f.category} · #${f.id}`,
    ),
  ];
  const path = join(ROOT, "data/memory-export.md");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/**
 * Runs a /memory or /history command. Returns false if `line` isn't one.
 * `settle` waits for background memory work so listings include the latest turn.
 */
export async function runSharedCommand(line: string, ctx: { store: Store; timeZone: string; settle: () => Promise<unknown> }): Promise<boolean> {
  const { store } = ctx;
  const [command, ...args] = line.split(/\s+/);
  if (command === "/memory") {
    await ctx.settle();
    const [sub, arg] = args;
    if (!sub) {
      const facts = store.activeFacts();
      if (!store.memoryEnabled()) log("长期记忆已关闭（/memory on 开启）");
      if (!facts.length) log("还没有记住任何事");
      for (const f of facts) console.log(`  #${f.id}  ${f.value}${f.eventDate ? `（${f.eventDate}）` : ""}  ${dim(`「${f.evidence}」`)}`);
    } else if (sub === "on" || sub === "off") {
      store.setMemoryEnabled(sub === "on");
      log(sub === "on" ? "长期记忆已开启：之后的消息里值得记的事会被记下" : "长期记忆已关闭：已有记忆保留但不再使用，也不再新增");
    } else if (sub === "forget") {
      log(store.forgetFact(Number(arg)) ? `已删除 #${arg}，之前的消息不会让它再被记起；更早聊天的摘要也清掉了` : `没有找到 #${arg}`);
    } else if (sub === "export") {
      log(`已导出到 ${exportMemory(store, ctx.timeZone).replace(ROOT, "")}`);
    } else log("用法：/memory [on|off|forget <id>|export]");
    return true;
  }
  if (command === "/history" && args[0] === "clear") {
    log(`已清空 ${store.clearHistory()} 条聊天记录。长期记忆不受影响，需要的话用 /memory forget 删除。已发出的微信消息不会被撤回。`);
    return true;
  }
  return false;
}

/** "OpenAI gpt-x · 每条回复最多 $1", for the status line. */
export function describeModel(settings: ModelSettings | { problem: string }, fake: boolean): string {
  if (fake || "problem" in settings) return "fake";
  const cap = settings.maxCostPerReply > 0 ? `每条回复最多 $${settings.maxCostPerReply}` : "不限每条花费";
  return `${settings.label} ${settings.model} · ${cap}`;
}

