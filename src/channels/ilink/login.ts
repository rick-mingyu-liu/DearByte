// QR login: show a code, the user scans it in WeChat, iLink returns a bot token.

import { DEFAULT_BASE_URL, IlinkClient } from "./client.ts";
import type { Account } from "./account.ts";

const LOGIN_TIMEOUT_MS = 8 * 60_000;
const MAX_QR_CODES = 3;

export type LoginIo = {
  showQr: (url: string) => void;
  say: (text: string) => void;
  /** Asks for the number shown on the phone, when iLink requires it. */
  ask: (question: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

export class LoginError extends Error {}

/**
 * `existing` is the saved login, if any: its token is offered to iLink, and
 * it is kept when iLink says this bot is already connected.
 */
export async function loginWithQr(client: IlinkClient, io: LoginIo, existing: Account | null = null): Promise<Account> {
  const now = io.now ?? Date.now;
  const deadline = now() + LOGIN_TIMEOUT_MS;
  let codes = 0;
  let qrcode = "";
  let host = DEFAULT_BASE_URL;
  let verifyCode: string | undefined;
  let scanned = false;

  const newCode = async () => {
    if (++codes > MAX_QR_CODES) throw new LoginError("二维码多次过期，登录已停止，请稍后再试");
    const qr = await client.getLoginQrCode(existing ? [existing.botToken] : []);
    qrcode = qr.qrcode;
    host = DEFAULT_BASE_URL;
    scanned = false;
    io.showQr(qr.qrcode_img_content);
  };

  await newCode();
  while (now() < deadline) {
    const status = await client.getLoginStatus(qrcode, host, verifyCode);
    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        verifyCode = undefined;
        if (!scanned) io.say("已扫码，请在手机上确认");
        scanned = true;
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) host = `https://${status.redirect_host}`;
        break;
      case "need_verifycode":
        verifyCode = await io.ask(verifyCode ? "数字不对，请重新输入手机上显示的数字：" : "请输入手机微信上显示的数字：");
        continue;
      case "expired":
        io.say("二维码过期了，换一张");
        await newCode();
        break;
      case "verify_code_blocked":
        io.say("数字输错太多次，换一张二维码");
        verifyCode = undefined;
        await newCode();
        break;
      case "binded_redirect":
        if (existing) {
          io.say("这个微信已经连着小拜了，继续用已保存的登录");
          return existing;
        }
        throw new LoginError("这个微信已经连过一个 ClawBot。请在微信里先解除原来的连接，再重新登录");
      case "confirmed": {
        const { bot_token, ilink_bot_id, ilink_user_id, baseurl } = status;
        if (!bot_token || !ilink_bot_id || !ilink_user_id) throw new LoginError("登录确认了，但 iLink 没有返回完整的账号信息");
        return {
          botToken: bot_token,
          botId: ilink_bot_id,
          baseUrl: baseurl || DEFAULT_BASE_URL,
          ownerId: ilink_user_id,
          savedAt: new Date(now()).toISOString(),
        };
      }
    }
    await io.sleep(1000);
  }
  throw new LoginError("登录超时，请重试");
}
