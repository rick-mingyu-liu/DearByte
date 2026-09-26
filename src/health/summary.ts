// Turns the bridge's raw health data into the few numbers the agent needs:
// how long you slept last night against your recent nights, and your latest
// vital signs with how old they are. Summaries, not raw samples: they are what
// a person would look at, and they keep each tool result small.
//
// Rules:
// - A night belongs to the day you woke up: a segment ending at 07:00 on the
//   27th is the night of the 27th. Anything ending after 18:00 counts toward
//   the next day, so an evening nap before bed joins that night.
// - When two devices recorded the same night (Watch and iPhone), the one with
//   more sleep is used and the other ignored, so nothing is counted twice.
// - Asleep = core + deep + REM + unspecified sleep. "In bed" and "awake" are
//   reported separately and never count as sleep.
// - Missing data is null and says so; it is never zero.

import { z } from "zod";
import { localDate } from "../companion/time.ts";

const Segment = z.object({
  value: z.number().optional(),
  stage: z.string().optional(),
  started_at: z.string().optional(),
  sampled_at: z.string().optional(),
  source_device: z.string().optional(),
});
type Segment = z.infer<typeof Segment>;

const ASLEEP = new Set(["asleep_core", "asleep_deep", "asleep_rem", "asleep_unspecified"]);
const NIGHT_SHIFT_MS = 6 * 3_600_000; // 18:00 + 6h = the next day

export type Night = {
  /** The day you woke up, YYYY-MM-DD in your time zone. */
  date: string;
  asleepMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  coreMinutes: number;
  awakeMinutes: number;
  inBedMinutes: number;
  /** First and last asleep moment, local HH:MM; null when only "in bed" was recorded. */
  asleepFrom: string | null;
  asleepUntil: string | null;
  source: string;
};

export type SleepSummary =
  | { status: "no_data"; message: string }
  | {
      status: "ok";
      /** The most recent night, and whether it is last night (the latest night that could have ended by now). */
      latest: Night & { isLastNight: boolean };
      /** Average asleep minutes of the other nights on record, or null with fewer than 2 of them. */
      averageOtherNightsMinutes: number | null;
      otherNights: Array<{ date: string; asleepMinutes: number }>;
    };

export function summarizeSleep(records: unknown[], timeZone: string, now: Date): SleepSummary {
  const nights = sleepNights(records, timeZone);
  if (!nights.length) return { status: "no_data", message: "No sleep has been recorded in the last 7 days." };
  const [latest, ...others] = nights;
  const withSleep = others.filter((n) => n.asleepMinutes > 0);
  return {
    status: "ok",
    latest: { ...latest, isLastNight: latest.date === lastNightOf(now, timeZone) },
    averageOtherNightsMinutes: withSleep.length >= 2 ? Math.round(withSleep.reduce((s, n) => s + n.asleepMinutes, 0) / withSleep.length) : null,
    otherNights: others.map((n) => ({ date: n.date, asleepMinutes: n.asleepMinutes })),
  };
}

/** Nights newest first, one source per night. */
export function sleepNights(records: unknown[], timeZone: string): Night[] {
  const segments = records.map((r) => Segment.safeParse(r)).flatMap((p) => (p.success ? [p.data] : []));
  const byNight = new Map<string, Map<string, Segment[]>>();
  for (const s of segments) {
    const end = Date.parse(s.sampled_at ?? "");
    if (!Number.isFinite(end)) continue;
    const night = nightOf(new Date(end), timeZone);
    const source = s.source_device ?? "unknown";
    const sources = byNight.get(night) ?? new Map<string, Segment[]>();
    sources.set(source, [...(sources.get(source) ?? []), s]);
    byNight.set(night, sources);
  }
  const nights: Night[] = [];
  for (const [date, sources] of byNight) {
    const candidates = [...sources].map(([source, segs]) => buildNight(date, source, segs, timeZone));
    candidates.sort((a, b) => b.asleepMinutes - a.asleepMinutes || b.inBedMinutes - a.inBedMinutes);
    nights.push(candidates[0]);
  }
  return nights.sort((a, b) => b.date.localeCompare(a.date));
}

