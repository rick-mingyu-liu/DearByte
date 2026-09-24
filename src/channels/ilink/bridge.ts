// Connects WeChat (via iLink) to the companion: long-poll → merge a burst of
// messages into one turn → reply bubble by bubble with a typing indicator.

import type { Companion, TurnResult } from "../../companion/companion.ts";
import { FALLBACK_REPLY } from "../../companion/output.ts";
import type { ImageInput } from "../../domain.ts";
import { imageFromBytes } from "../../media/images.ts";
import type { Store } from "../../storage/store.ts";
import { newClientId, type IlinkClient } from "./client.ts";
import { mergeInbound, readMessage, type ImageRef, type Inbound } from "./inbound.ts";
import { STALE_TOKEN_ERRCODE, TypingStatus } from "./types.ts";

const CURSOR_SETTING = "ilink_cursor";
const MAX_FAILURES = 3;
const RETRY_MS = 2_000;
const BACKOFF_MS = 30_000;
const STALE_TOKEN_PAUSE_MS = 60 * 60_000;
/** How long to wait for follow-up messages before answering a burst. */
const BURST_WINDOW_MS = 1_500;
const SEEN_IDS_KEPT = 500;
const SEND_RETRY_MS = 1_000;
/** Refresh typing tickets daily; retry a failed fetch after a minute. */
const TICKET_TTL_MS = 24 * 60 * 60_000;
const TICKET_RETRY_MS = 60_000;

export type BridgeEvent =
  | { type: "inbound"; text: string; image: boolean; merged: number }
  | { type: "ignored"; reason: "other_user" | "duplicate" }
  | { type: "sent"; bubble: string }
  | { type: "turn"; turn: TurnResult }
  | { type: "error"; message: string }
  | { type: "stale_token" };

/** Typing-bubble pause: longer bubbles take longer to "type". */
export const bubbleDelay = (bubble: string) => Math.min(2_500, 500 + 60 * [...bubble].length);

export class WechatBridge {
  private queue: Inbound[] = [];
  private busy = false;
  private readonly seen = new Set<string>();
  private readonly tickets = new Map<string, { ticket: string; expires: number }>();
  /** In-flight turns and background memory work; each removes itself when done. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      client: IlinkClient;
      companion: Companion;
      store: Store;
      /** The only WeChat user 小拜 answers. */
      ownerId: string;
      downloadImage: (image: ImageRef) => Promise<Uint8Array>;
      onEvent?: (event: BridgeEvent) => void;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
      burstWindowMs?: number;
    },
  ) {}

  private emit(event: BridgeEvent) {
    this.deps.onEvent?.(event);
  }

  private track(work: Promise<unknown>) {
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Waits for in-flight turns and memory work, including work they start meanwhile. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private sleep(ms: number, signal?: AbortSignal) {
    return (this.deps.sleep ?? abortableSleep)(ms, signal);
  }

  /** Polls until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const { client, store } = this.deps;
    let cursor = store.getSetting(CURSOR_SETTING) ?? "";
    let timeoutMs: number | undefined;
    let failures = 0;

    while (!signal.aborted) {
      try {
        const resp = await client.getUpdates(cursor, timeoutMs, signal);
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;

        if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
          this.emit({ type: "stale_token" });
          failures = 0;
          await this.sleep(STALE_TOKEN_PAUSE_MS, signal);
          continue;
        }
        if (resp.ret || resp.errcode) throw new Error(`getupdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`.trim());
        failures = 0;

        // Saved before handling, as the official client does: a crash can
        // drop a message but never answers one twice.
        if (resp.get_updates_buf) {
          cursor = resp.get_updates_buf;
          store.setSetting(CURSOR_SETTING, cursor);
        }
        this.accept(resp.msgs ?? []);
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        this.emit({ type: "error", message: `收消息失败（${failures}/${MAX_FAILURES}）：${(err as Error).message}` });
        await this.sleep(failures >= MAX_FAILURES ? BACKOFF_MS : RETRY_MS, signal).catch(() => {});
        if (failures >= MAX_FAILURES) failures = 0;
      }
    }
  }

  /** Filters raw messages and queues the owner's for the next turn. */
  accept(messages: Parameters<typeof readMessage>[0][]): void {
    for (const raw of messages) {
      const inbound = readMessage(raw);
      if (!inbound) continue;
      if (inbound.from !== this.deps.ownerId) {
        this.emit({ type: "ignored", reason: "other_user" });
        continue;
      }
      if (inbound.messageId) {
        if (this.seen.has(inbound.messageId)) {
          this.emit({ type: "ignored", reason: "duplicate" });
          continue;
        }
        this.seen.add(inbound.messageId);
        if (this.seen.size > SEEN_IDS_KEPT) this.seen.delete(this.seen.values().next().value!);
      }
      this.queue.push(inbound);
    }
    if (this.queue.length && !this.busy) this.track(this.drain());
  }

  /** Answers queued messages one burst at a time. */
  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length) {
        await this.sleep(this.deps.burstWindowMs ?? BURST_WINDOW_MS);
        const batch = this.queue.splice(0);
        await this.answer(mergeInbound(batch), batch.length);
      }
    } finally {
      this.busy = false;
    }
  }

  private async answer(message: Inbound, merged: number): Promise<void> {
    const { client, companion } = this.deps;
    this.emit({ type: "inbound", text: message.text, image: Boolean(message.image), merged });

    const ticket = await this.typingTicket(message);
    const typing = (on: boolean) =>
      ticket
        ? client.sendTyping(message.from, ticket, on ? TypingStatus.TYPING : TypingStatus.CANCEL).catch(() => {})
        : Promise.resolve();
    await typing(true);

    let text = message.text;
    let image: ImageInput | undefined;
    if (message.image) {
      try {
        image = imageFromBytes(await this.deps.downloadImage(message.image));
      } catch (err) {
        this.emit({ type: "error", message: `图片下载失败：${(err as Error).message}` });
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

    for (const [i, bubble] of bubbles.entries()) {
      if (i > 0) {
        await typing(true);
        await this.sleep(bubbleDelay(bubble));
      }
      if (!(await this.send(message, bubble))) {
        this.emit({ type: "error", message: `第 ${i + 1} 条气泡发送失败，后面的不再发（聊天记录里仍保存着完整回复）` });
        break;
      }
    }
    await typing(false);
  }

  /**
   * Sends one bubble, retrying once. The retry reuses the client_id so the
   * server can recognise a duplicate if the first attempt did arrive.
   */
  private async send(message: Inbound, bubble: string): Promise<boolean> {
    const clientId = newClientId();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.deps.client.sendText(message.from, bubble, message.contextToken, clientId);
        this.emit({ type: "sent", bubble });
        return true;
      } catch (err) {
        this.emit({ type: "error", message: `发送失败（第 ${attempt} 次）：${(err as Error).message}` });
        if (attempt === 1) await this.sleep(SEND_RETRY_MS);
      }
    }
    return false;
  }

  private async typingTicket(message: Inbound): Promise<string> {
    const now = Date.now();
    const cached = this.tickets.get(message.from);
    if (cached && cached.expires > now) return cached.ticket;
    const ticket = await this.deps.client.getTypingTicket(message.from, message.contextToken).catch(() => "");
    this.tickets.set(message.from, { ticket, expires: now + (ticket ? TICKET_TTL_MS : TICKET_RETRY_MS) });
    return ticket;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}
