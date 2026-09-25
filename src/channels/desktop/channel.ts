// The real 小拜 account: WeChat for Mac, logged in as 小拜, with one bound chat.
// Polls the chat through the Accessibility helper, turns new rows from the
// user into messages for the reply loop, and types the replies back.

import type { Companion } from "../../companion/companion.ts";
import type { Initiative } from "../../companion/companion.ts";
import { mergeIncoming, ReplyLoop, type Incoming, type InitiateResult, type ReplyEvent, type SendResult } from "../reply-loop.ts";
import { HelperError, type WechatUi } from "./helper.ts";
import { contactNamesMatch } from "../../contacts.ts";
import type { PhotoFolder } from "./photos.ts";
import { bubbleKey, bubbleLabel, describeOther, newRows, parseRow, rememberRows, rowsAfterLatestAnchor } from "./rows.ts";

const POLL_MS = 500;
const ERROR_BACKOFF_MS = 5_000;
/** This many empty reads in a row (about 30 s) count as a problem, not a blip. */
const EMPTY_READS_PROBLEM = 60;
/** Allow a brief chat-switch transition before abandoning a reply. */
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 3_000;
/** WeChat 4.x: how long a sent bubble waits to be recognised as 小拜's own row. */
const OUTGOING_TTL_MS = 5 * 60_000;
/** WeChat 4.x: a blank row filling in counts as new only this close to the newest row; higher up, it's the user scrolling. */
const LOADING_ROWS = 3;
/** WeChat 4.x: a new photo shows a blurred preview first; give it this long to sharpen. */
const PHOTO_SETTLE_MS = 1_500;
/** A 4.x bubble matching anything 小拜 said this recently is taken as hers, never answered. */
const ECHO_MS = 10 * 60_000;
/** For a direct chat, more turns than this within RUNAWAY_MS may mean something is looping. */
const RUNAWAY_TURNS = 6;
const RUNAWAY_MS = 60_000;
/** Send errors after which the bubble may still have reached WeChat. */
const MAYBE_SENT = new Set(["unconfirmed", "helper_timeout", "helper_exited"]);
const nameOnlyIntroduction = (text: string) => /^(?:我叫|我是|我的名字是|我名字叫|叫我|以后叫我)\s*(?:[\p{Script=Han}]{1,6}|[A-Za-z][A-Za-z'’-]{0,19})[。.!！]?$/u.test(text.trim());
const COMMON_SHORT_MESSAGES = new Set(["嗯", "嗯嗯", "哦", "哦哦", "啊", "好", "好的", "行", "可以", "收到", "谢谢", "哈哈", "哈哈哈", "对", "对啊", "是", "是的", "没事", "不用", "不知道", "在", "来了", "明天", "今晚", "下次", "吃饭", "算了"]);
const bareName = (text: string) => {
  const value = text.trim().normalize("NFKC");
  const looksLikeName = /^[\p{Script=Han}]{2,8}$/u.test(value) || /^[A-Za-z][A-Za-z'’-]{1,19}$/u.test(value);
  return looksLikeName && !COMMON_SHORT_MESSAGES.has(value.toLocaleLowerCase());
};
const suppressGroupNameOnly = (text: string, sender?: string) =>
  nameOnlyIntroduction(text) || (sender === undefined && bareName(text));
/** `count` photos arrived in this burst; 小拜 sees the newest. `fromWindow`: WeChat 4.x, cut out of WeChat's window. */
export type PhotoRef = { seenAt: number; count: number; fromWindow?: boolean };
export type DesktopMessage = Incoming<PhotoRef>;
export type Mode = "auto" | "draft";

export type DesktopEvent =
  | ReplyEvent
  | { type: "status"; message: string }
  | { type: "skipped"; count: number }
  | { type: "send_failed"; message: string };

export class DesktopChannel {
  private readonly loop: ReplyLoop<DesktopMessage>;
  /** Rows from the last time the bound chat was open. */
  private seen: string[] | null = null;
  /** WeChat 4.x: where `seen` started in the whole list. */
  private seenOffset: number | null = null;
  private announced = false;
  /** A confirmed empty startup chat can safely treat the first multi-row burst as new. */
  private initialEmptySnapshot = false;
  private lastStatus = "";
  /** The bound chat's name as WeChat showed it last; sending checks against it. */
  private openName: string | null = null;
  /** The verified configured chat visible when this run connected. */
  private activeChat: string | null = null;
  /** Nicknames seen sending in the bound chat; more than one means a group. */
  private readonly senders = new Set<string>();
  private readonly reportedUnknown = new Set<string>();
  /** Why 小拜 can't read the chat right now, or null when it's in sync. */
  problem: string | null = null;
  /** Snapshots in a row with no rows although the chat had some. */
  private emptyReads = 0;
  /** WeChat 4.x: bubbles 小拜 sent that haven't shown up as rows yet. */
  private outgoing: Array<{ key: string; at: number }> = [];
  /** Keep recent sent bubbles after matching to avoid replaying a row from a refreshed snapshot. */
  private sentLately: Array<{ key: string; at: number }> = [];
  /** When recent turns started, for the runaway check. */
  private turnTimes: number[] = [];
  paused = false;
  /** Set on shutdown: finish the turn in memory, but type nothing more into WeChat. */
  stopping = false;

  constructor(
    private readonly deps: {
      ui: WechatUi;
      companion: Companion;
      /** Names the chat 小拜 answers may show in WeChat (a remark, a nickname, old names). */
      names: string[];
      /** Groups are supported only when the configured chat is explicitly marked as a group. */
      groupChat?: boolean;
      /** Snapshot used to verify the chat at startup; seed the poller from it to catch messages arriving during startup. */
      initialSnapshot?: { chat: string; rows: string[]; offset?: number | null };
      photos: PhotoFolder | null;
      mode: Mode;
      onEvent?: (event: DesktopEvent) => void;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      burstWindowMs?: number;
    },
  ) {
    if (deps.initialSnapshot) {
      this.openName = deps.initialSnapshot.chat;
      this.activeChat = deps.initialSnapshot.chat;
      this.seen = [...deps.initialSnapshot.rows];
      this.seenOffset = deps.initialSnapshot.offset ?? null;
      this.initialEmptySnapshot = deps.initialSnapshot.rows.length === 0;
    }
    this.loop = new ReplyLoop<DesktopMessage>({
      companion: deps.companion,
      onEvent: deps.onEvent,
      sleep: deps.sleep,
      burstWindowMs: deps.burstWindowMs ?? (deps.groupChat ? 0 : undefined),
      parallelIncoming: Boolean(deps.groupChat),
      maxConcurrentIncoming: deps.groupChat ? 4 : undefined,
      readDelayMs: deps.groupChat ? 0 : undefined,
      bubbleDelays: !deps.groupChat,
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
    this.turnTimes = [];
  }

  /** Why 小拜 isn't answering right now, or null. For alerts: a pause counts, as it's easy to forget. */
  get health(): string | null {
    return this.problem ?? (this.paused && this.deps.mode !== "draft" ? "小拜暂停了，新消息不会回复（/resume 恢复）" : null);
  }

  get mode(): Mode {
    return this.deps.mode;
  }

  private emit(event: DesktopEvent) {
    this.deps.onEvent?.(event);
  }

  /** Records why 小拜 can't read the chat; clearing a real problem is reported once. */
  private setProblem(problem: string | null) {
    if (problem === null && this.problem !== null && this.seen !== null) {
      this.lastStatus = "";
      this.emit({ type: "status", message: `已恢复，又能读到「${this.openName}」了，新消息会正常${this.deps.mode === "draft" ? "生成草稿" : "回复"}` });
    }
    this.problem = problem;
    if (problem) this.status(problem);
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
   * paused, and no reply is in progress. Pausing, a chat problem or shutdown
   * while the message is being written stops it.
   */
  async initiate(reason: string, generate: () => Promise<Initiative>): Promise<InitiateResult> {
    const blocked = () => this.problem !== null || this.paused || this.stopping;
    if (!this.announced || this.seen === null || this.lastStatus || blocked()) return "busy";
    return this.loop.initiate(reason, generate, blocked);
  }

  /** Polls until `signal` aborts. The verified startup snapshot is the no-reply history baseline. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait = POLL_MS;
      try {
        this.poll(await this.deps.ui.snapshot(this.deps.names, this.deps.groupChat));
      } catch (err) {
        this.setProblem(`读取微信失败：${(err as Error).message}`);
        wait = ERROR_BACKOFF_MS;
      }
      if (!signal.aborted) await this.sleep(wait);
    }
  }

  /** Handles one snapshot. Public for tests. */
  poll(snapshot: { chat: string; rows: string[]; offset?: number | null }): void {
    const chat = snapshot.chat;
    if (!chat.trim()) {
      this.setProblem("读不到微信聊天标题，请把要连接的聊天留在主窗口");
      return;
    }
    const groupChat = Boolean(this.deps.groupChat);
    if (!this.deps.names.some((name) => contactNamesMatch(name, chat, groupChat))) {
      this.setProblem(`微信当前显示「${chat}」，不在允许连接的聊天名单中；没有读取或回复它的消息`);
      return;
    }
    if (this.activeChat && !contactNamesMatch(this.activeChat, chat, groupChat)) {
      this.setProblem(`微信当前显示「${chat}」，这次连接的是「${this.activeChat}」；切回原聊天后继续`);
      return;
    }
    this.activeChat ??= chat;
    this.openName = chat;
    if (!this.announced) {
      this.announced = true;
      if (this.seen === null) {
        this.problem = null;
        this.seen = snapshot.rows;
        this.seenOffset = snapshot.offset ?? null;
        this.status(`已连接「${chat}」，从现在起的新消息会${this.deps.mode === "draft" ? "生成草稿（不发送）" : "自动回复"}`);
        return;
      }
      this.status(`已连接「${chat}」，从现在起的新消息会${this.deps.mode === "draft" ? "生成草稿（不发送）" : "自动回复"}`);
    }
    if (this.seen === null) {
      this.seen = snapshot.rows;
      this.seenOffset = snapshot.offset ?? null;
      return;
    }
    const previous = this.seen;
    // A full chat never really empties between two polls; that's a bad read.
    if (!snapshot.rows.length && previous.length) {
      if (++this.emptyReads >= EMPTY_READS_PROBLEM) this.setProblem("微信的聊天记录一直读成空的（窗口可能被挡住或最小化了）");
      return;
    }
    this.emptyReads = 0;
    this.setProblem(null);

    const offset = snapshot.offset ?? null;
    const known = offset !== null && this.seenOffset !== null ? offset - this.seenOffset : undefined;
    const knownEmptyStartup = this.initialEmptySnapshot && previous.length === 0;
    let added = knownEmptyStartup && snapshot.rows.length > 3
      ? snapshot.rows
      : newRows(previous, snapshot.rows, (old, fromEnd) => old === "" ? fromEnd < LOADING_ROWS : parseRow(old).kind === "meta", known);
    let rebaselined = false;
    if (added === null) {
      added = rowsAfterLatestAnchor(previous, snapshot.rows);
      // If no old row is recognizable, reset the baseline instead of holding
      // the queue. The next message can be handled immediately from this read.
      rebaselined = true;
      if (added === null) {
        this.seen = snapshot.rows;
        if (snapshot.rows.length) this.initialEmptySnapshot = false;
        this.status("聊天记录刚变化，已重新开始监听新消息");
        return;
      }
    }
    this.status("");
    this.seen = rebaselined ? snapshot.rows : rememberRows(previous, snapshot.rows, known);
    this.seenOffset = offset;
    if (snapshot.rows.length) this.initialEmptySnapshot = false;

    const now = this.deps.now?.() ?? Date.now();
    this.outgoing = this.outgoing.filter((o) => now - o.at < OUTGOING_TTL_MS);
    this.sentLately = this.sentLately.filter((o) => now - o.at < ECHO_MS);
    const messages: DesktopMessage[] = [];
    for (const title of added) {
      const row = parseRow(title);
      if (row.kind === "mineBubble") {
        const mine = this.outgoing.findIndex((o) => o.key === bubbleKey(row.text));
        if (mine >= 0) this.outgoing.splice(mine, 1);
        continue;
      }
      if (row.kind === "bubble") {
        const mine = this.outgoing.findIndex((o) => o.key === bubbleKey(row.text));
        if (mine >= 0) this.outgoing.splice(mine, 1);
        else if (this.sentLately.some((o) => o.key === bubbleKey(row.text))) continue;
        else {
          const speaker = this.deps.groupChat ? (row.sender ?? "发言人未知") : undefined;
          const speakerLabel = this.deps.groupChat ? `${speaker ?? "发言人未知"}：` : "";
          const label = bubbleLabel(row.text);
          if (label && /^(image|photo|picture|图片|照片)$/i.test(label) && this.deps.ui.capturePhoto) {
            messages.push({ text: this.deps.groupChat ? `${speakerLabel}发了一张图` : "", image: { seenAt: now, count: 1, fromWindow: true }, speaker });
          } else messages.push({
            text: `${speakerLabel}${label ? describeOther(label) : row.text}`,
            image: null,
            speaker,
            suppressReply: Boolean(this.deps.groupChat && suppressGroupNameOnly(row.text, row.sender)),
          });
        }
        continue;
      }
      const senderLabel = (sender: string) => this.deps.groupChat ? `${sender}：` : "";
      if (!this.deps.groupChat && (row.kind === "text" || row.kind === "photo" || row.kind === "other")) this.senders.add(row.sender);
      if (row.kind === "text") messages.push({
        text: `${senderLabel(row.sender)}${row.text}`,
        image: null,
        speaker: this.deps.groupChat ? row.sender : undefined,
        suppressReply: Boolean(this.deps.groupChat && suppressGroupNameOnly(row.text, row.sender)),
      });
      else if (row.kind === "photo") messages.push({ text: this.deps.groupChat ? `${senderLabel(row.sender)}发了一张图` : "", image: { seenAt: now, count: 1 }, speaker: this.deps.groupChat ? row.sender : undefined });
      else if (row.kind === "other") messages.push({ text: `${senderLabel(row.sender)}${describeOther(row.label)}`, image: null, speaker: this.deps.groupChat ? row.sender : undefined });
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
    if (!this.deps.groupChat && this.senders.size > 1 && !this.paused) {
      this.paused = true;
      this.emit({ type: "status", message: `这个聊天里有不止一个人在说话（${[...this.senders].join("、")}），像是群聊。只有在 data/contacts.json 标记为群聊后才会自动回复；目前已暂停` });
    }
    if (this.paused) {
      this.emit({ type: "skipped", count: messages.length });
      // Claim the skipped photos so they aren't mistaken for the next one.
      const photos = messages.filter((m) => m.image && !m.image.fromWindow).length;
      if (photos) this.deps.photos?.claim(now, photos).catch(() => {});
      return;
    }
    if (!this.deps.groupChat) {
      this.turnTimes = [...this.turnTimes.filter((t) => now - t < RUNAWAY_MS), now];
      if (this.turnTimes.length > RUNAWAY_TURNS) {
        this.paused = true;
        this.emit({ type: "status", message: `一分钟里回了 ${RUNAWAY_TURNS} 次以上，像是在自己跟自己聊。已暂停（看一眼微信，没问题再 /resume）` });
        this.emit({ type: "skipped", count: messages.length });
        return;
      }
    }
    this.loop.push(messages);
  }

  private async loadPhoto(ref: PhotoRef): Promise<Uint8Array> {
    if (ref.fromWindow && this.deps.ui.capturePhoto) {
      const wait = ref.seenAt + PHOTO_SETTLE_MS - (this.deps.now?.() ?? Date.now());
      if (wait > 0) await this.sleep(wait);
      try {
        return await this.deps.ui.capturePhoto();
      } catch (err) {
        this.emit({ type: "status", message: `取图失败：${(err as Error).message}` });
        throw err;
      }
    }
    if (!this.deps.photos) throw new Error("没有设置 COMPANION_WECHAT_MEDIA_DIR，读不到图片");
    return this.deps.photos.claim(ref.seenAt, ref.count);
  }

  private async send(raw: string): Promise<SendResult> {
    if (this.deps.mode === "draft") return "drafted";
    if (this.stopping) return "failed";
    // WeChat trims bubbles, and the helper confirms by exact text.
    const bubble = raw.trim();
    if (!bubble) return "sent";
    // Expected before it's sent: the row can show up in a poll while the send is still confirming.
    const pending = { key: bubbleKey(bubble), at: this.deps.now?.() ?? Date.now() };
    this.outgoing.push(pending);
    this.sentLately.push(pending);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.ui.send(this.openName ?? this.deps.names[0], bubble);
        return "sent";
      } catch (err) {
        const code = err instanceof HelperError ? err.code : "";
        // Wait for a human draft or a chat switch to clear; never resend after Return.
        if (code === "wrong_chat" && attempt < BUSY_RETRIES) {
          await this.sleep(BUSY_WAIT_MS);
          continue;
        }
        // Keep expecting the row only if the bubble may have gone out.
        if (!MAYBE_SENT.has(code)) {
          this.outgoing = this.outgoing.filter((o) => o !== pending);
        }
        this.emit({ type: "send_failed", message: (err as Error).message });
        return "failed";
      }
    }
  }
}
