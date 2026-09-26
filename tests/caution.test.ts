import { expect, test } from "vitest";
import { FakeAgentModel } from "../src/agent/fake.ts";
import { inQuietHours, runCautionCheck, runMorningBrief, tick, type ScheduledDeps } from "../src/agent/scheduled.ts";
import { ToolRegistry } from "../src/agent/tools.ts";
import { cautionTriggers } from "../src/health/caution.ts";
import { baseline, recordSnapshot } from "../src/health/daily.ts";
import type { Night } from "../src/health/summary.ts";
import { Store } from "../src/storage/store.ts";

const TZ = "America/Toronto";

const night = (date: string, asleepMinutes: number, isLastNight = true): Night & { isLastNight: boolean } => ({
  date,
  asleepMinutes,
  deepMinutes: 0,
  remMinutes: 0,
  coreMinutes: asleepMinutes,
  awakeMinutes: 0,
  inBedMinutes: 0,
  asleepFrom: null,
  asleepUntil: null,
  source: "watch",
  isLastNight,
});
const noBaseline = { asleepMinutes: null, restingHr: null, hrvMs: null, days: { asleep: 0, restingHr: 0, hrv: 0 } };
const usual = { asleepMinutes: 425, restingHr: 56.5, hrvMs: 47.5, days: { asleep: 5, restingHr: 3, hrv: 3 } };

test("rules: short sleep, high resting heart rate and low HRV, each against your own normal", () => {
  expect(cautionTriggers({ lastNight: night("2026-09-26", 310), restingHr: 64, hrvMs: 31, baseline: usual }).map((t) => t.kind)).toEqual([
    "short_sleep",
    "high_resting_hr",
    "low_hrv",
  ]);
  expect(cautionTriggers({ lastNight: night("2026-09-26", 400), restingHr: 60, hrvMs: 44, baseline: usual })).toEqual([]);
});

test("rules: never fire on missing data or on a night that isn't last night", () => {
  expect(cautionTriggers({ lastNight: null, restingHr: null, hrvMs: null, baseline: usual })).toEqual([]);
  expect(cautionTriggers({ lastNight: night("2026-09-20", 200, false), restingHr: null, hrvMs: null, baseline: usual })).toEqual([]);
  // No baseline yet: vitals can't be judged, sleep uses a default 7h and says so.
  const [t] = cautionTriggers({ lastNight: night("2026-09-26", 300), restingHr: 90, hrvMs: 10, baseline: noBaseline });
  expect(t).toEqual({ kind: "short_sleep", detail: "slept 300 min last night vs 420 min (a default 7h (no baseline yet))" });
});

test("baseline: needs 3 days, and never counts the night being judged", () => {
  const days = [
    { date: "2026-09-23", asleepMinutes: 435, deepMinutes: null, remMinutes: null, restingHr: 56, hrvMs: 49 },
    { date: "2026-09-24", asleepMinutes: 420, deepMinutes: null, remMinutes: null, restingHr: 57, hrvMs: 46 },
    { date: "2026-09-25", asleepMinutes: 425, deepMinutes: null, remMinutes: null, restingHr: null, hrvMs: null },
    { date: "2026-09-26", asleepMinutes: 310, deepMinutes: null, remMinutes: null, restingHr: 64, hrvMs: 31 },
  ];
  expect(baseline(days, { today: "2026-09-26" })).toEqual({ asleepMinutes: 427, restingHr: null, hrvMs: null, days: { asleep: 3, restingHr: 2, hrv: 2 } });
  // At 2 a.m. on the 26th, last night is dated the 25th: it stays out of its own average,
  // which leaves 2 nights, too few for a baseline.
  expect(baseline(days, { today: "2026-09-26", sleep: "2026-09-25" })).toMatchObject({ asleepMinutes: null, days: { asleep: 2 } });
  // Same for a vital: an HRV reading taken late on the 25th is judged against the days before the 25th.
  const withOlder = [{ date: "2026-09-22", asleepMinutes: null, deepMinutes: null, remMinutes: null, restingHr: null, hrvMs: 48 }, ...days];
  expect(baseline(withOlder, { today: "2026-09-26", hrv: "2026-09-25" })).toMatchObject({ hrvMs: 47.7, days: { hrv: 3 } });
});

// ---- Snapshot and scheduling, against a fake bridge ----

const iso = (s: string) => new Date(s).toISOString();
const seg = (start: string, end: string, minutes: number) => ({ value: minutes, stage: "asleep_core", started_at: iso(start), sampled_at: iso(end), source_device: "watch" });
function bridge(o: { lastNightMinutes: number; rhr: number[]; hrv: number[]; uploadedAt: string }) {
  const nights = [
    seg("2026-09-25T23:00:00-04:00", "2026-09-26T07:00:00-04:00", o.lastNightMinutes),
    seg("2026-09-24T23:00:00-04:00", "2026-09-25T06:05:00-04:00", 425),
    seg("2026-09-23T23:00:00-04:00", "2026-09-24T06:00:00-04:00", 420),
    seg("2026-09-22T23:00:00-04:00", "2026-09-23T06:15:00-04:00", 435),
  ];
  const readings = (values: number[]) => values.map((value, i) => ({ value, sampled_at: iso(`2026-09-${26 - i}T06:00:00-04:00`) }));
  const history: Record<string, unknown[]> = { sleep: nights, resting_heart_rate: readings(o.rhr), hrv_sdnn: readings(o.hrv) };
  return {
    callTool: async (name: string, args: Record<string, unknown> = {}) =>
      name === "watch_get_health_history"
        ? { history: { [String(args.metric)]: history[String(args.metric)] ?? [] } }
        : { uploaded_at: iso(o.uploadedAt), metrics: { resting_heart_rate: readings(o.rhr)[0], hrv_sdnn: readings(o.hrv)[0] } },
  };
}

