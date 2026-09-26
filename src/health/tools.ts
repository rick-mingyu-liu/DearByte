// The agent's health tools. Each calls the bridge and returns a compact
// summary (see summary.ts), never raw samples. A bridge failure becomes an
// error result the model can explain ("your watch hasn't synced"), not a crash.

import { z } from "zod";
import { defineTool, type Tool } from "../agent/tools.ts";
import type { HealthMcpClient } from "./mcp-client.ts";
import { formatMinutes, summarizeSleep, summarizeVitals, VITALS } from "./summary.ts";

type Bridge = Pick<HealthMcpClient, "callTool">;

const HistoryEnvelope = z.object({ history: z.record(z.string(), z.array(z.unknown())).optional() });

async function history(bridge: Bridge, metric: string): Promise<unknown[]> {
  const parsed = HistoryEnvelope.safeParse(await bridge.callTool("watch_get_health_history", { metric }));
  return parsed.success ? (parsed.data.history?.[metric] ?? []) : [];
}

export function healthTools(bridge: Bridge, o: { timeZone: string; now?: () => Date }): Tool[] {
  const now = o.now ?? (() => new Date());
  return [
    defineTool({
      name: "get_sleep",
      description:
        "The user's most recent night of sleep from their Apple Watch (asleep time, deep/REM/core, bedtime and wake time) and the other recent nights for comparison. Says whether the latest night is actually last night.",
      input: z.object({}),
      run: async () => {
        const summary = summarizeSleep(await history(bridge, "sleep"), o.timeZone, now());
        if (summary.status === "no_data") return JSON.stringify(summary);
        const { latest, averageOtherNightsMinutes } = summary;
        return JSON.stringify({
          ...summary,
          readable: {
            latest: `${formatMinutes(latest.asleepMinutes)} asleep on the night ending ${latest.date}${latest.isLastNight ? " (last night)" : " (NOT last night: no newer data)"}`,
            average: averageOtherNightsMinutes === null ? "not enough other nights to compare" : `${formatMinutes(averageOtherNightsMinutes)} average over the other recorded nights`,
          },
        });
      },
    }),
    defineTool({
      name: "get_vitals",
      description:
        "The user's latest resting heart rate, heart rate variability (HRV), heart rate, respiratory rate, blood oxygen and VO2 max, each with how many hours old it is, the few most recent readings, and whether the phone's data is stale.",
      input: z.object({}),
      run: async () => {
        const latest = await bridge.callTool("watch_get_latest_health");
        const recent: Record<string, unknown[]> = {};
        for (const key of ["resting_heart_rate", "hrv_sdnn"] satisfies Array<keyof typeof VITALS>) recent[key] = await history(bridge, key);
        return JSON.stringify(summarizeVitals(latest, recent, now()));
      },
    }),
  ];
}
