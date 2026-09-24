// Minimal iLink HTTP client: QR login, long-poll, send text, typing.
// Protocol details follow Tencent's official client (MIT); see
// docs/design/wechat-transport.md. No OpenClaw code or runtime is used.

import { randomBytes } from "node:crypto";
import { MessageState, MessageType, ItemType, type GetUpdatesResp, type QrStatusResp } from "./types.ts";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// The server expects the official client's app id and a client version it
// knows, so these mirror the protocol version we implement. `bot_agent` is the
// field iLink documents for identifying the actual app, and it says DearByte.
const PROTOCOL_VERSION = "2.4.9";
const APP_ID = "bot";
export const BOT_AGENT = "DearByte/0.1.0";

const LONG_POLL_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const LIGHT_TIMEOUT_MS = 10_000;

export type Fetch = typeof fetch;

/** "2.4.9" → 0x00020409: major<<16 | minor<<8 | patch. */
export function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** X-WECHAT-UIN: a random uint32, as a decimal string, base64-encoded. */
export function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
}

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/**
 * JSON.parse that keeps uint64 message ids exact by quoting them first.
 * Only object keys are rewritten; text inside strings is never touched.
 */
export function parseIlinkJson<T>(raw: string): T {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i++];
      continue;
    }
    const start = i++;
    for (let escaped = false; i < raw.length; ) {
      const c = raw[i++];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') break;
    }
    const token = raw.slice(start, i);
    out += token;

    let j = i;
    while (/\s/.test(raw[j] ?? "")) j++;
    if (raw[j] !== ":" || !LOSSLESS_ID_FIELDS.has(JSON.parse(token))) continue;
    j++;
    while (/\s/.test(raw[j] ?? "")) j++;
    const numStart = j;
    if (raw[j] === "-") j++;
    while (/\d/.test(raw[j] ?? "")) j++;
    if (j > numStart && raw.slice(numStart, j) !== "-") {
      out += `${raw.slice(i, numStart)}"${raw.slice(numStart, j)}"`;
      i = j;
    }
  }
  return JSON.parse(out) as T;
}

export class IlinkError extends Error {}

export const newClientId = () => `dearbyte:${Date.now()}-${randomBytes(4).toString("hex")}`;

export class IlinkClient {
  constructor(
    private readonly opts: { baseUrl?: string; token?: string; fetch?: Fetch } = {},
  ) {}

  private get baseUrl() {
    return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, "/");
  }

  private get fetch(): Fetch {
    return this.opts.fetch ?? fetch;
  }

  private commonHeaders(): Record<string, string> {
    return { "iLink-App-Id": APP_ID, "iLink-App-ClientVersion": String(clientVersion(PROTOCOL_VERSION)) };
  }

  private async request(
    method: "GET" | "POST",
    endpoint: string,
    opts: { body?: object; timeoutMs: number; signal?: AbortSignal; baseUrl?: string; baseInfo?: boolean },
  ): Promise<string> {
    const url = new URL(endpoint, opts.baseUrl ? opts.baseUrl.replace(/\/?$/, "/") : this.baseUrl);
    const headers: Record<string, string> = this.commonHeaders();
    let body: string | undefined;
    if (method === "POST") {
      Object.assign(headers, { "Content-Type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": randomUin() });
      if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
      const baseInfo = opts.baseInfo === false ? {} : { base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT } };
      body = JSON.stringify({ ...opts.body, ...baseInfo });
    }
    const signals = [AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
    const res = await this.fetch(url, { method, headers, body, signal: AbortSignal.any(signals) });
    const text = await res.text();
    // The endpoint name is enough to diagnose; response bodies may hold tokens.
    if (!res.ok) throw new IlinkError(`${endpoint.split("?")[0]} HTTP ${res.status}`);
    return text;
  }

  // --- Login ---------------------------------------------------------------

  /**
   * Returns the QR payload (`qrcode_img_content` is the URL to encode).
   * `knownTokens` are this machine's existing bot tokens, so iLink can tell
   * a re-login of an already connected bot apart from a new one.
   */
  async getLoginQrCode(knownTokens: string[] = []): Promise<{ qrcode: string; qrcode_img_content: string }> {
    // Login always starts at the fixed host, whatever baseUrl the account uses.
    const text = await this.request("POST", "ilink/bot/get_bot_qrcode?bot_type=3", {
      body: { local_token_list: knownTokens },
      timeoutMs: API_TIMEOUT_MS,
      baseUrl: DEFAULT_BASE_URL,
      baseInfo: false,
    });
    return JSON.parse(text);
  }

  /**
   * Long-polls the scan status. Timeouts and network or gateway errors count
   * as "wait", so a blip mid-scan doesn't end the login.
   */
  async getLoginStatus(qrcode: string, host = DEFAULT_BASE_URL, verifyCode?: string): Promise<QrStatusResp> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      return JSON.parse(await this.request("GET", endpoint, { timeoutMs: LONG_POLL_MS, baseUrl: host }));
    } catch {
      return { status: "wait" };
    }
  }

  // --- Messages ------------------------------------------------------------

  /**
   * Long-polls for new messages after `cursor`. A client-side timeout is
   * normal and returns an empty batch with the same cursor.
   */
  async getUpdates(cursor: string, timeoutMs = LONG_POLL_MS, signal?: AbortSignal): Promise<GetUpdatesResp> {
    try {
      const text = await this.request("POST", "ilink/bot/getupdates", { body: { get_updates_buf: cursor }, timeoutMs, signal });
      return parseIlinkJson<GetUpdatesResp>(text);
    } catch (err) {
      if (isTimeout(err) && !signal?.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw err;
    }
  }

  /** Sends one text message. Returns the server message id, if any. */
  async sendText(to: string, text: string, contextToken: string, clientId = newClientId()): Promise<string | undefined> {
    const raw = await this.request("POST", "ilink/bot/sendmessage", {
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: ItemType.TEXT, text_item: { text } }],
          context_token: contextToken,
        },
      },
      timeoutMs: API_TIMEOUT_MS,
    });
    const resp = parseIlinkJson<{ ret?: number; errmsg?: string; message_id?: string }>(raw);
    if (resp.ret) throw new IlinkError(`sendmessage ret=${resp.ret} ${resp.errmsg ?? ""}`.trim());
    return resp.message_id;
  }

  /** Fetches the per-user ticket needed for typing indicators ("" if none). */
  async getTypingTicket(userId: string, contextToken: string): Promise<string> {
    const raw = await this.request("POST", "ilink/bot/getconfig", {
      body: { ilink_user_id: userId, context_token: contextToken },
      timeoutMs: LIGHT_TIMEOUT_MS,
    });
    const resp = JSON.parse(raw) as { ret?: number; typing_ticket?: string };
    return resp.ret === 0 ? (resp.typing_ticket ?? "") : "";
  }

  async sendTyping(userId: string, ticket: string, status: number): Promise<void> {
    await this.request("POST", "ilink/bot/sendtyping", {
      body: { ilink_user_id: userId, typing_ticket: ticket, status },
      timeoutMs: LIGHT_TIMEOUT_MS,
    });
  }

  /** Tells iLink this client started or stopped; failures are harmless. */
  async notify(event: "start" | "stop"): Promise<void> {
    await this.request("POST", `ilink/bot/msg/notify${event}`, { body: {}, timeoutMs: LIGHT_TIMEOUT_MS });
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
