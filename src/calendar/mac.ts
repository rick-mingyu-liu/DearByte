// The user's calendar, read on this Mac. iCloud keeps the Mac's calendars in
// sync with the iPhone, so a small Swift helper (native/calendar) reading
// EventKit sees the same events, within seconds, without the calendar leaving
// the machine. Only titles and times are read.
//
// Everything else in DearByte uses the CalendarSource type, so a different
// source (the iPhone app through dearbyte-bridge, for a hosted DearByte) can
// replace this one without changing the tools or the rules.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.ts";

/** `days`: an all-day event's first and last calendar date, as the Mac shows them (all-day events have no time zone). */
export type CalendarEvent = { title: string; start: Date; end: Date; allDay: boolean; days?: { first: string; last: string } };

export type CalendarAccess = "granted" | "not_determined" | "denied" | "write_only" | "restricted";

export type CalendarResult = { status: "ok"; events: CalendarEvent[] } | { status: "unavailable"; access: CalendarAccess | "error"; message: string };

export type CalendarSource = {
  /** Events overlapping from..to, sorted by start. */
  events(from: Date, to: Date): Promise<CalendarResult>;
};

/** Runs the helper with arguments and resolves to what it printed. */
export type Runner = (args: string[]) => Promise<string>;

const SOURCE = join(ROOT, "native/calendar/main.swift");
const PLIST = join(ROOT, "native/calendar/Info.plist");
const BINARY = join(ROOT, ".build/dearbyte-calendar");
const TIMEOUT_MS = 15_000;
/** A title longer than this is cut: it's for recognizing the event, and it's text someone else may have written. */
const MAX_TITLE = 120;

const Output = z.object({
  status: z.enum(["granted", "not_determined", "denied", "write_only", "restricted", "error"]),
  message: z.string().optional(),
  events: z.array(z.object({ title: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(), firstDay: z.string().optional(), lastDay: z.string().optional() })).optional(),
});

const HELP: Record<string, string> = {
  not_determined: "DearByte hasn't been allowed to read your calendar yet. Run: npm run agent -- calendar",
  denied: "Calendar access was turned off. Turn it on in System Settings → Privacy & Security → Calendars (for your terminal app).",
  write_only: "DearByte can only add to your calendar, not read it. Allow full access in System Settings → Privacy & Security → Calendars.",
  restricted: "Calendar access is restricted on this Mac (a device policy).",
};

/** Set when a build failed, so a background check doesn't retry (and re-prompt) every 15 minutes. */
let buildFailure: Error | null = null;

/**
 * Builds the helper when it's missing or older than its source, once per run.
 * The plist gives macOS the reason it shows in the prompt. Without the Xcode
 * command line tools, swiftc is a stub that opens an install dialog, so that's
 * checked first.
 */
export function ensureCalendarHelper(): string {
  if (buildFailure) throw buildFailure;
  const stale = !existsSync(BINARY) || [SOURCE, PLIST].some((f) => statSync(BINARY).mtimeMs < statSync(f).mtimeMs);
  if (!stale) return BINARY;
  try {
    execFileSync("xcode-select", ["-p"], { stdio: "ignore" });
  } catch {
    throw (buildFailure = new Error("the calendar helper needs the Xcode command line tools (xcode-select --install)"));
  }
  try {
    mkdirSync(join(ROOT, ".build"), { recursive: true });
    // Built beside the old one and renamed over it, so two processes never run a half-written file.
    const temp = `${BINARY}.${process.pid}`;
    execFileSync("swiftc", ["-O", SOURCE, "-o", temp, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", PLIST], { stdio: "ignore" });
    renameSync(temp, BINARY);
    return BINARY;
  } catch {
    throw (buildFailure = new Error("the calendar helper didn't build (try: npm run agent -- calendar)"));
  }
}

/** Long enough for the user to answer the system prompt. */
const ACCESS_TIMEOUT_MS = 120_000;

const runHelper: Runner = (args) =>
  new Promise((resolve, reject) => {
    execFile(ensureCalendarHelper(), args, { maxBuffer: 5_000_000, timeout: args[0] === "access" ? ACCESS_TIMEOUT_MS : TIMEOUT_MS }, (err, stdout) => (stdout ? resolve(stdout) : reject(err ?? new Error("no output"))));
  });

function parse(stdout: string): z.infer<typeof Output> {
  const parsed = Output.safeParse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  if (!parsed.success) throw new Error("the calendar helper answered something unexpected");
  return parsed.data;
}

export class MacCalendar implements CalendarSource {
  constructor(private readonly run: Runner = runHelper) {}

  async events(from: Date, to: Date): Promise<CalendarResult> {
    let out;
    try {
      out = parse(await this.run(["events", from.toISOString().replace(/\.\d{3}Z$/, "Z"), to.toISOString().replace(/\.\d{3}Z$/, "Z")]));
    } catch (err) {
      return { status: "unavailable", access: "error", message: `The calendar couldn't be read: ${(err as Error).message.slice(0, 200)}` };
    }
    if (out.status !== "granted") {
      return { status: "unavailable", access: out.status, message: HELP[out.status] ?? out.message ?? "The calendar couldn't be read." };
    }
    const events = (out.events ?? [])
      .map((e) => ({
        title: e.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || "(no title)",
        start: new Date(e.start),
        end: new Date(e.end),
        allDay: e.allDay,
        ...(e.allDay && e.firstDay && e.lastDay ? { days: { first: e.firstDay, last: e.lastDay } } : {}),
      }))
      .filter((e) => !Number.isNaN(e.start.getTime()) && !Number.isNaN(e.end.getTime()));
    return { status: "ok", events };
  }

  /** Current access, without asking. */
  async access(): Promise<CalendarAccess | "error"> {
    try {
      return parse(await this.run(["status"])).status;
    } catch {
      return "error";
    }
  }

  /** Asks macOS for access; shows the system prompt the first time. */
  async requestAccess(): Promise<CalendarAccess | "error"> {
    try {
      return parse(await this.run(["access"])).status;
    } catch {
      return "error";
    }
  }
}
