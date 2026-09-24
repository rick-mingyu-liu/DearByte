// Channel-independent reply loop: queue incoming messages, merge a burst into
// one turn, load its photo, ask the companion, and send the bubbles with
// pauses in between. The WeChat desktop and ClawBot channels both feed it.

import type { Companion, Initiative, TurnResult } from "../companion/companion.ts";
import { FALLBACK_REPLY } from "../companion/output.ts";
import type { ImageInput } from "../domain.ts";
import { imageFromBytes } from "../media/images.ts";

/** How long to wait for follow-up messages before answering a burst. */
const BURST_WINDOW_MS = 1_500;

export type Incoming<Ref> = { text: string; image: Ref | null };

export type ReplyEvent =
  | { type: "inbound"; text: string; image: boolean; merged: number }
  | { type: "sent"; bubble: string }
  | { type: "drafted"; bubble: string }
  | { type: "turn"; turn: TurnResult }
  | { type: "initiated"; reason: string }
  | { type: "error"; message: string };

export type SendResult = "sent" | "drafted" | "failed";

/**
 * How writing first went. "busy": a reply was in progress, nothing tried.
 * "dropped": the user wrote (or replies paused) while it was being written,
 * so it wasn't sent. "failed": nothing could be written or sent.
 */
export type InitiateResult = "sent" | "failed" | "dropped" | "busy";

export type Outlet<M extends Incoming<unknown>> = {
  /** Several messages that arrived together → one turn. */
  merge(batch: M[]): M;
  loadImage(ref: NonNullable<M["image"]>): Promise<Uint8Array>;
  /** Sends one bubble; the outlet handles its own retries. `message` is null when 小拜 writes first. */
  sendBubble(message: M | null, bubble: string): Promise<SendResult>;
  typing?(message: M, on: boolean): Promise<void>;
};

/**
 * Default merge: texts joined in order, the latest photo attached, and a note
 * when earlier photos in the burst can't be shown.
 */
export function mergeIncoming<M extends Incoming<unknown>>(batch: M[]): M {
  const images = batch.filter((m) => m.image !== null);
  const texts = batch.map((m) => m.text).filter(Boolean);
  if (images.length > 1) texts.push(`（用户还发了另外 ${images.length - 1} 张图，你只看到了最后一张）`);
  return { ...batch[batch.length - 1], text: texts.join("\n"), image: images.at(-1)?.image ?? null };
}

/**
 * Pause before a bubble, as if typing it: about 150 ms per character, capped,
 * with ±25% jitter so the rhythm isn't mechanical. `random` is in [0, 1).
 */
export const bubbleDelay = (bubble: string, random = 0.5) =>
  Math.round(Math.min(4_000, 600 + 150 * [...bubble].length) * (0.75 + random / 2));

/**
 * The shortest time between a message arriving and the first bubble, as if
 * reading it first: 1.5–3.5 s. Model time counts towards it, so slow turns
 * aren't delayed further.
 */
export const readDelay = (random = 0.5) => Math.round(1_500 + 2_000 * random);

