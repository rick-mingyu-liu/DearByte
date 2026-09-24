// When 小拜 messages first. A friend says good morning some days, wishes you
// luck on the day of an exam, asks how it went that evening, checks in after a
// long silence, and sometimes just thinks of you in the afternoon. A friend also doesn't double-text, doesn't message at
// night, and doesn't interrupt a conversation that just ended.

import type { Fact, StoredMessage } from "../domain.ts";
import { localDate, localMinutes } from "./time.ts";

/** Saved in settings so a restart doesn't repeat today's messages. */
export type ProactiveState = {
  date: string;
  /** Minutes after midnight for today's good morning, or null for none today. */
  morningAt: number | null;
  /** Minutes after midnight when 小拜 may "think of you" today, or null. Missing in older saved state. */
  thinkingAt?: number | null;
  /** Keys of what was sent today. */
  sent: string[];
  /** When the last proactive message went out (ISO), across days. */
  lastAt: string | null;
};

export type ProactivePlan = { key: string; note: string };

const hm = (h: number, m = 0) => h * 60 + m;
/** No proactive messages outside these hours. */
export const AWAKE = { from: hm(8), to: hm(22, 30) };
export const MAX_PER_DAY = 2;
/** Leave a conversation this long before starting a new one. */
export const QUIET_AFTER_CHAT_MS = 90 * 60_000;
/** Check in after this long without hearing from the user. */
export const CHECKIN_AFTER_MS = 20 * 3_600_000;
/** Chance of a good morning on a given day, so it isn't a daily ritual. */
const MORNING_CHANCE = 0.6;
/** Chance of a "thinking of you" message on a given day. */
const THINKING_CHANCE = 0.7;
/** A "thinking of you" message needs this much quiet first. */
export const THINKING_AFTER_MS = 3 * 3_600_000;

/** Today's state, starting a fresh day (with a new random morning time) when the date changed. */
export function dayState(saved: ProactiveState | null, today: string, random: () => number): ProactiveState {
  if (saved?.date === today) return saved;
  const morningAt = random() < MORNING_CHANCE ? hm(8) + Math.floor(random() * 90) : null;
  const thinkingAt = random() < THINKING_CHANCE ? hm(13) + Math.floor(random() * 7 * 60) : null;
  return { date: today, morningAt, thinkingAt, sent: [], lastAt: saved?.lastAt ?? null };
}

export function planProactive(ctx: {
  now: Date;
  timeZone: string;
  state: ProactiveState;
  history: StoredMessage[];
  facts: Fact[];
}): ProactivePlan | null {
  const { now, timeZone, state } = ctx;
  const minutes = localMinutes(now, timeZone);
  if (minutes < AWAKE.from || minutes > AWAKE.to) return null;
  if (state.sent.length >= MAX_PER_DAY) return null;

  const lastUser = ctx.history.findLast((m) => m.role === "user");
  if (!lastUser) return null; // never talked: nobody to message
  const lastAny = ctx.history.at(-1)!;
  // Never double-text: the last nudge must have been answered.
  if (state.lastAt && lastUser.createdAt <= state.lastAt) return null;
  if (now.getTime() - Date.parse(lastAny.createdAt) < QUIET_AFTER_CHAT_MS) return null;

  const today = localDate(now, timeZone);
  const fresh = (key: string) => !state.sent.includes(key);
  const events = ctx.facts.filter((f) => f.category === "event" && f.eventDate === today);

  for (const f of events) {
    if (minutes >= hm(8, 30) && minutes <= hm(11, 30) && fresh(`event_am:${f.key}`)) {
      return { key: `event_am:${f.key}`, note: `今天用户有件事：${f.value}。给用户打个气，轻松点，别说教。` };
    }
    if (minutes >= hm(19) && minutes <= hm(22) && fresh(`event_pm:${f.key}`)) {
      return { key: `event_pm:${f.key}`, note: `今天用户有件事：${f.value}。现在是晚上，随口问问怎么样了。` };
    }
  }

  const silentMs = now.getTime() - Date.parse(lastUser.createdAt);
  if (silentMs >= CHECKIN_AFTER_MS && minutes >= hm(12) && minutes <= hm(21) && fresh("checkin")) {
    const hours = Math.floor(silentMs / 3_600_000);
    return {
      key: "checkin",
      note: `用户已经${hours >= 48 ? `${Math.floor(hours / 24)}天` : `${hours}个小时`}没找你了。随口找个话头，或者问问在忙啥。别抱怨用户不理你，也别撒娇讨关注。`,
    };
  }

  const thinkingAt = state.thinkingAt ?? null;
  if (
    thinkingAt !== null &&
    minutes >= thinkingAt &&
    minutes <= thinkingAt + 120 &&
    now.getTime() - Date.parse(lastAny.createdAt) >= THINKING_AFTER_MS &&
    fresh("thinking")
  ) {
    return {
      key: "thinking",
      note:
        "你突然想起用户，随手发条消息。可以接着用户之前说过的某件具体的事问问（从记忆和最近的聊天里挑），或者问个轻松的小问题、说个刚冒出来的念头。" +
        "别编造你自己在做什么、去了哪、吃了什么、见了谁（“翻冰箱时想起”“路过看到”都不行），直接说想起的事就好。别每次都用“想你了”开头。",
    };
  }

  const talkedToday = localDate(new Date(lastUser.createdAt), timeZone) === today;
  if (
    state.morningAt !== null &&
    minutes >= state.morningAt &&
    minutes <= state.morningAt + 60 &&
    !events.length &&
    !talkedToday &&
    fresh("morning")
  ) {
    return { key: "morning", note: "现在是早上。跟用户随口打个招呼，可以顺带聊点今天的事（早饭、天气、今天要忙啥都行），每天说法别一样。" };
  }
  return null;
}
