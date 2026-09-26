// A real run of the agent loop on one tier, with two sample tools that return
// made-up data. Checks the key, the request shape, tool calls, and passing
// thinking blocks back across steps (DeepSeek answers 400 if that's wrong).
// Costs well under a cent on DeepSeek, and is recorded in the usage log.
//
//   npm run agent:smoke            # the worker tier (DeepSeek by default)
//   npm run agent:smoke -- brain   # the brain tier (DEARBYTE_BRAIN in .env)

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { runAgent } from "../src/agent/loop.ts";
import { createTierModels, TIERS, type Tier } from "../src/agent/tiers.ts";
import { defineTool, ToolRegistry } from "../src/agent/tools.ts";
import { Store } from "../src/storage/store.ts";

const tier = (process.argv[2] ?? "worker") as Tier;
if (!TIERS.includes(tier)) throw new Error(`tier should be one of ${TIERS.join(", ")}`);
const config = loadConfig();
if ("problem" in config.agent) {
  console.error(config.agent.problem);
  process.exit(1);
}
// Logged like any other run, and stopped by the weekly cap like any other run.
const store = Store.open(config.dbPath);
const model = createTierModels(config.agent, { store, weeklyCap: config.agentWeeklyCap })[tier];

// Sample data only: nothing here is real.
const tools = new ToolRegistry([
  defineTool({
    name: "get_sleep",
    description: "Last night's sleep and the user's 7-day average.",
    input: z.object({}),
    run: async () => JSON.stringify({ sample: true, asleep: "5h10m", average7d: "7h05m", restingHr: 64, restingHrAverage7d: 56 }),
  }),
  defineTool({
    name: "get_calendar",
    description: "Events on the user's calendar for the next N days.",
    input: z.object({ days: z.number().int().min(1).max(7) }),
    run: async ({ days }) => JSON.stringify({ sample: true, days, events: [{ time: "10:00-16:00", title: "Meetings" }, { time: "19:00", title: "Leg day at the gym" }] }),
  }),
]);

try {
  const result = await runAgent({
    model,
    tools,
    system: "You are DearByte's agent. Use tools to check facts before answering. Be brief.",
    messages: [{ role: "user", content: "How did I sleep, and should I still do leg day tonight?" }],
    purpose: "smoke",
    onEvent: (e) =>
      console.log(
        e.type === "step"
          ? `step ${e.n}: ${e.model} · stop ${e.stopReason} · ${e.ms} ms · $${e.cost?.toFixed(5) ?? "?"}`
          : `  tool ${e.name} ${e.ok ? "ok" : "failed"} (${e.ms} ms)`,
      ),
  });
  console.log(`\n${result.stop} after ${result.steps} steps · $${result.cost.toFixed(5)}\n${result.text}`);
  process.exitCode = result.stop === "done" ? 0 : 1;
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("The API key was rejected.");
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
