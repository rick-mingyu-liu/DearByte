import type { ChatMessage, ImageInput, StoredMessage } from "../domain.ts";
import { extractFacts, type ExtractionOutcome } from "../memory/extract.ts";
import { SUMMARY_SETTING, updateSummary, type SummaryOutcome } from "../memory/summary.ts";
import type { ChatModel, Completion } from "../model/provider.ts";
import type { Store } from "../storage/store.ts";
import { FALLBACK_REPLY, parseReply, type Reply } from "./output.ts";
import { buildMessages, buildSystemPrompt, factsForPrompt, recentPhrases, type PromptParts } from "./prompt.ts";
import { modelSeesCrisis } from "./crisis-check.ts";
import { looksLikeCrisis } from "./safety.ts";
import { localDate } from "./time.ts";

/** When the last crisis turn was (ISO), by keywords or the model; proactive messages stay gentle after it. */
export const CRISIS_AT_SETTING = "crisis_at";
/** The crisis check gets this long in total; a slow check counts as no risk. */
const CRISIS_CHECK_WAIT_MS = 8_000;

/** Bubbles per reply outside a crisis. */
export const CHAT_MAX_BUBBLES = 2;

export type CompanionEvent =
  | { type: "context"; historyMessages: number; facts: number; memoryEnabled: boolean; crisis: boolean; image: boolean }
  | { type: "model"; purpose: "reply" | "repair" | "memory" | "safety"; ms: number; promptTokens: number; cacheHitTokens: number; completionTokens: number; cost: number | null }
  | { type: "reply_invalid"; problems: string[]; action: "repair" | "salvage" | "fallback" }
  | { type: "reply_trimmed"; dropped: string[] }
  | { type: "crisis_detected"; by: "model" }
  | { type: "memory"; outcome: ExtractionOutcome }
  | { type: "memory_error"; message: string }
  | { type: "summary"; outcome: NonNullable<SummaryOutcome> };

/** A message 小拜 may send first; `commit` stores what was actually sent. */
export type Initiative = { bubbles: string[]; commit: (sent: string[]) => void };

export type TurnResult = {
  reply: Reply;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  /** Resolves when background memory extraction finishes (null when memory is off). */
  memory: Promise<ExtractionOutcome | null>;
};

export class Companion {
  constructor(
    private readonly deps: {
      store: Store;
      model: ChatModel;
      parts: PromptParts;
      timeZone: string;
      historyMessages: number;
      /** Also ask the model whether a message signals danger the keywords missed. */
      crisisCheck?: boolean;
      now?: () => Date;
      onEvent?: (event: CompanionEvent) => void;
    },
  ) {}

  /** The last summary fold; the next one waits for it. */
  private summaries: Promise<unknown> = Promise.resolve();

  private emit(event: CompanionEvent) {
    this.deps.onEvent?.(event);
  }

  private async call(messages: ChatMessage[], purpose: "reply" | "repair" | "memory"): Promise<Completion> {
    const completion = await this.deps.model.complete(messages, { json: true });
    this.emit({ type: "model", purpose, ms: completion.ms, ...completion.usage, cost: this.deps.model.cost(completion.usage) });
    return completion;
  }

  async handle(input: { text: string; image?: ImageInput }): Promise<TurnResult> {
    const { store, model, parts, timeZone } = this.deps;
    if (input.image && !model.vision) throw new Error(`${model.name} cannot read images`);

    const now = this.deps.now?.() ?? new Date();
    const history = store.recentMessages(this.deps.historyMessages);
    const previousAssistant = [...history].reverse().find((m) => m.role === "assistant") ?? null;
    const userMessage = store.addMessage("user", input.text, { hasImage: Boolean(input.image), createdAt: now.toISOString() });

    const memoryEnabled = store.memoryEnabled();
    const facts = memoryEnabled ? factsForPrompt(store.activeFacts(), localDate(now, timeZone)) : [];
    let crisis = looksLikeCrisis(input.text);
    this.emit({ type: "context", historyMessages: history.length, facts: facts.length, memoryEnabled, crisis, image: Boolean(input.image) });

    // The model check runs alongside the reply; it only costs time when it fires.
    const check =
      !crisis && this.deps.crisisCheck && input.text.trim()
        ? this.crisisCheck(input.text, [...history].reverse().find((m) => m.role === "user")?.text)
        : null;

    const summary = memoryEnabled ? store.getSetting(SUMMARY_SETTING) : null;
    const prompt = (crisis: boolean) =>
      buildMessages(buildSystemPrompt(parts, { now, timeZone, memoryEnabled, facts, crisis, recent: recentPhrases(history), summary }), history, input);
    let reply = await this.generate(prompt(crisis));
    if (check && (await check)) {
      crisis = true;
      this.emit({ type: "crisis_detected", by: "model" });
      reply = await this.generate(prompt(true));
    }
    if (crisis) store.setSetting(CRISIS_AT_SETTING, now.toISOString());
    // A third bubble reads as an AI over-explaining. Crisis replies keep all of
    // theirs: the safety prompt needs room for the hotline numbers.
    if (!crisis && reply.bubbles.length > CHAT_MAX_BUBBLES) {
      this.emit({ type: "reply_trimmed", dropped: reply.bubbles.slice(CHAT_MAX_BUBBLES) });
      reply = { bubbles: reply.bubbles.slice(0, CHAT_MAX_BUBBLES) };
    }

    const assistantMessage = store.addMessage("assistant", reply.bubbles.join("\n"), {
      bubbles: reply.bubbles,
      createdAt: new Date(Math.max(Date.now(), now.getTime() + 1)).toISOString(),
    });

    const trackedModel: ChatModel = {
      name: model.name,
      vision: model.vision,
      cost: (usage) => model.cost(usage),
      complete: async (msgs, opts) => {
        const completion = await model.complete(msgs, opts);
        this.emit({ type: "model", purpose: "memory", ms: completion.ms, ...completion.usage, cost: model.cost(completion.usage) });
        return completion;
      },
    };
    const memory = memoryEnabled
      ? extractFacts({ model: trackedModel, store, userMessage, previousAssistant, timeZone })
          .then((outcome) => {
            this.emit({ type: "memory", outcome });
            return outcome;
          })
          .then(async (outcome) => {
            // Messages that just left the window get folded into the summary,
            // one fold at a time so two turns can't fold the same span.
            const fold = this.summaries.then(() => updateSummary({ model: trackedModel, store, window: this.deps.historyMessages, timeZone }));
            this.summaries = fold.catch(() => null);
            const folded = await fold;
            if (folded) this.emit({ type: "summary", outcome: folded });
            return outcome;
          })
          .catch((err: Error) => {
            // Extraction failure is visible but never fails the reply.
            this.emit({ type: "memory_error", message: err.message });
            return null;
          })
      : Promise.resolve(null);

    return { reply, userMessage, assistantMessage, memory };
  }

