// The watchlist: which companies to follow, where their official news is,
// and what the user cares about (the screen judges news against that). It
// lives in watchlist.json, which is personal and ignored by Git; see
// watchlist.example.json.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const Company = z.object({
  name: z.string().min(1),
  /** SEC's company number; filings are checked when it's set (and SEC_CONTACT_EMAIL is). */
  cik: z.number().int().positive().optional(),
  /** Official newsroom RSS or Atom feeds. */
  feeds: z.array(z.url({ protocol: /^https?$/ })).default([]),
});

export const Watchlist = z.object({
  /** In the user's words: why they follow these companies and what counts as worth a message. */
  interests: z.string().min(1),
  companies: z.array(Company).min(1),
});
export type Watchlist = z.infer<typeof Watchlist>;

/** The watchlist at `path`, null when there's no file, or the problem with it. */
export function loadWatchlist(path: string): Watchlist | { problem: string } | null {
  if (!existsSync(path)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { problem: `${path} isn't valid JSON: ${(err as Error).message}` };
  }
  const parsed = Watchlist.safeParse(json);
  return parsed.success ? parsed.data : { problem: `${path}: ${z.prettifyError(parsed.error)}` };
}
