// One real call through the agent model, to check the key and the request
// shape: Claude should call the fake tool below. Costs well under a cent.
//
//   npm run agent:smoke        # needs ANTHROPIC_API_KEY in .env or the environment

import Anthropic from "@anthropic-ai/sdk";
import { ClaudeAgentModel } from "../src/agent/model.ts";

const model = new ClaudeAgentModel();
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
  console.log(`model ${step.model} · stop ${step.stopReason} · ${step.ms} ms · $${cost?.toFixed(5) ?? "?"}`);
  for (const block of step.content) {
    if (block.type === "tool_use") console.log(`tool_use ${block.name} ${JSON.stringify(block.input)}`);
    else if (block.type === "text") console.log(`text ${block.text}`);
  }
  process.exitCode = step.stopReason === "tool_use" ? 0 : 1;
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("The API key was rejected.");
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else console.error((err as Error).message);
  process.exitCode = 1;
}
