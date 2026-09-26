// Daily health snapshots and the user's normal. The bridge keeps only 7 days
// of sleep and the 3 newest readings of everything else, so DearByte writes
// down what it sees each day (health_daily) and learns the baseline from that.

import { localDate } from "../companion/time.ts";
import type { HealthDay, Store } from "../storage/store.ts";
import type { HealthMcpClient } from "./mcp-client.ts";
import { sleepNights, summarizeSleep, summarizeVitals, type SleepSummary, type VitalsSummary } from "./summary.ts";
import { z } from "zod";

type Bridge = Pick<HealthMcpClient, "callTool">;

/** Days of history the baseline averages over. */
export const BASELINE_DAYS = 14;
/** A baseline needs at least this many days with a value. */
export const MIN_BASELINE_DAYS = 3;

export type Baseline = {
  asleepMinutes: number | null;
  restingHr: number | null;
  hrvMs: number | null;
  /** How many days each average is based on. */
  days: { asleep: number; restingHr: number; hrv: number };
};

const History = z.object({ history: z.record(z.string(), z.array(z.unknown())).optional() });

/**
 * Pulls the bridge's data and records it by day: every night it still has, and
 * each resting heart rate and HRV reading under the day it was taken (the
 * newest one wins for a day). The bridge's 3 newest readings usually span 3
 * days, so a baseline can start from the first snapshot. Returns the sleep and
 * vitals summaries it saw.
 */
export async function recordSnapshot(
  bridge: Bridge,
  store: Pick<Store, "upsertHealthDay">,
  timeZone: string,
  now: Date,
): Promise<{ sleep: SleepSummary; vitals: VitalsSummary }> {
  const history = async (metric: string) => {
    const parsed = History.safeParse(await bridge.callTool("watch_get_health_history", { metric }));
    return parsed.success ? (parsed.data.history?.[metric] ?? []) : [];
  };
  const empty = { asleepMinutes: null, deepMinutes: null, remMinutes: null, restingHr: null, hrvMs: null };
  const sleepRecords = await history("sleep");
  for (const night of sleepNights(sleepRecords, timeZone)) {
    store.upsertHealthDay({ ...empty, date: night.date, asleepMinutes: night.asleepMinutes, deepMinutes: night.deepMinutes, remMinutes: night.remMinutes });
  }
  for (const [metric, field] of [["resting_heart_rate", "restingHr"], ["hrv_sdnn", "hrvMs"]] as const) {
    const readings = (await history(metric))
      .map((r) => Reading.safeParse(r))
      .flatMap((p) => (p.success ? [p.data] : []))
      .sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at)); // oldest first: the newest of a day is written last
    for (const r of readings) store.upsertHealthDay({ ...empty, date: localDate(new Date(r.sampled_at), timeZone), [field]: Math.round(r.value * 10) / 10 });
  }
  return { sleep: summarizeSleep(sleepRecords, timeZone, now), vitals: summarizeVitals(await bridge.callTool("watch_get_latest_health"), {}, now) };
}

const Reading = z.object({ value: z.number(), sampled_at: z.string() });

/**
 * Averages of the days before the value being judged, each only with enough
 * days behind it. A reading never counts toward its own baseline: at 2 a.m.,
 * last night is dated yesterday and so can be the latest HRV reading, so each
 * metric takes the date of the value it will be compared with (default: today).
 */
export function baseline(days: HealthDay[], before: { sleep?: string; restingHr?: string; hrv?: string; today: string }): Baseline {
  const avg = (cutoff: string | undefined, pick: (d: HealthDay) => number | null) => {
    const known = days.filter((d) => d.date < (cutoff ?? before.today)).map(pick).filter((v): v is number => v !== null);
    return { value: known.length >= MIN_BASELINE_DAYS ? Math.round((known.reduce((s, v) => s + v, 0) / known.length) * 10) / 10 : null, days: known.length };
  };
  const asleep = avg(before.sleep, (d) => d.asleepMinutes);
  const rhr = avg(before.restingHr, (d) => d.restingHr);
  const hrv = avg(before.hrv, (d) => d.hrvMs);
  return {
    asleepMinutes: asleep.value === null ? null : Math.round(asleep.value),
    restingHr: rhr.value,
    hrvMs: hrv.value,
    days: { asleep: asleep.days, restingHr: rhr.days, hrv: hrv.days },
  };
}

/** The first day of the baseline window ending the day before `today`. */
export function baselineStart(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - BASELINE_DAYS * 86_400_000).toISOString().slice(0, 10);
}
