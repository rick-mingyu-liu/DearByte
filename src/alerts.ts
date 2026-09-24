// Tells the operator when 小拜 has gone quiet, so a stuck chat is found before
// filming rather than during it. Alerts go to a macOS notification and, if
// COMPANION_ALERT_URL is set, to a push service such as ntfy.sh (a POST with
// the text as the body), which reaches the phone.

import { execFile } from "node:child_process";

/** A problem must last this long before it's worth an alert; blips pass. */
export const STUCK_MS = 60_000;
/** At most one send-failure alert per this long. */
export const SEND_ALERT_GAP_MS = 10 * 60_000;

export type Notify = (title: string, body: string) => void;

export class Watchdog {
  private since: number | null = null;
  private alerted = false;
  private lastSendAlert = -Infinity;

  constructor(private readonly deps: { notify: Notify; now?: () => number; stuckMs?: number }) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Called regularly with the channel's current problem (null when fine). */
  check(problem: string | null): void {
    const now = this.now();
    if (problem === null) {
      if (this.alerted) this.deps.notify("小拜恢复了", "又能读到聊天了，新消息会正常回复");
      this.since = null;
      this.alerted = false;
      return;
    }
    this.since ??= now;
    if (!this.alerted && now - this.since >= (this.deps.stuckMs ?? STUCK_MS)) {
      this.alerted = true;
      this.deps.notify("小拜停了", problem);
    }
  }

  /** A bubble couldn't be sent. */
  sendFailed(message: string): void {
    const now = this.now();
    if (now - this.lastSendAlert < SEND_ALERT_GAP_MS) return;
    this.lastSendAlert = now;
    this.deps.notify("小拜有消息没发出去", message);
  }
}

/** macOS notification with details, plus a detail-free POST to `url` when given. Failures are reported, never thrown. */
export function systemNotifier(url: string | null, onError: (message: string) => void): Notify {
  return (title, body) => {
    // Arguments go through argv, so quotes in the text can't break the script.
    execFile(
      "osascript",
      ["-e", "on run argv", "-e", 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', "-e", "end run", title, body],
      (err) => err && onError(`系统通知失败：${err.message}`),
    );
    if (url) {
      // The push goes through a third-party service, so it carries no details
      // (the details name chats and people); those stay in the Mac notification.
      fetch(url, { method: "POST", body: `${title}（详情看 Mac 上的通知）`, signal: AbortSignal.timeout(10_000) })
        .then((r) => !r.ok && onError(`推送失败：HTTP ${r.status}`))
        .catch((err: Error) => onError(`推送失败：${err.message}`));
    }
  };
}
