import { z } from "zod";
import { FACT_CATEGORIES, type Fact, type FactCandidate, type StoredMessage } from "../domain.ts";
import type { ChatModel } from "../model/provider.ts";
import type { Store, UpsertResult } from "../storage/store.ts";
import { describeNow } from "../companion/time.ts";

const CandidatesSchema = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(FACT_CATEGORIES),
        key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
        value: z.string().trim().min(1).max(80),
        event_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullish(),
        evidence: z.string().trim().min(1),
      }),
    )
    .max(5),
});

const EXTRACTION_PROMPT = `你是记忆记录员。你的任务是从用户最新的一条消息里，找出值得长期记住的关于用户的事实。

## 只记
- profile：用户的基本情况（工作、学校、城市等），用户自己说了才记
- preference：明确的喜好和讨厌
- event：有时间的计划或事件（考试、面试、出行、生日），尽量给出具体日期
- person：用户生活里的人（朋友、家人、同事），以及用户对他们的称呼
- pet：宠物
- shared：你们之间的梗、约定
- style：用户对你说话方式的要求：怎么称呼用户、哪个昵称别用、说话长短、语气、别提的话题。用户明确要求了才记（“叫我瑞克”“别叫我宝宝”“说话短点”“别老提工作”），value 写成“用户希望……”或“用户不喜欢……”

## 不记
- 一时的情绪和状态（“今天好累”“有点饿”），除非它是一件会持续的事
- 助手说的话、猜测或建议，只有用户自己说出或明确确认的才算
- 从图片外观推测出的身份、位置、归属

## 规则
- evidence 必须是从用户消息里原样复制的一段话，一个字都不能改。
- 相对日期（明天、下周六）按“消息时间”换算成 YYYY-MM-DD；算不准就填 null，不要猜。
- 已有记录里如果有同一件事，沿用它的 key，写上新的 value（比如搬家、换工作、改期）。
- key 用小写英文和下划线，比如 ielts_exam、favorite_drink、friend_xiaomei。
- value 用简短中文写成一句话，以“用户”开头，比如“用户在准备雅思考试”。
- value 里不要出现任何日期或相对时间词（今天、明天、下周六、最近），日期只写在 event_date。过几天再读，“下周六”就错了。
- 没有值得记的，就返回空列表。宁可少记，不要多记。

只输出 JSON：{"facts": [{"category": "...", "key": "...", "value": "...", "event_date": "YYYY-MM-DD 或 null", "evidence": "..."}]}`;

export type ExtractionOutcome = {
  results: Array<{ key: string; value: string; result: UpsertResult }>;
  rejected: Array<{ key: string; reason: string }>;
};

const normalize = (s: string) => s.replace(/\s+/g, "");

function buildInput(opts: {
  userMessage: StoredMessage;
  previousAssistant: StoredMessage | null;
  facts: Fact[];
  timeZone: string;
}): string {
  const existing = opts.facts.length
    ? opts.facts.map((f) => `- ${f.key}: ${f.value}${f.eventDate ? `（${f.eventDate}）` : ""}`).join("\n")
    : "（无）";
  const assistant = opts.previousAssistant?.bubbles?.join(" / ") ?? "（无）";
  return [
    `消息时间：${describeNow(new Date(opts.userMessage.createdAt), opts.timeZone)}（${opts.timeZone}）`,
    `已有记录：\n${existing}`,
    `助手上一句（仅供理解上下文，不能作为事实来源）：${assistant}`,
    `用户消息：${opts.userMessage.text}`,
  ].join("\n\n");
}

/**
 * Proposes facts from one user message and stores those that pass validation.
 * Evidence must be a verbatim quote of the user's message; anything else is
 * rejected so the model cannot promote its own guesses into memory.
 */
export async function extractFacts(opts: {
  model: ChatModel;
  store: Store;
  userMessage: StoredMessage;
  previousAssistant: StoredMessage | null;
  timeZone: string;
}): Promise<ExtractionOutcome> {
  const outcome: ExtractionOutcome = { results: [], rejected: [] };
  if (!opts.userMessage.text.trim()) return outcome;

  const completion = await opts.model.complete(
    [
      { role: "system", content: EXTRACTION_PROMPT },
      {
        role: "user",
        content: buildInput({ ...opts, facts: opts.store.activeFacts() }),
      },
    ],
    { json: true, temperature: 0, maxTokens: 1_500 }, // room for deepseek-flash to reason first
  );

  let parsed: z.infer<typeof CandidatesSchema>;
  try {
    const result = CandidatesSchema.safeParse(JSON.parse(completion.text));
    if (!result.success) {
      outcome.rejected.push({ key: "*", reason: `invalid extraction output: ${result.error.issues[0]?.message}` });
      return outcome;
    }
    parsed = result.data;
  } catch {
    outcome.rejected.push({ key: "*", reason: "extraction output is not JSON" });
    return outcome;
  }

  const source = normalize(opts.userMessage.text);
  for (const f of parsed.facts) {
    if (!source.includes(normalize(f.evidence))) {
      outcome.rejected.push({ key: f.key, reason: "evidence is not a quote of the user's message" });
      continue;
    }
    const candidate: FactCandidate = {
      category: f.category,
      key: f.key,
      value: f.value,
      eventDate: f.event_date ?? null,
      evidence: f.evidence,
    };
    outcome.results.push({ key: f.key, value: f.value, result: opts.store.upsertFact(candidate, opts.userMessage) });
  }
  return outcome;
}
