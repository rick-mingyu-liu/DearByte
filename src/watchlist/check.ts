// One watchlist check: fetch official news, keep what's new, screen it with
// the cheap worker model against what the user cares about, and have the
// brain write one message about what passed.
//
// Code decides everything but the words: which items are new (dedupe by
// source id), which are too old to bother with, and when a message may go
// (not in quiet hours, at most MAX_NEWS_PER_DAY). The worker only records a
// verdict per item, through a validated tool call. Links in the message come
// from the stored items, never from the model.

import { z } from "zod";
import { localDate } from "../companion/time.ts";
import { runAgent } from "../agent/loop.ts";
import type { AgentModel } from "../agent/model.ts";
import { compose, deliver, inQuietHours, SCHEDULED, unwritten, type ComposeDeps, type DeliverDeps, type Outcome } from "../agent/scheduled.ts";
import { defineTool, ToolRegistry } from "../agent/tools.ts";
import type { Store, WatchItem } from "../storage/store.ts";
import type { Watchlist } from "./config.ts";
import { fetchFeed, fetchFilings, type NewsItem } from "./sources.ts";

/** Items first seen after this long are recorded but never screened. */
export const FRESH_HOURS = 48;
/** Unsent items this old are dropped: late news isn't news. */
export const STALE_HOURS = 72;
export const MAX_NEWS_PER_DAY = 3;
/** Items screened per check; the rest wait for the next check. */
export const SCREEN_BATCH = 15;
/** Items per message; the rest go in the next one. */
const MESSAGE_BATCH = 5;
const HOUR = 3_600_000;

export type WatchlistDeps = ComposeDeps &
  DeliverDeps & {
    store: Pick<Store, "addWatchItems" | "watchItemsWithStatus" | "setWatchItemStatus" | "recordAlert" | "alertsOn" | "markAlertDelivered">;
    /** Screens items; the brain (`model`) writes the message. */
    worker: AgentModel;
    watchlist: Watchlist;
    /** SEC needs a contact email; without it, filings are skipped. */
    secContact: string | null;
    fetch?: typeof fetch;
    now?: () => Date;
  };

export type WatchOutcome = {
  /** New items stored this check. */
  added: number;
  screened: number;
  relevant: number;
  /** Sources that failed; the others still count. */
  errors: string[];
  message: Outcome | null;
};

async function gather(d: WatchlistDeps): Promise<{ items: NewsItem[]; errors: string[] }> {
  const jobs: Array<{ label: string; run: () => Promise<NewsItem[]> }> = [];
  for (const c of d.watchlist.companies) {
    for (const feed of c.feeds) jobs.push({ label: `${c.name} newsroom`, run: () => fetchFeed(feed, c.name, d.fetch) });
    if (c.cik && d.secContact) jobs.push({ label: `${c.name} SEC filings`, run: () => fetchFilings(c.cik!, c.name, d.secContact!, d.fetch) });
  }
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const items: NewsItem[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? items.push(...r.value) : errors.push(`${jobs[i].label}: ${(r.reason as Error).message}`)));
  return { items, errors };
}

const SCREEN_SYSTEM = `You screen company news for one person. For each numbered item, decide whether it's worth interrupting them for, judged only against what they say they care about. Be strict: most items are not. Record every verdict with the record_verdicts tool, in one call, then reply "done".`;

