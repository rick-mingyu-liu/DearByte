import type { AgentBlock, AgentModel, AgentRequest, AgentStep, AgentStopReason } from "./model.ts";
import type { Usage } from "../model/provider.ts";

type Scripted = { content: AgentBlock[]; stopReason?: AgentStopReason | null };

/** Deterministic test double for the agent: plays back scripted steps and records every request. */
export class FakeAgentModel implements AgentModel {
  readonly name = "fake";
  readonly requests: AgentRequest[] = [];
  private readonly queue: Scripted[];

  constructor(
    steps: Scripted[] = [],
    private readonly costPerStep = 0,
  ) {
    this.queue = [...steps];
  }

  /** A plain text answer. */
  static text(text: string): Scripted {
    return { content: [{ type: "text", text, citations: null }], stopReason: "end_turn" };
  }

  /** One or more tool calls in one turn: [name, input] pairs. */
  static toolUse(...calls: Array<[name: string, input: unknown]>): Scripted {
    return {
      content: calls.map(([name, input], i) => ({ type: "tool_use" as const, id: `toolu_${i}_${name}`, name, input, caller: { type: "direct" as const } })),
      stopReason: "tool_use",
    };
  }

  async step(req: AgentRequest): Promise<AgentStep> {
    // Copy, so later pushes to the conversation don't change what was recorded.
    this.requests.push({ ...req, messages: [...req.messages] });
    const next = this.queue.shift() ?? FakeAgentModel.text("（假模型）收到");
    return {
      content: next.content,
      stopReason: next.stopReason === undefined ? "end_turn" : next.stopReason,
      model: this.name,
      usage: { promptTokens: 0, cacheHitTokens: 0, completionTokens: 0 },
      ms: 0,
    };
  }

  cost(_usage: Usage): number {
    return this.costPerStep;
  }
}
