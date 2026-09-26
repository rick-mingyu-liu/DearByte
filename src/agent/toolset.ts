// Which tools the agent gets, from what is set up: health tools when
// HEALTH_MCP_URL is set, news when there's a watchlist, buying when there's a
// wallet, memory tools always
// (they report when memory is off).

import { z } from "zod";
import { localDate } from "../companion/time.ts";
import { HealthMcpClient } from "../health/mcp-client.ts";
import { healthTools } from "../health/tools.ts";
import type { Store } from "../storage/store.ts";
import type { Watchlist } from "../watchlist/config.ts";
import { watchlistTools } from "../watchlist/tools.ts";
import { walletTools, type WalletDeps } from "../wallet/purchase.ts";
import { defineTool, ToolRegistry, type Tool } from "./tools.ts";

export function memoryTools(store: Pick<Store, "memoryEnabled" | "activeFacts">, timeZone: string): Tool[] {
  return [
    defineTool({
      name: "read_memory",
      description:
        "What the user has told DearByte to remember: preferences, people, upcoming events. Each fact has a category and, for events, a date.",
      input: z.object({}),
      run: async () => {
        if (!store.memoryEnabled()) return JSON.stringify({ status: "off", message: "Long-term memory is turned off, so nothing is remembered." });
        // Style facts are how 小拜, the companion, talks to the user (nicknames, language, tone). They set her voice, not the agent's.
        const facts = store.activeFacts().filter((f) => f.category !== "style").map((f) => ({
          category: f.category,
          fact: f.value,
          ...(f.eventDate ? { date: f.eventDate } : {}),
          recorded: localDate(new Date(f.updatedAt), timeZone),
        }));
        return JSON.stringify(facts.length ? { status: "ok", facts } : { status: "empty", message: "Memory is on, but nothing is remembered yet." });
      },
    }),
  ];
}

export function agentToolset(o: {
  store: Pick<Store, "memoryEnabled" | "activeFacts" | "recentWatchItems">;
  timeZone: string;
  healthMcpUrl: string | null;
  watchlist?: Watchlist | null;
  /** The wallet's tools, when a wallet is set up. */
  wallet?: WalletDeps | null;
}): {
  tools: ToolRegistry;
  health: boolean;
  /** The bridge client, when health is set up. */
  bridge: HealthMcpClient | null;
} {
  const tools = [...memoryTools(o.store, o.timeZone)];
  const bridge = o.healthMcpUrl ? new HealthMcpClient(o.healthMcpUrl) : null;
  if (bridge) tools.push(...healthTools(bridge, { timeZone: o.timeZone }));
  if (o.watchlist) tools.push(...watchlistTools(o.store, o.watchlist));
  if (o.wallet) tools.push(...walletTools(o.wallet));
  return { tools: new ToolRegistry(tools), health: Boolean(bridge), bridge };
}