  /**
   * 小拜 messages first. `note` says why (a good morning, an exam today…); it
   * reaches the model as a system note. Nothing is stored until `commit` is
   * called with the bubbles that were actually sent, so a message that never
   * reached WeChat isn't remembered as said. Throws rather than returning the
   * fallback reply: 「你再说一遍？」 makes no sense when nobody spoke.
   */
  async initiate(note: string): Promise<Initiative> {
    const { store, parts, timeZone } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const history = store.recentMessages(this.deps.historyMessages);
    const memoryEnabled = store.memoryEnabled();
    const facts = memoryEnabled ? factsForPrompt(store.activeFacts(), localDate(now, timeZone)) : [];
    const summary = memoryEnabled ? store.getSetting(SUMMARY_SETTING) : null;
    const system = buildSystemPrompt(parts, { now, timeZone, memoryEnabled, facts, crisis: false, recent: recentPhrases(history), summary });
    const text =
      `（系统提示，不是用户说的）用户现在没有发消息，是你主动找用户。${note}\n` +
      "像朋友随手发的微信那样开个头：1 条，最多 2 条，每条很短。不要说“提醒你”“我记得你说过”“根据记录”，不要用“在吗”开头。";
    const reply = await this.generate(buildMessages(system, history, { text }));
    if (reply === FALLBACK_REPLY) throw new Error("模型没给出能用的内容，这次不发");
    if (reply.bubbles.length > CHAT_MAX_BUBBLES) this.emit({ type: "reply_trimmed", dropped: reply.bubbles.slice(CHAT_MAX_BUBBLES) });
    return {
      bubbles: reply.bubbles.slice(0, CHAT_MAX_BUBBLES),
      commit: (sent) => {
        if (!sent.length) return;
        store.addMessage("assistant", sent.join("\n"), { bubbles: sent, createdAt: (this.deps.now?.() ?? new Date()).toISOString() });
      },
    };
  }

  /** The model's view, given at most CRISIS_CHECK_WAIT_MS from the start of the turn; errors count as no. */
  private crisisCheck(text: string, previous?: string): Promise<boolean> {
    const { model } = this.deps;
    const logged: ChatModel = {
      name: model.name,
      vision: model.vision,
      cost: (usage) => model.cost(usage),
      complete: async (msgs, opts) => {
        const completion = await model.complete(msgs, opts);
        this.emit({ type: "model", purpose: "safety", ms: completion.ms, ...completion.usage, cost: model.cost(completion.usage) });
        return completion;
      },
    };
    // Past the budget the answer counts as no, and the request is cancelled so it can't hold up shutdown.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CRISIS_CHECK_WAIT_MS);
    return modelSeesCrisis(logged, text, previous, abort.signal)
      .catch(() => false)
      .finally(() => clearTimeout(timer));
  }

  /** One call, one repair attempt, then salvage or a fixed fallback. */
  private async generate(messages: ChatMessage[]): Promise<Reply> {
    const first = await this.call(messages, "reply");
    const parsed = parseReply(first.text);
    if (parsed.ok) return parsed.reply;

    this.emit({ type: "reply_invalid", problems: parsed.problems, action: "repair" });
    const repair = await this.call(
      [
        ...messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: `（系统提示，不是用户说的）上一条回复格式不对：${parsed.problems.join("；")}。请保持同样的意思重写：只输出 {"bubbles": [...]}，1–4 条，每条不超过 120 字。`,
        },
      ],
      "repair",
    );
    const repaired = parseReply(repair.text);
    if (repaired.ok) return repaired.reply;

    const salvage = repaired.salvage ?? parsed.salvage;
    this.emit({ type: "reply_invalid", problems: repaired.problems, action: salvage ? "salvage" : "fallback" });
    return salvage ?? FALLBACK_REPLY;
  }
}
