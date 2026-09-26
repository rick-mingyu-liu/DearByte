// Caution rules: plain code decides *when* DearByte speaks up; the model only
// decides *what* to say. Each rule compares today against the user's own
// baseline and explains itself with numbers, so every alert can name why it
// fired. Rules never fire on missing data.

import type { Baseline } from "./daily.ts";
import type { Night } from "./summary.ts";

/** `hard_event` comes from the calendar (calendar/rules.ts) and only joins a health trigger. */
export type Trigger = { kind: "short_sleep" | "high_resting_hr" | "low_hrv" | "hard_event"; detail: string };

/** Without a baseline yet, sleep is compared against this. */
export const DEFAULT_SLEEP_MINUTES = 7 * 60;
export const SHORT_SLEEP_RATIO = 0.8;
export const SHORT_SLEEP_FLOOR = 6 * 60;
export const HIGH_RHR_DELTA = 7;
export const LOW_HRV_RATIO = 0.8;

export function cautionTriggers(input: {
  lastNight: (Night & { isLastNight: boolean }) | null;
  restingHr: number | null;
  hrvMs: number | null;
  baseline: Baseline;
}): Trigger[] {
  const { lastNight, restingHr, hrvMs, baseline } = input;
  const triggers: Trigger[] = [];

  if (lastNight?.isLastNight && lastNight.asleepMinutes > 0) {
    const usual = baseline.asleepMinutes ?? DEFAULT_SLEEP_MINUTES;
    const source = baseline.asleepMinutes === null ? "a default 7h (no baseline yet)" : `your ${baseline.days.asleep}-night average`;
    if (lastNight.asleepMinutes < usual * SHORT_SLEEP_RATIO || lastNight.asleepMinutes < SHORT_SLEEP_FLOOR) {
      triggers.push({ kind: "short_sleep", detail: `slept ${lastNight.asleepMinutes} min last night vs ${usual} min (${source})` });
    }
  }
  if (restingHr !== null && baseline.restingHr !== null && restingHr > baseline.restingHr + HIGH_RHR_DELTA) {
    triggers.push({ kind: "high_resting_hr", detail: `resting heart rate ${restingHr} bpm vs usual ${baseline.restingHr} bpm` });
  }
  if (hrvMs !== null && baseline.hrvMs !== null && hrvMs < baseline.hrvMs * LOW_HRV_RATIO) {
    triggers.push({ kind: "low_hrv", detail: `HRV ${hrvMs} ms vs usual ${baseline.hrvMs} ms` });
  }
  return triggers;
}
