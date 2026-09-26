// Which tools the agent gets, from what is set up: health tools when
// HEALTH_MCP_URL is set, memory tools always (they report when memory is off).

import { z } from "zod";
import { localDate } from "../companion/time.ts";
import { HealthMcpClient } from "../health/mcp-client.ts";
import { healthTools } from "../health/tools.ts";
import type { Store } from "../storage/store.ts";
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

export function agentToolset(o: { store: Pick<Store, "memoryEnabled" | "activeFacts">; timeZone: string; healthMcpUrl: string | null }): {
  tools: ToolRegistry;
  health: boolean;
} {
  const tools = [...memoryTools(o.store, o.timeZone)];
  if (o.healthMcpUrl) tools.push(...healthTools(new HealthMcpClient(o.healthMcpUrl), { timeZone: o.timeZone }));
  return { tools: new ToolRegistry(tools), health: Boolean(o.healthMcpUrl) };
}
