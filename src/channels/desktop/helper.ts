// Runs the Swift Accessibility helper (native/wechat-desktop) and talks to it
// over JSON lines. Builds it with swiftc when missing or out of date.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT } from "../../config.ts";

const SOURCE = join(ROOT, "native/wechat-desktop/main.swift");
const BINARY = join(ROOT, ".build/wechat-desktop");
const REQUEST_TIMEOUT_MS = 30_000;
/** After the first startup read, restart a helper that stalls instead of blocking message detection for 30 s. */
const SNAPSHOT_TIMEOUT_MS = 12_000;

/** `offset`: WeChat 4.x, where `rows` (the newest ones) start in the whole list; null on 3.8.4. */
export type Snapshot = { chat: string; rows: string[]; draft: boolean; offset?: number | null };

/** What the channel needs from WeChat; the tests use a fake. */
export type WechatUi = {
  snapshot(expectedChat?: string | string[], groupChat?: boolean): Promise<Snapshot>;
  send(chat: string, text: string): Promise<void>;
  /** WeChat 4.x: the newest photo in the open chat, cut out of WeChat's window. */
  capturePhoto?(): Promise<Uint8Array>;
  close(): void;
};

/** Helper error codes, e.g. "wrong_chat", "composer_not_empty", "unconfirmed". */
export class HelperError extends Error {
  constructor(readonly code: string) {
    super(HELPER_MESSAGES[code] ?? code);
  }
}

const HELPER_MESSAGES: Record<string, string> = {
  no_accessibility_permission: "终端没有“辅助功能”权限（系统设置 → 隐私与安全性 → 辅助功能）",
  wechat_not_running: "微信没有运行",
  no_wechat_window: "找不到微信主窗口（窗口被关掉了？在程序坞点一下微信）",
  no_open_chat: "微信里没有打开的聊天",
  wrong_chat: "微信当前标题和刚连接的聊天不一致，没有发送；切回刚连接的聊天后重试",
  wechat_not_frontmost: "没能把目标微信聊天切到前台，未发送",
  composer_not_empty: "输入框原有文字可能已被自动回复替换",
  fill_failed: "没能把文字填进输入框",
  changed_before_send: "发送前聊天或输入框变了，已取消",
  not_sent: "按了回车但消息没发出去，没有发送（输入框里小拜的文字已尽量撤回）",
  unconfirmed: "按了回车，但输入框里的内容被改动了，不确定是否发出（不会重发）",
  not_focused: "输入框没拿到焦点，没有发送",
  other_window_open: "微信开着另一个聊天窗口，回车可能发到那边，没有发送（关掉独立的聊天窗口）",
  window_unknown: "看不出微信当前是哪个窗口在前，没有发送（把微信切到当前桌面看一眼）",
  read_failed: "读取聊天记录失败",
  no_screen_permission: "微信 4.1.13 的文字读取需要“屏幕与系统录音”权限。请在系统设置 → 隐私与安全性 → 屏幕与系统录音中允许 Terminal，再退出并重新打开 Terminal",
  wechat_window_not_visible: "屏幕上没找到微信主窗口。把微信窗口打开并保持可见后重试",
  wechat_window_spans_displays: "微信窗口跨在多个屏幕上，暂时无法读取。把微信窗口完整移到一个屏幕后重试",
  chat_title_not_readable: "暂时读不清微信聊天标题。请确认微信主窗口显示你要连接的聊天，再重试",
  photo_not_visible: "图片不在屏幕上（聊天被往上翻了？）",
  capture_failed: "读取微信窗口画面失败。请确认微信主窗口显示在当前桌面，并检查“屏幕与系统录音”权限",
  capture_unsupported: "当前微信窗口无法按原方式识别图片；文字聊天仍可使用",
  helper_exited: "微信助手进程退出了，下次会重启",
  helper_failed: "微信助手进程启动失败",
  helper_timeout: "微信助手没有响应",
};

export function ensureHelperBuilt(): string {
  if (!existsSync(BINARY) || statSync(BINARY).mtimeMs < statSync(SOURCE).mtimeMs) {
    mkdirSync(join(ROOT, ".build"), { recursive: true });
    execFileSync("swiftc", ["-O", SOURCE, "-o", BINARY], { stdio: ["ignore", "ignore", "inherit"] });
  }
  return BINARY;
}

export class DesktopHelper implements WechatUi {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private snapshotRequests = 0;
  private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** The Swift helper reads and handles one command at a time. Start each timeout only when its command is dispatched. */
  private requestTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly binary = ensureHelperBuilt()) {}

  /** Starts the helper, or starts it again after it died. */
  private process(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const fail = (code: string) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.waiting.values()) p.reject(new HelperError(code));
      this.waiting.clear();
    };
    child.on("error", () => fail("helper_failed"));
    child.on("exit", () => fail("helper_exited"));
    child.stdin.on("error", () => fail("helper_exited"));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg: { id?: number; ok: boolean; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const pending = msg.id === undefined ? undefined : this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id!);
      msg.ok ? pending.resolve(msg) : pending.reject(new HelperError(msg.error ?? "unknown"));
    });
    this.child = child;
    return child;
  }

  private request<T>(body: object, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new HelperError("helper_exited"));
    const request = this.requestTail.then(() => this.dispatchRequest<T>(body, timeoutMs));
    this.requestTail = request.then(() => undefined, () => undefined);
    return request;
  }

  private dispatchRequest<T>(body: object, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new HelperError("helper_exited"));
    const child = this.process();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.waiting.get(id);
        if (!pending) return;
        this.waiting.delete(id);
        pending.reject(new HelperError("helper_timeout"));
        if (this.child === child) {
          this.child = null;
          child.kill(); // a stuck helper is replaced on the next request
        }
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
    });
  }

  async snapshot(expectedChat?: string | string[], groupChat = false): Promise<Snapshot> {
    const timeout = this.snapshotRequests++ === 0 ? REQUEST_TIMEOUT_MS : SNAPSHOT_TIMEOUT_MS;
    const { chat, rows, draft, offset } = await this.request<Snapshot>({ cmd: "snapshot", chat: expectedChat, groupChat }, timeout);
    return { chat, rows, draft, offset: offset ?? null };
  }

  async send(chat: string, text: string): Promise<void> {
    await this.request({ cmd: "send", chat, text });
  }

  async capturePhoto(): Promise<Uint8Array> {
    const { jpeg } = await this.request<{ jpeg: string }>({ cmd: "capture_photo" });
    return new Uint8Array(Buffer.from(jpeg, "base64"));
  }

  close(): void {
    this.closed = true;
    this.child?.stdin.end();
  }
}
