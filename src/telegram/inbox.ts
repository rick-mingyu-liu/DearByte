// What DearByte does with Telegram updates. Only the user's own chat counts:
// anything from another chat is ignored without a reply, so a stranger who
// finds the bot learns nothing and can't press anyone's buttons.
//
// Buttons carry short codes: "fb:<alert>:u|n" rates an alert useful or noise,
// "ap:<approval>:y|n" approves or rejects.

import { approvalText, decide, type ApprovalHandlers, type ApprovalStore } from "../agent/approvals.ts";
import type { Approval, Store } from "../storage/store.ts";
import { TelegramError, type Button, type TelegramBot, type Update } from "./bot.ts";

export type InboxDeps = {
  bot: Pick<TelegramBot, "send" | "answerCallback" | "replaceText" | "removeButtons">;
  chatId: number;
  store: ApprovalStore & Pick<Store, "setAlertFeedback">;
  handlers: ApprovalHandlers;
  now?: () => Date;
};

export const feedbackButtons = (alertId: number): Button[] => [
  { text: "👍 Useful", data: `fb:${alertId}:u` },
  { text: "👎 Not useful", data: `fb:${alertId}:n` },
];

export const approvalButtons = (approvalId: number): Button[] => [
  { text: "✅ Approve", data: `ap:${approvalId}:y` },
  { text: "❌ Reject", data: `ap:${approvalId}:n` },
];

/** Sends an approval request to the user's chat. */
export async function sendApproval(bot: Pick<TelegramBot, "send">, chatId: number, a: Approval): Promise<number> {
  return bot.send(chatId, approvalText(a), approvalButtons(a.id));
}

/** Telegram's popup takes up to 200 characters; cut on code points so an emoji isn't split. */
const popup = (text: string) => Array.from(text).slice(0, 200).join("");

const HINT = "I'm DearByte. For now I only send alerts and ask for approvals here. To talk with me, run: npm run agent -- chat";

/** Handles one update. Returns a line for the log, or null when there's nothing to say. */
export async function handleUpdate(d: InboxDeps, u: Update): Promise<string | null> {
  const now = (d.now ?? (() => new Date()))();
  if (u.message) {
    if (u.message.chat.id !== d.chatId) return "ignored a message from another chat";
    await d.bot.send(d.chatId, HINT);
    return "replied to a message with the chat hint";
  }
  const q = u.callback_query;
  if (!q) return null;
  // In a private chat the chat id is the user's id; both must match.
  if (q.from.id !== d.chatId || (q.message && q.message.chat.id !== d.chatId)) return "ignored a button from another chat";

  // Answering a tap is only cosmetic (it stops the button's spinner), so it never blocks or fails the real work.
  const answer = (text: string) => d.bot.answerCallback(q.id, popup(text)).catch(() => {});
  const [type, rawId, choice] = (q.data ?? "").split(":");
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    await answer("That button is no longer valid.");
    return "ignored a malformed button";
  }

  if (type === "fb" && (choice === "u" || choice === "n")) {
    const feedback = choice === "u" ? "useful" : "noise";
    const saved = d.store.setAlertFeedback(id, feedback);
    await answer(saved ? (feedback === "useful" ? "Thanks, noted." : "Got it, I'll learn from that.") : "I can't find that alert.");
    if (saved && q.message) await d.bot.removeButtons(d.chatId, q.message.message_id).catch(() => {}); // already gone after a double tap
    return saved ? `alert ${id} marked ${feedback}` : `feedback for unknown alert ${id}`;
  }

  if (type === "ap" && (choice === "y" || choice === "n")) {
    // Acknowledge first: Telegram expires a tap's answer after a short while, and an approved action can take longer.
    await answer(choice === "y" ? "Working on it…" : "Rejecting…");
    const decision = await decide(d.store, d.handlers, id, choice === "y" ? "approve" : "reject", { now, via: "telegram" });
    const original = decision.approval ? approvalText(decision.approval) : (q.message?.text ?? "");
    const outcome =
      decision.status === "approved"
        ? `✅ Approved. ${decision.result}`
        : decision.status === "rejected"
          ? choice === "y"
            ? "❌ Not done: DearByte has no way to carry this out."
            : "❌ Rejected. Nothing was done."
          : decision.status === "expired"
            ? "⌛ Expired. Nothing was done."
            : decision.status === "already_decided"
              ? `Already ${decision.approval?.status}.`
              : "I can't find that request.";
    // The decision is already stored; the edit shows it. If the edit fails, the outcome still reaches the user as a message.
    if (q.message && decision.status !== "unknown" && decision.status !== "already_decided") {
      await d.bot.replaceText(d.chatId, q.message.message_id, `${original}\n\n${outcome}`).catch(() => d.bot.send(d.chatId, outcome).catch(() => {}));
    } else {
      await d.bot.send(d.chatId, outcome).catch(() => {});
    }
    return `approval ${id}: ${decision.status}`;
  }

  await answer("That button is no longer valid.");
  return "ignored an unknown button";
}

/**
 * Reads updates until `signal` aborts, handling each in order. A failed call
 * waits (as long as Telegram asks, or 5 seconds) and tries again; a failed
 * handler is logged and skipped, so one bad update can't block the rest.
 * A rejected token stops the loop (retrying can't fix it). On the way out,
 * the last updates are confirmed, so the next start doesn't handle them again.
 */
export async function pollInbox(d: InboxDeps & { bot: Pick<TelegramBot, "updates"> }, o: { signal: AbortSignal; log: (line: string) => void }): Promise<void> {
  let offset = 0;
  while (!o.signal.aborted) {
    let updates: Update[];
    try {
      updates = await d.bot.updates(offset, undefined, o.signal);
    } catch (err) {
      if (o.signal.aborted) break;
      if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        o.log(`${err.message}; stopped listening to Telegram`);
        break;
      }
      const wait = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : err instanceof TelegramError && err.code === 409 ? 30_000 : 5_000;
      o.log(`${(err as Error).message}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, o.signal);
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      try {
        const line = await handleUpdate(d, u);
        if (line) o.log(line);
      } catch (err) {
        o.log(`telegram update ${u.update_id} failed: ${(err as Error).message}`);
      }
    }
  }
  if (offset) await d.bot.updates(offset, 0).catch(() => {});
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
