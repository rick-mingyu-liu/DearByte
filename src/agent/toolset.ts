// Which tools the agent gets, from what is set up: health tools when
// HEALTH_MCP_URL is set, news when there's a watchlist, memory tools always
// (they report when memory is off).

import { z } from "zod";
import { localDate } from "../companion/time.ts";
import { HealthMcpClient } from "../health/mcp-client.ts";
import { healthTools } from "../health/tools.ts";
import type { Store } from "../storage/store.ts";
import type { Watchlist } from "../watchlist/config.ts";
import { watchlistTools } from "../watchlist/tools.ts";
import { defineTool, ToolRegistry, type Tool } from "./tools.ts";

export function memoryTools(store: Pick<Store, "memoryEnabled" | "activeFacts">, timeZone: string): Tool[] {
  return [
    defineTool({
      name: "read_memory",
      description:
        "What the user has told DearByte to remember: preferences, people, upcoming events, how they like to be spoken to. Each fact has a category and, for events, a date.",
      input: z.object({}),
      run: async () => {
        if (!store.memoryEnabled()) return JSON.stringify({ status: "off", message: "Long-term memory is turned off, so nothing is remembered." });
        const facts = store.activeFacts().map((f) => ({
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
  return { tools: new ToolRegistry(tools), health: Boolean(bridge), bridge };
}
