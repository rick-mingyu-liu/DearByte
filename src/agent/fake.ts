import type { AgentBlock, AgentModel, AgentRequest, AgentStep, AgentStopReason } from "./model.ts";
import type { Usage } from "../model/provider.ts";

type Scripted = { content: AgentBlock[]; stopReason?: AgentStopReason };

/** Deterministic test double for the agent: plays back scripted steps and records every request. */
export class FakeAgentModel implements AgentModel {
  readonly name = "fake";
  readonly requests: AgentRequest[] = [];
  private readonly queue: Scripted[];

  constructor(steps: Scripted[] = []) {
    this.queue = [...steps];
  }

  /** A plain text answer. */
  static text(text: string): Scripted {
    return { content: [{ type: "text", text, citations: null }], stopReason: "end_turn" };
  }

  /** One tool call. */
  static toolUse(name: string, input: unknown, id = `toolu_${name}`): Scripted {
    return { content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }], stopReason: "tool_use" };
  }

  async step(req: AgentRequest): Promise<AgentStep> {
    this.requests.push(req);
    const next = this.queue.shift() ?? FakeAgentModel.text("（假模型）收到");
    return {
      content: next.content,
      stopReason: next.stopReason ?? "end_turn",
      model: this.name,
      usage: { promptTokens: 0, cacheHitTokens: 0, completionTokens: 0 },
      ms: 0,
    };
  }

  cost(_usage: Usage): number {
    return 0;
  }
}
