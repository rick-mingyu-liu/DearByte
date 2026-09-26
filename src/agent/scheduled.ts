// What DearByte does on its own: a morning brief once a day, and caution
// alerts when your body and your day don't match. The rules in
// health/caution.ts decide whether to speak; the agent writes the words.
//
// Limits, all in code: no messages in quiet hours (23:00–07:00), at most
// MAX_CAUTIONS_PER_DAY cautions, each rule at most once a day, and one brief a
// day. Every message is stored in agent_alerts before it is sent. When the
// weekly spending cap stops the model, a fixed notice says so, once a day.

import { localDate, localMinutes } from "../companion/time.ts";
import { baseline, baselineStart, recordSnapshot } from "../health/daily.ts";
import { cautionTriggers, type Trigger } from "../health/caution.ts";
import type { HealthMcpClient } from "../health/mcp-client.ts";
import type { Store } from "../storage/store.ts";
import { runAgent, type LoopEvent, type LoopStop } from "./loop.ts";
import type { AgentModel } from "./model.ts";
import { withCurrentTime } from "./persona.ts";
import type { ToolRegistry } from "./tools.ts";

export const QUIET = { from: 23 * 60, to: 7 * 60 };
export const BRIEF_AT = 7 * 60 + 30;
export const MAX_CAUTIONS_PER_DAY = 3;
/** Vital readings older than this don't count as today's. */
const VITAL_MAX_AGE_HOURS = 24;

/** Delivers a message; resolves to whether it reached the user. `alertId` lets the channel offer feedback buttons. */
export type Notify = (title: string, body: string, o?: { alertId?: number }) => Promise<boolean>;

export type ScheduledDeps = {
  bridge: Pick<HealthMcpClient, "callTool">;
  store: Pick<Store, "upsertHealthDay" | "healthDays" | "recordAlert" | "alertsOn" | "markAlertDelivered">;
  model: AgentModel;
  tools: ToolRegistry;
  system: string;
  timeZone: string;
  notify: Notify;
  now?: () => Date;
  onEvent?: (e: LoopEvent) => void;
};

export type Outcome = { sent: false; reason: string; triggers: Trigger[] } | { sent: true; kind: string; text: string; triggers: Trigger[]; delivered: boolean };

export function inQuietHours(now: Date, timeZone: string): boolean {
  const m = localMinutes(now, timeZone);
  return m >= QUIET.from || m < QUIET.to;
}

/** Records today's data, then works out which caution rules fire. */
async function assess(d: ScheduledDeps, now: Date): Promise<Trigger[]> {
  const { sleep, vitals } = await recordSnapshot(d.bridge, d.store, d.timeZone, now);
  const today = localDate(now, d.timeZone);
  const lastNight = sleep.status === "ok" ? sleep.latest : null;
  const days = d.store.healthDays(baselineStart(today), today);
  // Only readings from the last day count as today's, and each is compared with the days before it was taken.
  const recent = (key: string) => {
    const v = vitals.vitals[key];
    return v && v.value !== null && v.ageHours <= VITAL_MAX_AGE_HOURS ? { value: v.value, date: localDate(new Date(v.sampledAt), d.timeZone) } : null;
  };
  const rhr = recent("resting_heart_rate");
  const hrv = recent("hrv_sdnn");
  return cautionTriggers({
    lastNight,
    restingHr: rhr?.value ?? null,
    hrvMs: hrv?.value ?? null,
    baseline: baseline(days, { today, sleep: lastNight?.date, restingHr: rhr?.date, hrv: hrv?.date }),
  });
}

/** What writing a scheduled message needs; news alerts use the same helpers. */
export type ComposeDeps = Pick<ScheduledDeps, "model" | "tools" | "system" | "timeZone" | "onEvent">;
export type DeliverDeps = Pick<ScheduledDeps, "store" | "timeZone" | "notify">;

type Composed = { text: string } | { text: null; stop: LoopStop };

export async function compose(d: ComposeDeps, purpose: string, instruction: string, now: Date): Promise<Composed> {
  const result = await runAgent({
    model: d.model,
    tools: d.tools,
    system: d.system,
    messages: [{ role: "user", content: withCurrentTime(instruction, now, d.timeZone) }],
    purpose,
    onEvent: d.onEvent,
  });
  return result.stop === "done" && result.text ? { text: result.text } : { text: null, stop: result.stop };
}

export const CAP_NOTICE =
  "I held back a message: this week's model spending reached the cap (DEARBYTE_WEEKLY_CAP). I'll stay quiet until older spending ages out, or you can raise the cap.";