export class ReplyLoop<M extends Incoming<unknown>> {
  private queue: M[] = [];
  private busy = false;
  /** In-flight turns and background memory work; each removes itself when done. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      companion: Companion;
      outlet: Outlet<M>;
      onEvent?: (event: ReplyEvent) => void;
      sleep?: (ms: number) => Promise<void>;
      burstWindowMs?: number;
      random?: () => number;
      now?: () => number;
    },
  ) {}

  private random() {
    return (this.deps.random ?? Math.random)();
  }

  private emit(event: ReplyEvent) {
    this.deps.onEvent?.(event);
  }

  private sleep(ms: number) {
    return (this.deps.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  private track(work: Promise<unknown>) {
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Waits for in-flight turns and memory work, including work they start meanwhile. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  push(messages: M[]): void {
    this.queue.push(...messages);
    if (this.queue.length && !this.busy) this.track(this.drain());
  }

  /** Answers queued messages one burst at a time. */
  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length) {
        await this.sleep(this.deps.burstWindowMs ?? BURST_WINDOW_MS);
        const batch = this.queue.splice(0);
        await this.answer(this.deps.outlet.merge(batch), batch.length);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * 小拜 writes first, unless a reply is queued or in progress. If the user
   * writes (or `shouldStop` turns true) before or between bubbles, the rest
   * isn't sent: answering them comes first. Only sent bubbles are committed.
   */
  initiate(reason: string, generate: () => Promise<Initiative>, shouldStop: () => boolean = () => false): Promise<InitiateResult> {
    if (this.busy || this.queue.length) return Promise.resolve("busy");
    this.busy = true;
    const interrupted = () => this.queue.length > 0 || shouldStop();
    const work = (async (): Promise<InitiateResult> => {
      try {
        let draft: Initiative;
        try {
          draft = await generate();
        } catch (err) {
          this.emit({ type: "error", message: `主动消息没发：${(err as Error).message}` });
          return "failed";
        }
        if (interrupted()) return "dropped";
        this.emit({ type: "initiated", reason });
        const sent = await this.sendAll(null, draft.bubbles, undefined, interrupted);
        draft.commit(sent);
        return sent.length ? "sent" : "failed";
      } finally {
        this.busy = false;
        if (this.queue.length) this.track(this.drain());
      }
    })();
    this.track(work);
    return work;
  }

  private async answer(message: M, merged: number): Promise<void> {
    const { companion, outlet } = this.deps;
    const started = (this.deps.now ?? Date.now)();
    this.emit({ type: "inbound", text: message.text, image: message.image !== null, merged });
    const typing = (on: boolean) => outlet.typing?.(message, on).catch(() => {}) ?? Promise.resolve();
    await typing(true);

    let text = message.text;
    let image: ImageInput | undefined;
    if (message.image !== null) {
      try {
        image = imageFromBytes(await outlet.loadImage(message.image as NonNullable<M["image"]>));
      } catch (err) {
        this.emit({ type: "error", message: `图片读取失败：${(err as Error).message}` });
        text = [text, "（用户发了一张图，但图片没加载出来，你看不到）"].filter(Boolean).join("\n");
      }
    }

    let bubbles: string[];
    try {
      const turn = await companion.handle({ text, image });
      this.emit({ type: "turn", turn });
      this.track(turn.memory);
      bubbles = turn.reply.bubbles;
    } catch (err) {
      this.emit({ type: "error", message: `生成回复失败，发送兜底回复：${(err as Error).message}` });
      bubbles = FALLBACK_REPLY.bubbles;
    }

    const wait = readDelay(this.random()) - ((this.deps.now ?? Date.now)() - started);
    if (wait > 0) await this.sleep(wait);
    await this.sendAll(message, bubbles, () => typing(true));
    await typing(false);
  }

  /**
   * Sends bubbles in order with a typing pause before each after the first.
   * Stops at a failure, or before a bubble once `stop` is true. Returns what was sent.
   */
  private async sendAll(message: M | null, bubbles: string[], typing?: () => Promise<void>, stop?: () => boolean): Promise<string[]> {
    const sent: string[] = [];
    for (const [i, bubble] of bubbles.entries()) {
      if (i > 0) {
        await typing?.();
        await this.sleep(bubbleDelay(bubble, this.random()));
        if (stop?.()) break;
      }
      const result = await this.deps.outlet.sendBubble(message, bubble).catch(() => "failed" as const);
      if (result === "failed") {
        this.emit({ type: "error", message: `第 ${i + 1} 条气泡发送失败，后面的不再发（聊天记录里仍保存着完整回复）` });
        break;
      }
      this.emit({ type: result, bubble });
      sent.push(bubble);
    }
    return sent;
  }
}
