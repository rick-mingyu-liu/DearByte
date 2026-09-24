// A rolling summary of the conversation older than the prompt's window. The
// last N messages go to the model verbatim; anything older used to vanish
// unless it had become a fact. When enough messages have aged out, one cheap
// call folds them into a short running summary.

import { z } from "zod";
import type { StoredMessage } from "../domain.ts";
import type { ChatModel } from "../model/provider.ts";
import type { Store } from "../storage/store.ts";
import { describeNow } from "../companion/time.ts";

/** Fold messages in once at least this many have left the window. */
export const SUMMARY_BATCH = 10;
/** At most this many per call; a long existing history catches up over several turns. */
export const SUMMARY_MAX_FOLD = 100;
export const SUMMARY_MAX_CHARS = 400;

export const SUMMARY_SETTING = "summary_text";
/** Id of the last message folded into the summary. */
export const SUMMARY_UPTO_SETTING = "summary_upto";

const SUMMARY_PROMPT = `你在帮一个聊天伙伴整理“之前聊过什么”的备忘。给你旧的备忘和一段更早的聊天记录，写一份新的备忘。

要求：
- 用中文，${SUMMARY_MAX_CHARS} 字以内，按时间顺序，写成几句话，不要列表。
- 记聊过的话题、发生的事、用户的心情变化、你们之间的梗；新的内容多写，很旧的可以压缩成一句。
- 只写聊天里真的出现过的，不要推测，不要评价，不要给建议。
- 用户说过要忘掉或别再提的事，不要写。
- 称呼用“用户”和“你”（“你”指聊天伙伴自己）。

只输出 JSON：{"summary": "..."}`;

const SummarySchema = z.object({ summary: z.string().trim().max(SUMMARY_MAX_CHARS * 2) });

function line(m: StoredMessage, timeZone: string): string {
  const who = m.role === "user" ? "用户" : "你";
  const text = m.role === "assistant" ? (m.bubbles ?? [m.text]).join(" / ") : m.hasImage ? `[图片]${m.text}` : m.text;
  return `${describeNow(new Date(m.createdAt), timeZone)} ${who}：${text}`;
}

export type SummaryOutcome = { folded: number; chars: number } | null;

/**
 * Folds messages that have left the last-`window` window into the summary,
 * once there are at least SUMMARY_BATCH of them. Returns null when there was
 * nothing to do or the output was unusable (the old summary is kept).
 */
export async function updateSummary(opts: { model: ChatModel; store: Store; window: number; timeZone: string }): Promise<SummaryOutcome> {
  const { store } = opts;
  const recent = store.recentMessages(opts.window);
  if (!recent.length) return null;
  const rev = store.summaryRev();
  const upto = Number(store.getSetting(SUMMARY_UPTO_SETTING) ?? 0);
  const aged = store.messagesBetween(upto, recent[0].id).slice(0, SUMMARY_MAX_FOLD);
  if (aged.length < SUMMARY_BATCH) return null;

  const previous = store.getSetting(SUMMARY_SETTING) ?? "（还没有）";
  const completion = await opts.model.complete(
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: `旧的备忘：${previous}\n\n更早的聊天记录：\n${aged.map((m) => line(m, opts.timeZone)).join("\n")}` },
    ],
    // Generous: deepseek-flash reasons before answering, and 700 left the answer empty.
    { json: true, temperature: 0, maxTokens: 2_000 },
  );
  let summary: string;
  try {
    const parsed = SummarySchema.safeParse(JSON.parse(completion.text));
    if (!parsed.success || !parsed.data.summary) return null;
    summary = [...parsed.data.summary].slice(0, SUMMARY_MAX_CHARS).join("");
  } catch {
    return null;
  }
  // Written together, and only if nobody cleared the summary meanwhile
  // (/history clear, /memory forget): this fold was built on the old one.
  const wrote = store.setSummaryIf(rev, { [SUMMARY_SETTING]: summary, [SUMMARY_UPTO_SETTING]: String(aged.at(-1)!.id) });
  return wrote ? { folded: aged.length, chars: [...summary].length } : null;
}

/**
 * Deletes chat history older than `days` (0 keeps everything). With memory on,
 * only messages already folded into the summary go, so nothing is lost that
 * the summary hasn't kept; with memory off there is no summary to wait for.
 */
export function applyRetention(store: Store, days: number, now = new Date()): number {
  if (days <= 0) return 0;
  const before = new Date(now.getTime() - days * 86_400_000).toISOString();
  const upto = store.memoryEnabled() ? Number(store.getSetting(SUMMARY_UPTO_SETTING) ?? 0) : null;
  return store.pruneMessages(before, upto);
}
