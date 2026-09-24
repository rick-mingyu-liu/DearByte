// The real 小拜 account: WeChat for Mac, logged in as 小拜, with one bound chat.
// Polls the chat through the Accessibility helper, turns new rows from the
// user into messages for the reply loop, and types the replies back.

import type { Companion } from "../../companion/companion.ts";
import { mergeIncoming, ReplyLoop, type Incoming, type ReplyEvent, type SendResult } from "../reply-loop.ts";
import { HelperError, type WechatUi } from "./helper.ts";
import type { PhotoFolder } from "./photos.ts";
import { describeOther, newRows, parseRow, rememberRows } from "./rows.ts";

const POLL_MS = 1_000;
const ERROR_BACKOFF_MS = 5_000;
/** A draft in the composer (someone typing on the Mac) gets this long to clear. */
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 3_000;

/** `count` photos arrived in this burst; 小拜 sees the newest. */
export type PhotoRef = { seenAt: number; count: number };
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
  /** The bound chat's name as WeChat showed it last; sending checks against it. */
  private openName: string | null = null;
  /** Nicknames seen sending in the bound chat; more than one means a group. */
  private readonly senders = new Set<string>();
  private readonly reportedUnknown = new Set<string>();
  paused = false;
  /** Set on shutdown: finish the turn in memory, but type nothing more into WeChat. */
  stopping = false;

  constructor(
    private readonly deps: {
      ui: WechatUi;
      companion: Companion;
      /** Names the chat 小拜 answers may show in WeChat (a remark, a nickname, old names). */
      names: string[];
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
        merge: (messages) => {
          const merged = mergeIncoming(messages);
          const count = messages.filter((m) => m.image).length;
          return merged.image ? { ...merged, image: { ...merged.image, count } } : merged;
        },
        loadImage: (ref) => this.loadPhoto(ref),
        sendBubble: (_message, bubble) => this.send(bubble),
      },
    });
  }

  /** Resumes replies. A group-chat pause is lifted too: the operator has checked the chat. */
  resume(): void {
    this.paused = false;
    this.senders.clear();
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

  /**
   * 小拜 writes first, if the bound chat is open and in sync, replies aren't
   * paused, and no reply is in progress. Resolves true once it was attempted.
   */
  async initiate(reason: string, generate: () => Promise<string[]>): Promise<boolean> {
    if (this.seen === null || this.lastStatus || this.paused || this.stopping) return false;
    return (await this.loop.initiate(reason, generate)) === true;
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
    const { names } = this.deps;
    const chat = snapshot.chat;
    if (!names.includes(chat)) {
      this.status(`微信当前打开的是「${chat || "（无）"}」，不是「${names.join("」「")}」；切回去之前不会回复`);
      return;
    }
    this.openName = chat;
    if (this.seen === null) {
      this.seen = snapshot.rows;
      this.status(`已连接「${chat}」，从现在起的新消息会${this.deps.mode === "draft" ? "生成草稿（不发送）" : "自动回复"}`);
      return;
    }
    // A full chat never really empties between two polls; that's a bad read.
    if (!snapshot.rows.length && this.seen.length) return;
    this.status("");

    const added = newRows(this.seen, snapshot.rows, (old) => parseRow(old).kind === "meta");
    this.seen = rememberRows(this.seen, snapshot.rows);
    if (added === null) {
      this.emit({ type: "status", message: "聊天记录跳动了（滚动或重新加载），重新对齐；这期间的消息可能漏掉" });
      return;
    }

    const now = this.deps.now?.() ?? Date.now();
    const messages: DesktopMessage[] = [];
    for (const title of added) {
      const row = parseRow(title);
      if (row.kind === "text" || row.kind === "photo" || row.kind === "other") this.senders.add(row.sender);
      if (row.kind === "text") messages.push({ text: row.text, image: null });
      else if (row.kind === "photo") messages.push({ text: "", image: { seenAt: now, count: 1 } });
      else if (row.kind === "other") messages.push({ text: describeOther(row.label), image: null });
      else if (row.kind === "unknown" && !this.reportedUnknown.has(title) && this.reportedUnknown.size <= 20) {
        this.reportedUnknown.add(title);
        this.emit({
          type: "status",
          message:
            this.reportedUnknown.size > 20
              ? "看不懂的行太多了，之后不再逐条提示（微信是不是切成了中文界面？）"
              : `有一行看不懂，没有回复：${title.slice(0, 40)}（微信要用英文界面）`,
        });
      }
    }
    if (!messages.length) return;
    if (this.senders.size > 1 && !this.paused) {
      this.paused = true;
      this.emit({ type: "status", message: `这个聊天里有不止一个人在说话（${[...this.senders].join("、")}），像是群聊。已暂停，小拜只回一对一聊天` });
    }
    if (this.paused) {
      this.emit({ type: "skipped", count: messages.length });
      // Claim the skipped photos so they aren't mistaken for the next one.
      const photos = messages.filter((m) => m.image).length;
      if (photos) this.deps.photos?.claim(now, photos).catch(() => {});
      return;
    }
    this.loop.push(messages);
  }

  private async loadPhoto(ref: PhotoRef): Promise<Uint8Array> {
    if (!this.deps.photos) throw new Error("没有设置 COMPANION_WECHAT_MEDIA_DIR，读不到图片");
    return this.deps.photos.claim(ref.seenAt, ref.count);
  }

  private async send(raw: string): Promise<SendResult> {
    if (this.deps.mode === "draft") return "drafted";
    if (this.stopping) return "failed";
    // WeChat trims bubbles, and the helper confirms by exact text.
    const bubble = raw.trim();
    if (!bubble) return "sent";
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.ui.send(this.openName ?? this.deps.names[0], bubble);
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
