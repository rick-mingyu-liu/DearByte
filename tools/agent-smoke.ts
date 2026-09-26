// One real call through an agent tier, to check the key and the request
// shape: the model should call the fake calendar tool below. Costs well under a cent.
//
//   npm run agent:smoke            # the worker tier (DeepSeek by default)
//   npm run agent:smoke -- brain   # the brain tier (DEARBYTE_BRAIN in .env)

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.ts";
import { createTierModels, TIERS, type Tier } from "../src/agent/tiers.ts";

const tier = (process.argv[2] ?? "worker") as Tier;
const config = loadConfig();
if (!TIERS.includes(tier)) throw new Error(`tier should be one of ${TIERS.join(", ")}`);
if ("problem" in config.agent) {
  console.error(config.agent.problem);
  process.exit(1);
}
const model = createTierModels(config.agent)[tier];
try {
  const step = await model.step({
    system: "You are DearByte's agent. Use tools when they help.",
    messages: [{ role: "user", content: "What's on my calendar today?" }],
    tools: [
      {
        name: "get_calendar",
        description: "Events on the user's calendar for the next N days.",
        input_schema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 7 } }, required: ["days"] },
      },
    ],
    maxTokens: 2_000,
  });
  const cost = model.cost(step.usage);
  console.log(`${tier}: asked ${model.name}, answered by ${step.model} · stop ${step.stopReason} · ${step.ms} ms · $${cost?.toFixed(5) ?? "?"}`);
  for (const block of step.content) {
    if (block.type === "tool_use") console.log(`tool_use ${block.name} ${JSON.stringify(block.input)}`);
    else if (block.type === "text") console.log(`text ${block.text}`);
    else console.log(block.type);
  }
  process.exitCode = step.stopReason === "tool_use" ? 0 : 1;
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("The API key was rejected.");
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else console.error((err as Error).message);
  process.exitCode = 1;
}