/** Asks the worker for a verdict on each item. Items it skips stay unscreened. */
async function screen(d: WatchlistDeps, items: WatchItem[]): Promise<{ verdicts: Map<number, { relevant: boolean; reason: string }>; stop: string }> {
  const verdicts = new Map<number, { relevant: boolean; reason: string }>();
  const tool = defineTool({
    name: "record_verdicts",
    description: "Records whether each numbered news item is worth a message to the user, with a one-line reason.",
    input: z.object({
      verdicts: z
        .array(z.object({ n: z.number().int().min(1).describe("The item's number"), relevant: z.boolean(), reason: z.string().min(1).max(300) }))
        .min(1),
    }),
    run: async ({ verdicts: vs }) => {
      for (const v of vs) if (items[v.n - 1]) verdicts.set(items[v.n - 1].id, { relevant: v.relevant, reason: v.reason });
      return `Recorded ${vs.length} verdicts.`;
    },
  });
  const list = items
    .map((it, i) => `${i + 1}. [${it.company}, ${it.source === "sec" ? "SEC filing" : "newsroom"}] ${it.title}${it.summary ? `\n   ${it.summary}` : ""}`)
    .join("\n");
  const result = await runAgent({
    model: d.worker,
    tools: new ToolRegistry([tool]),
    system: SCREEN_SYSTEM,
    messages: [{ role: "user", content: `What they care about:\n${d.watchlist.interests}\n\nItems:\n${list}` }],
    maxSteps: 3,
    purpose: "news_screen",
    onEvent: d.onEvent,
  });
  return { verdicts, stop: result.stop };
}

export async function checkWatchlist(d: WatchlistDeps): Promise<WatchOutcome> {
  const now = (d.now ?? (() => new Date()))();
  const { items, errors } = await gather(d);
  const fresh = (iso: string, hours: number) => now.getTime() - Date.parse(iso) < hours * HOUR;
  const added = d.store.addWatchItems(
    items.map((i) => ({ ...i, status: fresh(i.publishedAt, FRESH_HOURS) ? "new" : "old" })),
    now.toISOString(),
  );
  // Anything that waited too long, unscreened or unsent, is dropped.
  for (const status of ["new", "relevant"] as const) {
    for (const i of d.store.watchItemsWithStatus(status)) if (!fresh(i.publishedAt, STALE_HOURS)) d.store.setWatchItemStatus(i.id, "old");
  }
  const outcome: WatchOutcome = { added: added.length, screened: 0, relevant: 0, errors, message: null };

  const pending = d.store.watchItemsWithStatus("new").slice(0, SCREEN_BATCH);
  if (pending.length) {
    const { verdicts, stop } = await screen(d, pending);
    if (stop === "weekly_cap") {
      outcome.message = await unwritten(d, now, { text: null, stop }, []);
      return outcome;
    }
    for (const [id, v] of verdicts) d.store.setWatchItemStatus(id, v.relevant ? "relevant" : "skipped", v.reason);
    outcome.screened = verdicts.size;
    outcome.relevant = [...verdicts.values()].filter((v) => v.relevant).length;
  }

  const ready = d.store.watchItemsWithStatus("relevant").slice(-MESSAGE_BATCH);
  if (!ready.length) return outcome;
  if (inQuietHours(now, d.timeZone)) return { ...outcome, message: { sent: false, reason: "quiet hours", triggers: [] } };
  if (d.store.alertsOn(localDate(now, d.timeZone)).filter((a) => a.kind === "news").length >= MAX_NEWS_PER_DAY) {
    return { ...outcome, message: { sent: false, reason: "daily news limit reached", triggers: [] } };
  }

  const described = ready
    .map((it, i) => `${i + 1}. ${it.company} (${it.source === "sec" ? "SEC filing" : "official newsroom"}, ${it.publishedAt.slice(0, 10)}): ${it.title}${it.summary ? `\n   ${it.summary}` : ""}\n   Why it passed the screen: ${it.reason}`)
    .join("\n");
  const c = await compose(
    d,
    "news_alert",
    `${SCHEDULED}\nNew from companies the user follows:\n${described}\n\nWrite a short heads-up, at most two sentences per item: what happened, using only what the item says, and why it matters to them, tied to what they said they care about. Say when something is a filing rather than a press release. Claim nothing the item doesn't say: no "first time", no guesses about coverage, markets or stock prices, and no investment advice. Don't add links (they're appended for you). No greeting.`,
    now,
  );
  if (c.text === null) return { ...outcome, message: await unwritten(d, now, c, []) };
  const sources = ready.map((it) => `- ${it.title}: ${it.url}`).join("\n");
  outcome.message = await deliver(d, now, "news", "DearByte news", `${c.text}\n\nSources:\n${sources}`, [], ready.map((it) => `news:${it.id}`));
  for (const it of ready) d.store.setWatchItemStatus(it.id, "sent");
  return outcome;
}
