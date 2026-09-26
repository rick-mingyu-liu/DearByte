// The agent's view of the watchlist: what's been seen lately, with the
// screen's verdicts, so "anything new on Meta?" is answered from what
// DearByte already checked instead of from the model's memory.

import { z } from "zod";
import { defineTool, type Tool } from "../agent/tools.ts";
import type { Store } from "../storage/store.ts";
import type { Watchlist } from "./config.ts";

const DAYS = 14;

export function watchlistTools(store: Pick<Store, "recentWatchItems">, watchlist: Watchlist, now: () => Date = () => new Date()): Tool[] {
  const names = watchlist.companies.map((c) => c.name);
  return [
    defineTool({
      name: "get_company_news",
      description: `Recent news DearByte collected from official sources (company newsrooms and SEC filings) for the companies the user follows: ${names.join(", ")}. Covers the last ${DAYS} days, newest first, with whether each item was judged worth telling the user and why. Only as fresh as the last watchlist check.`,
      input: z.object({ company: z.string().optional().describe(`One of: ${names.join(", ")}. Leave out for all.`) }),
      run: async ({ company }) => {
        if (company && !names.some((n) => n.toLowerCase() === company.toLowerCase())) {
          return JSON.stringify({ status: "not_followed", message: `${company} isn't on the watchlist. Followed: ${names.join(", ")}.` });
        }
        const since = new Date(now().getTime() - DAYS * 86_400_000).toISOString();
        const items = store.recentWatchItems(since, company).map((i) => ({
          company: i.company,
          source: i.source === "sec" ? "SEC filing" : "newsroom",
          title: i.title,
          url: i.url,
          published: i.publishedAt.slice(0, 10),
          ...(i.summary ? { summary: i.summary } : {}),
          verdict: i.status === "sent" ? "told the user" : i.status === "relevant" ? "worth telling, not sent yet" : i.status === "skipped" ? "not worth a message" : "not screened",
          ...(i.reason ? { why: i.reason } : {}),
        }));
        return JSON.stringify(items.length ? { status: "ok", items } : { status: "empty", message: `Nothing collected in the last ${DAYS} days. Has the watchlist been checked (npm run agent -- news)?` });
      },
    }),
  ];
}
