// The real 小拜 account: WeChat for Mac, logged in as 小拜, with one bound chat.
// Polls the chat through the Accessibility helper, turns new rows from the
// user into messages for the reply loop, and types the replies back.

import type { Companion } from "../../companion/companion.ts";
import { mergeIncoming, ReplyLoop, type Incoming, type ReplyEvent, type SendResult } from "../reply-loop.ts";
import { HelperError, type WechatUi } from "./helper.ts";
import type { PhotoFolder } from "./photos.ts";
import { describeOther, newRows, parseRow } from "./rows.ts";

const POLL_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;
/** A draft in the composer (someone typing on the Mac) gets this long to clear. */
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 3_000;

export type PhotoRef = { seenAt: number };
export type DesktopMessage = Incoming<PhotoRef>;
export type Mode = "auto" | "draft";

export type DesktopEvent =
  | ReplyEvent
  | { type: "status"; message: string }
  | { type: "skipped"; count: number };

export class DesktopChannel {
  private readonly loop: ReplyLoop<DesktopMessage>;
  /** Rows from the last time the bound chat was open. */
  private seen: string[] | null = null;
  private lastStatus = "";
  paused = false;

  constructor(
    private readonly deps: {
      ui: WechatUi;
      companion: Companion;
      /** The chat 小拜 answers, as WeChat shows its name. */
      chat: string;
      photos: PhotoFolder | null;
      mode: Mode;
      onEvent?: (event: DesktopEvent) => void;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      burstWindowMs?: number;
    },
  ) {
    this.loop = new ReplyLoop<DesktopMessage>({
      companion: deps.companion,
      onEvent: deps.onEvent,
      sleep: deps.sleep,
      burstWindowMs: deps.burstWindowMs,
      outlet: {
        merge: mergeIncoming,
        loadImage: (ref) => this.loadPhoto(ref),
        sendBubble: (_message, bubble) => this.send(bubble),
      },
    });
  }

  get mode(): Mode {
    return this.deps.mode;
  }

  private emit(event: DesktopEvent) {
    this.deps.onEvent?.(event);
  }

  /** Reports a status line once, not on every poll. */
  private status(message: string) {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    if (message) this.emit({ type: "status", message });
  }

  private sleep(ms: number) {
    return (this.deps.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  settle(): Promise<void> {
    return this.loop.settle();
  }

  /** Polls until `signal` aborts. Messages already in the chat at start are never answered. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait = POLL_MS;
      try {
        this.poll(await this.deps.ui.snapshot());
      } catch (err) {
        this.status(`读取微信失败：${(err as Error).message}`);
        wait = ERROR_BACKOFF_MS;
      }
      if (!signal.aborted) await this.sleep(wait);
    }
  }

  /** Handles one snapshot. Public for tests. */
  poll(snapshot: { chat: string; rows: string[] }): void {
    const { chat } = this.deps;
    if (snapshot.chat !== chat) {
      this.status(`微信当前打开的是「${snapshot.chat || "（无）"}」，不是「${chat}」；切回去之前不会回复`);
      return;
    }
    if (this.seen === null) {
      this.seen = snapshot.rows;
      this.status(`已连接「${chat}」，从现在起的新消息会${this.deps.mode === "draft" ? "生成草稿（不发送）" : "自动回复"}`);
      return;
    }
    this.status("");

    const added = newRows(this.seen, snapshot.rows);
    this.seen = snapshot.rows;
    if (added === null) {
      this.emit({ type: "status", message: "聊天记录跳动了（滚动或重新加载），重新对齐；这期间的消息可能漏掉" });
      return;
    }

    const now = this.deps.now?.() ?? Date.now();
    const messages: DesktopMessage[] = [];
    for (const title of added) {
      const row = parseRow(title);
      if (row.kind === "text") messages.push({ text: row.text, image: null });
      else if (row.kind === "photo") messages.push({ text: "", image: { seenAt: now } });
      else if (row.kind === "other") messages.push({ text: describeOther(row.label), image: null });
    }
    if (!messages.length) return;
    if (this.paused) {
      this.emit({ type: "skipped", count: messages.length });
      return;
    }
    this.loop.push(messages);
  }

  private async loadPhoto(ref: PhotoRef): Promise<Uint8Array> {
    if (!this.deps.photos) throw new Error("没有设置 COMPANION_WECHAT_MEDIA_DIR，读不到图片");
    return this.deps.photos.claim(ref.seenAt);
  }

  private async send(bubble: string): Promise<SendResult> {
    if (this.deps.mode === "draft") return "drafted";
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.ui.send(this.deps.chat, bubble);
        return "sent";
      } catch (err) {
        const code = err instanceof HelperError ? err.code : "";
        // Wait for a human draft or a chat switch to clear; never resend after Return.
        if ((code === "composer_not_empty" || code === "wrong_chat") && attempt < BUSY_RETRIES) {
          await this.sleep(BUSY_WAIT_MS);
          continue;
        }
        this.emit({ type: "error", message: `发送失败：${(err as Error).message}` });
        return "failed";
      }
    }
  }
}