/** When the model couldn't write the message: explains the weekly cap to the user once a day, otherwise just reports. */
export async function unwritten(d: DeliverDeps, now: Date, c: Composed & { text: null }, triggers: Trigger[]): Promise<Outcome> {
  if (c.stop !== "weekly_cap") return { sent: false, reason: `the model gave no message (${c.stop})`, triggers };
  const told = d.store.alertsOn(localDate(now, d.timeZone)).some((a) => a.kind === "notice" && a.triggers.includes("weekly_cap"));
  if (told) return { sent: false, reason: "weekly spending cap reached", triggers };
  return deliver(d, now, "notice", "DearByte", CAP_NOTICE, triggers, ["weekly_cap"]);
}

/** Stores the message under `kind` with the rules it covers (`raised`, default: the triggers' kinds), then sends it. */
export async function deliver(d: DeliverDeps, now: Date, kind: string, title: string, text: string, triggers: Trigger[], raised = triggers.map((t) => t.kind as string)): Promise<Outcome> {
  const id = d.store.recordAlert({ at: now.toISOString(), date: localDate(now, d.timeZone), kind, triggers: raised, text, delivered: false });
  // Notices are about DearByte itself, not advice, so they get no rating buttons.
  const delivered = await d.notify(title, text, kind === "notice" ? {} : { alertId: id }).catch(() => false);
  if (delivered) d.store.markAlertDelivered(id);
  return { sent: true, kind, text, triggers, delivered };
}

export const SCHEDULED = "[Scheduled by DearByte, not a message from the user. Speak to the user directly.]";

/** Sends a caution when a rule fires that hasn't been raised today. */
export async function runCautionCheck(d: ScheduledDeps): Promise<Outcome> {
  const now = (d.now ?? (() => new Date()))();
  const triggers = await assess(d, now);
  if (!triggers.length) return { sent: false, reason: "no rule fired", triggers };
  if (inQuietHours(now, d.timeZone)) return { sent: false, reason: "quiet hours", triggers };

  const today = d.store.alertsOn(localDate(now, d.timeZone));
  if (today.filter((a) => a.kind === "caution").length >= MAX_CAUTIONS_PER_DAY) return { sent: false, reason: "daily caution limit reached", triggers };
  const raised = new Set(today.flatMap((a) => a.triggers));
  const fresh = triggers.filter((t) => !raised.has(t.kind));
  if (!fresh.length) return { sent: false, reason: "already raised today", triggers };

  const c = await compose(
    d,
    "caution_alert",
    `${SCHEDULED}\nThese checks fired:\n${fresh.map((t) => `- ${t.detail}`).join("\n")}\nWrite one short caution message (2-4 sentences): what you noticed, with the numbers, and one concrete suggestion for today. Check other tools if they help. No greeting.`,
    now,
  );
  if (c.text === null) return unwritten(d, now, c, triggers);
  return deliver(d, now, "caution", "DearByte", `${c.text}\n\n(Why: ${fresh.map((t) => t.kind.replaceAll("_", " ")).join(", ")})`, fresh);
}

/** Sends the morning brief once a day; `force` sends it anyway (for testing and demos). */
export async function runMorningBrief(d: ScheduledDeps, o: { force?: boolean } = {}): Promise<Outcome> {
  const now = (d.now ?? (() => new Date()))();
  const date = localDate(now, d.timeZone);
  if (!o.force && d.store.alertsOn(date).some((a) => a.kind === "morning_brief")) return { sent: false, reason: "already sent today", triggers: [] };
  const triggers = await assess(d, now);
  const c = await compose(
    d,
    "morning_brief",
    `${SCHEDULED}\nWrite the user's morning brief. Check their sleep and vitals with your tools, and memory for anything happening today. ${
      triggers.length ? `These checks fired, so lead with them:\n${triggers.map((t) => `- ${t.detail}`).join("\n")}\n` : "No caution checks fired.\n"
    }Format: 3-6 short lines, plain text. Sleep against their usual first, then anything worth watching, then one suggestion for the day.`,
    now,
  );
  if (c.text === null) return unwritten(d, now, c, triggers);
  // Rules covered in the brief count as raised, so no separate caution repeats them today.
  return deliver(d, now, "morning_brief", "DearByte morning brief", c.text, triggers);
}

/** One tick of the background loop: the brief when it's due, otherwise a caution check. */
export async function tick(d: ScheduledDeps): Promise<Outcome> {
  const now = (d.now ?? (() => new Date()))();
  const briefDue = localMinutes(now, d.timeZone) >= BRIEF_AT && !inQuietHours(now, d.timeZone);
  if (briefDue && !d.store.alertsOn(localDate(now, d.timeZone)).some((a) => a.kind === "morning_brief")) return runMorningBrief(d);
  return runCautionCheck(d);
}
