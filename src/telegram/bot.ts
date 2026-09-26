// A small Telegram Bot API client: send a message, optionally with buttons,
// read updates by long polling, and answer button taps. Every call is a POST
// of JSON to https://api.telegram.org/bot<token>/<method>.
//
// The token is in every URL and anyone holding it controls the bot, so it
// never appears in an error message or a log line.

const API = "https://api.telegram.org";
/** Telegram rejects longer messages. */
export const MAX_TEXT = 4096;
/** How long one getUpdates call waits for something to happen. */
export const POLL_SECONDS = 30;
const TIMEOUT_MS = 15_000;

export class TelegramError extends Error {
  constructor(
    message: string,
    /** Telegram's error code, when it answered. */
    readonly code: number | null = null,
    /** Seconds to wait, when Telegram asked for it (HTTP 429). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

export type Button = { text: string; data: string };

export type TelegramMessage = { message_id: number; chat: { id: number; type?: string; first_name?: string; username?: string }; from?: { id: number }; text?: string };
export type CallbackQuery = { id: string; from: { id: number }; message?: TelegramMessage; data?: string };
export type Update = { update_id: number; message?: TelegramMessage; callback_query?: CallbackQuery };

type ApiResponse = { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };

/** Cuts text to Telegram's limit, marking the cut. */
export function fitText(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 2)} …`;
}

export class TelegramBot {
  constructor(
    private readonly token: string,
    private readonly o: { fetch?: typeof fetch } = {},
  ) {}

  /** Sends plain text (no Markdown, so nothing needs escaping), with a row of buttons when given. Returns the message id. */
  async send(chatId: number, text: string, buttons: Button[] = []): Promise<number> {
    const message = (await this.call("sendMessage", {
      chat_id: chatId,
      text: fitText(text),
      link_preview_options: { is_disabled: true },
      ...(buttons.length ? { reply_markup: keyboard(buttons) } : {}),
    })) as TelegramMessage;
    return message.message_id;
  }

  /** Waits up to `timeoutSeconds` for updates after `offset`. */
  async updates(offset: number, timeoutSeconds = POLL_SECONDS, signal?: AbortSignal): Promise<Update[]> {
    return (await this.call("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }, (timeoutSeconds * 1000) + TIMEOUT_MS, signal)) as Update[];
  }

  /** Stops the spinner on a tapped button; `text` shows briefly at the top of the chat. */
  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  /** Replaces a message's text and removes its buttons, e.g. to show a decision. */
  async replaceText(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: fitText(text), link_preview_options: { is_disabled: true } });
  }

  /** Removes a message's buttons and keeps its text. */
  async removeButtons(chatId: number, messageId: number): Promise<void> {
    await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId });
  }

  private async call(method: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      res = await (this.o.fetch ?? fetch)(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // Network errors can quote the URL, which holds the token; only the reason is kept.
      throw new TelegramError(`Telegram ${method} ${(err as Error).name === "TimeoutError" ? "timed out" : "could not connect"}`);
    }
    const data = (await res.json().catch(() => null)) as ApiResponse | null;
    if (data?.ok) return data.result;
    const code = data?.error_code ?? res.status;
    const why =
      code === 401 || code === 404
        ? "the bot token was rejected (check TELEGRAM_BOT_TOKEN)"
        : code === 409
          ? "another program is reading this bot's updates (only one `watch` can run per bot)"
          : (data?.description ?? `HTTP ${res.status}`).replaceAll(this.token, "<token>");
    throw new TelegramError(`Telegram ${method}: ${why}`, code, data?.parameters?.retry_after ?? null);
  }
}

function keyboard(buttons: Button[]) {
  for (const b of buttons) if (new TextEncoder().encode(b.data).length > 64) throw new Error(`Button data over 64 bytes: ${b.data}`);
  return { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] };
}