function buildNight(date: string, source: string, segments: Segment[], timeZone: string): Night {
  const minutes = (stage: string) => segments.filter((s) => s.stage === stage).reduce((sum, s) => sum + (s.value ?? 0), 0);
  const asleep = segments.filter((s) => ASLEEP.has(s.stage ?? ""));
  const starts = asleep.map((s) => Date.parse(s.started_at ?? "")).filter(Number.isFinite);
  const ends = asleep.map((s) => Date.parse(s.sampled_at ?? "")).filter(Number.isFinite);
  return {
    date,
    asleepMinutes: asleep.reduce((sum, s) => sum + (s.value ?? 0), 0),
    deepMinutes: minutes("asleep_deep"),
    remMinutes: minutes("asleep_rem"),
    coreMinutes: minutes("asleep_core"),
    awakeMinutes: minutes("awake"),
    inBedMinutes: minutes("in_bed"),
    asleepFrom: starts.length ? clock(new Date(Math.min(...starts)), timeZone) : null,
    asleepUntil: ends.length ? clock(new Date(Math.max(...ends)), timeZone) : null,
    source,
  };
}

/**
 * The most recent night that could have ended by `now`: looking back 12 hours
 * means at 2 a.m. it's the night that ended yesterday morning, and from mid-
 * morning on it's the night that ended today.
 */
function lastNightOf(now: Date, timeZone: string): string {
  return nightOf(new Date(now.getTime() - 12 * 3_600_000), timeZone);
}

function nightOf(date: Date, timeZone: string): string {
  return localDate(new Date(date.getTime() + NIGHT_SHIFT_MS), timeZone);
}

function clock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** "6h40m" */
export function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// ---- Vital signs ----

/** The metrics worth showing the agent, with the unit the bridge stores them in. */
export const VITALS: Record<string, string> = {
  resting_heart_rate: "bpm",
  hrv_sdnn: "ms",
  heart_rate: "bpm",
  respiratory_rate: "breaths/min",
  oxygen_saturation: "%",
  vo2_max: "ml/kg/min",
};

const Reading = z.object({ value: z.number(), sampled_at: z.string() });

export type Vital = { value: number; unit: string; sampledAt: string; ageHours: number } | { value: null; note: string };

export type VitalsSummary = {
  /** Hours since the phone last uploaded anything, or null if it never has. */
  lastUploadHoursAgo: number | null;
  stale: boolean;
  vitals: Record<string, Vital>;
  /** Recent readings, newest first, for spotting a change: the bridge keeps the 3 newest. */
  recent: Record<string, number[]>;
};

/** After this many hours without an upload, the data is called stale. */
export const STALE_HOURS = 12;

export function summarizeVitals(latest: unknown, history: Record<string, unknown[]>, now: Date): VitalsSummary {
  const envelope = z.object({ uploaded_at: z.string().optional(), metrics: z.record(z.string(), z.unknown()).optional() }).safeParse(latest);
  const metrics = envelope.success ? (envelope.data.metrics ?? {}) : {};
  const uploaded = envelope.success ? Date.parse(envelope.data.uploaded_at ?? "") : NaN;
  const lastUploadHoursAgo = Number.isFinite(uploaded) ? round1((now.getTime() - uploaded) / 3_600_000) : null;

  const vitals: Record<string, Vital> = {};
  const recent: Record<string, number[]> = {};
  for (const [key, unit] of Object.entries(VITALS)) {
    const reading = Reading.safeParse(metrics[key]);
    vitals[key] = reading.success
      ? { value: round1(reading.data.value), unit, sampledAt: reading.data.sampled_at, ageHours: round1((now.getTime() - Date.parse(reading.data.sampled_at)) / 3_600_000) }
      : { value: null, note: "not recorded" };
    const values = (history[key] ?? []).map((r) => Reading.safeParse(r)).flatMap((p) => (p.success ? [round1(p.data.value)] : []));
    if (values.length) recent[key] = values;
  }
  return { lastUploadHoursAgo, stale: lastUploadHoursAgo === null || lastUploadHoursAgo > STALE_HOURS, vitals, recent };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
