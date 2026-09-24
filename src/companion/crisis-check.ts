// A model check for crisis messages the keyword list misses (「活着没意思」
// 「好想睡过去不醒来」). It runs alongside the reply, so it adds no delay
// unless it fires; then the reply is rewritten with the safety prompt.

import { z } from "zod";
import type { ChatModel } from "../model/provider.ts";

const PROMPT = `判断用户这条消息有没有人身安全风险：想死、不想活、自伤的念头或计划；正在被打、被伤害、被威胁、被控制或跟踪；被逼迫发生性行为或被用私密照片威胁。

- 只看用户自己的处境和真实意思。
- 夸张的口头禅不算：“累死了”“笑死”“饿死了”“气死我了”“社死”“想死你了”。
- 说的是电影、新闻、别人的事，不算，除非用户自己也有危险。
- 拿不准、但有可能是真的，就算有风险。

只输出 JSON：{"risk": true} 或 {"risk": false}`;

const ResultSchema = z.object({ risk: z.boolean() });

/** True when the model thinks the message signals real danger. Unusable output counts as no risk: the keywords still apply. */
export async function modelSeesCrisis(model: ChatModel, text: string, previous?: string): Promise<boolean> {
  const content = previous ? `用户上一条：${previous}\n用户这一条：${text}` : `用户这一条：${text}`;
  const completion = await model.complete(
    [
      { role: "system", content: PROMPT },
      { role: "user", content },
    ],
    { json: true, temperature: 0, maxTokens: 1_000 },
  );
  try {
    const parsed = ResultSchema.safeParse(JSON.parse(completion.text));
    return parsed.success && parsed.data.risk;
  } catch {
    return false;
  }
}