function deps(o: { now: string; lastNightMinutes?: number; replies?: string[]; store?: Store }) {
  const store = o.store ?? Store.open(":memory:");
  const sent: Array<{ title: string; body: string }> = [];
  const model = new FakeAgentModel((o.replies ?? ["Take it easy today."]).map((r) => FakeAgentModel.text(r)));
  const d: ScheduledDeps = {
    bridge: bridge({ lastNightMinutes: o.lastNightMinutes ?? 310, rhr: [64, 57, 56], hrv: [31, 46, 49], uploadedAt: "2026-09-26T07:30:00-04:00" }),
    store,
    model,
    tools: new ToolRegistry([]),
    system: "s",
    timeZone: TZ,
    notify: async (title, body) => (sent.push({ title, body }), true),
    now: () => new Date(o.now),
  };
  return { d, store, sent, model };
}

test("snapshot: records every night and each vital under its own day", async () => {
  const store = Store.open(":memory:");
  await recordSnapshot(bridge({ lastNightMinutes: 310, rhr: [64, 57, 56], hrv: [31, 46, 49], uploadedAt: "2026-09-26T07:30:00-04:00" }), store, TZ, new Date("2026-09-26T09:00:00-04:00"));
  expect(store.healthDays("2026-09-23", "2026-09-26")).toEqual([
    { date: "2026-09-23", asleepMinutes: 435, deepMinutes: 0, remMinutes: 0, restingHr: null, hrvMs: null },
    { date: "2026-09-24", asleepMinutes: 420, deepMinutes: 0, remMinutes: 0, restingHr: 56, hrvMs: 49 },
    { date: "2026-09-25", asleepMinutes: 425, deepMinutes: 0, remMinutes: 0, restingHr: 57, hrvMs: 46 },
    { date: "2026-09-26", asleepMinutes: 310, deepMinutes: 0, remMinutes: 0, restingHr: 64, hrvMs: 31 },
  ]);
});

test("caution: sends once with the reasons, then not again for the same rule that day", async () => {
  const { d, sent, store, model } = deps({ now: "2026-09-26T09:00:00-04:00", replies: ["You slept 5h10m. Go light today.", "unused"] });
  const first = await runCautionCheck(d);
  expect(first).toMatchObject({ sent: true, kind: "caution", delivered: true });
  expect(sent[0].body).toBe("You slept 5h10m. Go light today.\n\n(Why: short sleep)");
  // The model was told what fired, with numbers, and that this wasn't the user talking.
  const asked = String(model.requests[0].messages[0].content);
  expect(asked).toContain("Scheduled by DearByte, not a message from the user");
  expect(asked).toContain("slept 310 min last night vs 427 min (your 3-night average)");
  expect(store.alertsOn("2026-09-26")).toMatchObject([{ kind: "caution", triggers: ["short_sleep"], delivered: true }]);

  expect(await runCautionCheck(d)).toMatchObject({ sent: false, reason: "already raised today" });
  expect(sent).toHaveLength(1);
});

test("caution: silent in quiet hours and when nothing fired", async () => {
  const late = deps({ now: "2026-09-26T23:30:00-04:00" });
  expect(await runCautionCheck(late.d)).toMatchObject({ sent: false, reason: "quiet hours" });
  const fine = deps({ now: "2026-09-26T09:00:00-04:00", lastNightMinutes: 430 });
  expect(await runCautionCheck(fine.d)).toMatchObject({ sent: false, reason: "no rule fired" });
  expect(inQuietHours(new Date("2026-09-26T06:59:00-04:00"), TZ)).toBe(true);
  expect(inQuietHours(new Date("2026-09-26T07:00:00-04:00"), TZ)).toBe(false);
});

test("morning brief: once a day, due after 07:30, and it covers the rules so no caution repeats them", async () => {
  const early = deps({ now: "2026-09-26T07:10:00-04:00" });
  expect(await tick(early.d)).toMatchObject({ kind: "caution" }); // before 07:30: a caution check

  const { d, sent, store } = deps({ now: "2026-09-26T07:45:00-04:00", replies: ["Morning. 5h10m last night...", "x"] });
  expect(await tick(d)).toMatchObject({ sent: true, kind: "morning_brief" });
  expect(sent[0].title).toBe("DearByte morning brief");
  expect(store.alertsOn("2026-09-26")[0].triggers).toEqual(["short_sleep"]);
  expect(await tick(d)).toMatchObject({ sent: false, reason: "already raised today" });
  expect(await runMorningBrief(d)).toMatchObject({ sent: false, reason: "already sent today" });
});

test("a failed delivery is recorded as not delivered", async () => {
  const { d, store } = deps({ now: "2026-09-26T09:00:00-04:00" });
  d.notify = async () => false;
  expect(await runCautionCheck(d)).toMatchObject({ sent: true, delivered: false });
  expect(store.alertsOn("2026-09-26")[0].delivered).toBe(false);
});
