// The user's calendar, read on this Mac. iCloud keeps the Mac's calendars in
// sync with the iPhone, so a small Swift helper (native/calendar) reading
// EventKit sees the same events, within seconds, without the calendar leaving
// the machine. Only titles and times are read.
//
// Everything else in DearByte uses the CalendarSource type, so a different
// source (the iPhone app through dearbyte-bridge, for a hosted DearByte) can
// replace this one without changing the tools or the rules.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
/** A small app, so macOS asks for access for DearByte Calendar itself rather than for whatever launched DearByte. */
const APP = join(ROOT, ".build/DearByte Calendar.app");
const BINARY = join(APP, "Contents/MacOS/dearbyte-calendar");
/** What the app was built from; see ensureCalendarHelper. */
const BUILT_FROM = join(ROOT, ".build/DearByte Calendar.sha256");
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
  denied: "Calendar access was turned off. Turn it on in System Settings → Privacy & Security → Calendars, for DearByte Calendar.",
  write_only: "DearByte can only add to your calendar, not read it. Allow full access in System Settings → Privacy & Security → Calendars.",
  restricted: "Calendar access is restricted on this Mac (a device policy).",
};

/** Set when a build failed, so a background check doesn't retry (and re-prompt) every 15 minutes. */
let buildFailure: Error | null = null;

/**
 * Builds the app when it's missing or its source changed, once per run.
 * macOS ties the calendar permission to the exact build, so it's rebuilt only
 * when the source's content changes (a git pull that only touches file times
 * doesn't cost the user their permission).
 * The plist gives macOS the reason it shows in the prompt. Without the Xcode
 * command line tools, swiftc is a stub that opens an install dialog, so that's
 * checked first.
 */
export function ensureCalendarHelper(): string {
  if (buildFailure) throw buildFailure;
  const source = createHash("sha256").update(readFileSync(SOURCE)).update(readFileSync(PLIST)).digest("hex");
  const built = existsSync(BINARY) && existsSync(BUILT_FROM) ? readFileSync(BUILT_FROM, "utf8").trim() : null;
  if (built === source) return APP;
  try {
    execFileSync("xcode-select", ["-p"], { stdio: "ignore" });
  } catch {
    throw (buildFailure = new Error("the calendar helper needs the Xcode command line tools (xcode-select --install)"));
  }
  try {
    // Built beside the old app and moved into place, so two processes never start a half-built one.
    const temp = join(ROOT, `.build/calendar-${process.pid}.app`);
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(join(temp, "Contents/MacOS"), { recursive: true });
    execFileSync("cp", [PLIST, join(temp, "Contents/Info.plist")]);
    execFileSync("swiftc", ["-O", SOURCE, "-o", join(temp, "Contents/MacOS/dearbyte-calendar")], { stdio: "ignore" });
    execFileSync("codesign", ["--force", "--sign", "-", temp], { stdio: "ignore" });
    rmSync(APP, { recursive: true, force: true });
    renameSync(temp, APP);
    writeFileSync(BUILT_FROM, `${source}\n`);
    rmSync(join(ROOT, ".build/dearbyte-calendar"), { force: true }); // the plain binary earlier versions built
    return APP;
  } catch {
    throw (buildFailure = new Error("the calendar helper didn't build (try: npm run agent -- calendar)"));
  }
}

/** Long enough for the user to answer the system prompt. */
const ACCESS_TIMEOUT_MS = 120_000;

/** Starts the app through macOS (`open`), waits for it, and reads what it printed from a private temp file. */
const runHelper: Runner = (args) =>
  new Promise((resolve, reject) => {
    let app: string;
    try {
      app = ensureCalendarHelper();
    } catch (err) {
      return reject(err);
    }
    const dir = mkdtempSync(join(tmpdir(), "dearbyte-calendar-"));
    const out = join(dir, "out.json");
    const done = (fn: () => void) => {
      rmSync(dir, { recursive: true, force: true });
      fn();
    };
    execFile("open", ["-n", "-W", "--stdout", out, "--stderr", "/dev/null", app, "--args", ...args], { timeout: args[0] === "access" ? ACCESS_TIMEOUT_MS : TIMEOUT_MS }, (err) => {
      let text = "";
      try {
        text = readFileSync(out, "utf8");
      } catch {
        // nothing printed
      }
      done(() => (text ? resolve(text) : reject(err ?? new Error("no output"))));
    });
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
