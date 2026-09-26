// When the body and the day don't match. Code decides: a caution about the
// calendar fires only when a health rule already fired (short sleep, high
// resting heart rate, low HRV) and today still holds something demanding:
// training, an early start, or something high-stakes. A busy day on a good
// night's sleep is just a day.

import { localDate, localMinutes } from "../companion/time.ts";
import type { Trigger } from "../health/caution.ts";
import type { CalendarEvent } from "./mac.ts";

/** Physical training: a hard session on a bad night is what DearByte most wants to catch. Chinese words have no \b. */
const TRAINING =
  /\b(gym|leg day|legs day|push day|pull day|workout|work out|training session|strength training|running|(morning|evening|easy|long|tempo|trail|group) run|run club|race|marathon|lifting|weights|crossfit|hiit|spin class|peloton|cycling|swim|swimming|climbing|bouldering|hike|hiking|yoga|pilates|boxing|bjj|jiu.?jitsu|tennis|soccer|football|basketball|squash|5k|10k)\b|^run(\s+\d.*)?$|健身|跑步|训练|练腿|游泳|瑜伽|爬山|比赛/i;
/** Things that need a clear head. */
const HIGH_STAKES = /\b(interview|exam|midterm|presentation|pitch|demo day|defen[cs]e|deadline|onsite)\b|面试|考试|答辩|汇报|路演/i;
/** Titles that mention a keyword without being the thing: watching a game, a bug named "race", a checkup. */
const NOT_DEMANDING = /\b(watch|watching|on tv|running late|race condition|bug|eye exam|dental|doctor|checkup|check-up)\b|看球|看比赛/i;
/** A non-all-day event starting before this (local) is an early start. */
export const EARLY_MINUTES = 9 * 60;

const BODY: Record<string, string> = { short_sleep: "short sleep", high_resting_hr: "a high resting heart rate", low_hrv: "low HRV" };

export type Demand = "training" | "high-stakes" | "early start";

export function clock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** What makes an event demanding, or null. */
export function demandOf(e: CalendarEvent, timeZone: string): Demand | null {
  if (NOT_DEMANDING.test(e.title)) return null;
  if (TRAINING.test(e.title)) return "training";
  if (HIGH_STAKES.test(e.title)) return "high-stakes";
  if (!e.allDay && localMinutes(e.start, timeZone) < EARLY_MINUTES) return "early start";
  return null;
}

/** The first calendar day of an event: an all-day event's own date, otherwise its start in `timeZone`. */
export function firstDay(e: CalendarEvent, timeZone: string): string {
  return e.days?.first ?? localDate(e.start, timeZone);
}

/** Events still ahead or under way today: started today or earlier, not ended yet. All-day events go by their dates. */
export function restOfToday(events: CalendarEvent[], now: Date, timeZone: string): CalendarEvent[] {
  const today = localDate(now, timeZone);
  return events.filter((e) => (e.days ? e.days.first <= today && today <= e.days.last : e.end > now && localDate(e.start, timeZone) <= today));
}

/** A "hard_event" trigger when a health rule fired and today still holds something demanding. */
export function calendarTrigger(body: Trigger[], events: CalendarEvent[], now: Date, timeZone: string): Trigger | null {
  if (!body.length) return null;
  const demanding = restOfToday(events, now, timeZone)
    .map((e) => ({ e, demand: demandOf(e, timeZone) }))
    .filter((x): x is { e: CalendarEvent; demand: Demand } => x.demand !== null && !(x.demand === "early start" && x.e.start <= now));
  if (!demanding.length) return null;
  // Titles can be written by anyone who sends an invite: quoted, short, and marked as calendar data where the prompt uses them.
  const list = demanding.slice(0, 3).map(({ e, demand }) => `${JSON.stringify(e.title.slice(0, 60))} at ${e.allDay ? "all day" : clock(e.start, timeZone)} (${demand})`);
  return { kind: "hard_event", detail: `today's calendar has ${list.join(", ")}, after ${body.map((t) => BODY[t.kind] ?? t.kind).join(" and ")}` };
}
