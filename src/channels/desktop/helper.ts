// Runs the Swift Accessibility helper (native/wechat-desktop) and talks to it
// over JSON lines. Builds it with swiftc when missing or out of date.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT } from "../../config.ts";

const SOURCE = join(ROOT, "native/wechat-desktop/main.swift");
const BINARY = join(ROOT, ".build/wechat-desktop");
const REQUEST_TIMEOUT_MS = 15_000;

export type Snapshot = { chat: string; rows: string[]; draft: boolean };

/** What the channel needs from WeChat; the tests use a fake. */
export type WechatUi = {
  snapshot(): Promise<Snapshot>;
  send(chat: string, text: string): Promise<void>;
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
  wrong_chat: "微信当前打开的不是绑定的聊天，没有发送",
  composer_not_empty: "输入框里有别的草稿，没有发送",
  fill_failed: "没能把文字填进输入框",
  changed_before_send: "发送前聊天或输入框变了，已取消",
  not_sent: "按了回车但消息没发出去，已清空输入框",
  unconfirmed: "按了回车但没看到消息出现，不确定是否发出（不会重发）",
  not_focused: "输入框没拿到焦点，没有发送",
  other_window_open: "微信开着另一个聊天窗口，回车可能发到那边，没有发送（关掉独立的聊天窗口）",
  read_failed: "读取聊天记录失败",
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
  private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(private readonly binary = ensureHelperBuilt()) {}

  /** Starts the helper, or starts it again after it died. */
  private process(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const fail = (code: string) => {
      if (this.child === child) this.child = null;
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

  private request<T>(body: object): Promise<T> {
    if (this.closed) return Promise.reject(new HelperError("helper_exited"));
    const child = this.process();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new HelperError("helper_timeout"));
        child.kill(); // a stuck helper is replaced on the next request
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
    });
  }

  async snapshot(): Promise<Snapshot> {
    const { chat, rows, draft } = await this.request<Snapshot>({ cmd: "snapshot" });
    return { chat, rows, draft };
  }

  async send(chat: string, text: string): Promise<void> {
    await this.request({ cmd: "send", chat, text });
  }

  close(): void {
    this.closed = true;
    this.child?.stdin.end();
  }
}
