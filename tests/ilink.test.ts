import { createCipheriv } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountFileError, loadAccount, saveAccount } from "../src/channels/ilink/account.ts";
import { expect, test } from "vitest";
import { WechatBridge, type BridgeEvent } from "../src/channels/ilink/bridge.ts";
import { BOT_AGENT, clientVersion, IlinkClient, parseIlinkJson, randomUin, type Fetch } from "../src/channels/ilink/client.ts";
import { mergeInbound, readMessage } from "../src/channels/ilink/inbound.ts";
import { LoginError, loginWithQr } from "../src/channels/ilink/login.ts";
import { downloadImage, imageKey } from "../src/channels/ilink/media.ts";
import type { GetUpdatesResp, QrStatusResp, WeixinMessage } from "../src/channels/ilink/types.ts";
import { Companion } from "../src/companion/companion.ts";
import { FALLBACK_REPLY } from "../src/companion/output.ts";
import { loadPromptParts } from "../src/companion/prompt.ts";
import { ROOT } from "../src/config.ts";
import { FakeModel } from "../src/model/fake.ts";
import { Store } from "../src/storage/store.ts";

const OWNER = "owner@im.wechat";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const userMsg = (id: string, items: WeixinMessage["item_list"], extra: Partial<WeixinMessage> = {}): WeixinMessage => ({
  message_id: id,
  from_user_id: OWNER,
  message_type: 1,
  context_token: `ctx-${id}`,
  item_list: items,
  ...extra,
});
const text = (t: string) => ({ type: 1, text_item: { text: t } });

// --- Protocol --------------------------------------------------------------

test("keeps uint64 message ids exact and leaves strings alone", () => {
  const raw = `{"msgs":[{"message_id": 18446744073709551615,"seq":3,"note":"\\"message_id\\":1"}],"svr_id":-5}`;
  const parsed = parseIlinkJson<{ msgs: { message_id: string; seq: number; note: string }[]; svr_id: string }>(raw);
  expect(parsed.msgs[0].message_id).toBe("18446744073709551615");
  expect(parsed.msgs[0].seq).toBe(3);
  expect(parsed.msgs[0].note).toBe('"message_id":1');
  expect(parsed.svr_id).toBe("-5");
});

test("encodes the client version and a numeric UIN", () => {
  expect(clientVersion("2.4.9")).toBe(0x020409);
  expect(Buffer.from(randomUin(), "base64").toString()).toMatch(/^\d+$/);
});

function recordingFetch(respond: (url: string, body: any) => unknown = () => ({ ret: 0 })) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    return new Response(JSON.stringify(respond(url, body)));
  };
  return { calls, fetchImpl };
}

test("sends text with auth headers, base_info and the context token", async () => {
  const { calls, fetchImpl } = recordingFetch(() => ({ ret: 0 }));
  const client = new IlinkClient({ baseUrl: "https://example.test", token: "tok", fetch: fetchImpl });
  await client.sendText(OWNER, "你好", "ctx-1");

  const [call] = calls;
  expect(call.url).toBe("https://example.test/ilink/bot/sendmessage");
  expect(call.headers).toMatchObject({ Authorization: "Bearer tok", AuthorizationType: "ilink_bot_token", "iLink-App-Id": "bot" });
  expect(call.body.base_info.bot_agent).toBe(BOT_AGENT);
  expect(call.body.msg).toMatchObject({
    to_user_id: OWNER,
    message_type: 2,
    message_state: 2,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "你好" } }],
  });
});

test("a send error surfaces; a long-poll timeout is an empty batch", async () => {
  const failing = new IlinkClient({ fetch: recordingFetch(() => ({ ret: -2, errmsg: "bad" })).fetchImpl });
  await expect(failing.sendText(OWNER, "x", "c")).rejects.toThrow("ret=-2");

  const timingOut = new IlinkClient({
    fetch: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  expect(await timingOut.getUpdates("cursor-1")).toEqual({ ret: 0, msgs: [], get_updates_buf: "cursor-1" });
});

// --- Media -----------------------------------------------------------------

const encrypt = (data: Uint8Array, key: Buffer) => {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

test("reads the image key in all three encodings", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  expect(imageKey({ aeskey: key.toString("hex") })).toEqual(key);
  expect(imageKey({ media: { aes_key: key.toString("base64") } })).toEqual(key);
  expect(imageKey({ media: { aes_key: Buffer.from(key.toString("hex")).toString("base64") } })).toEqual(key);
  expect(imageKey({ media: {} })).toBeNull();
});

test("downloads and decrypts a photo", async () => {
  const key = Buffer.alloc(16, 7);
  const urls: string[] = [];
  const fetchImpl: Fetch = async (input) => {
    urls.push(String(input));
    return new Response(encrypt(JPEG, key));
  };
  const bytes = await downloadImage({ aeskey: key.toString("hex"), media: { encrypt_query_param: "a b" } }, fetchImpl);
  expect(bytes).toEqual(JPEG);
  expect(urls[0]).toBe("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%20b");
});

// --- Inbound ---------------------------------------------------------------

test("reads user messages and skips bot, group and token-less ones", () => {
  expect(readMessage(userMsg("1", [text("嗨")]))).toMatchObject({ messageId: "1", text: "嗨", contextToken: "ctx-1", image: null });
  expect(readMessage(userMsg("2", [text("x")], { message_type: 2 }))).toBeNull();
  expect(readMessage(userMsg("3", [text("x")], { group_id: "g" }))).toBeNull();
  expect(readMessage(userMsg("4", [text("x")], { context_token: undefined }))).toBeNull();
  expect(readMessage(userMsg("5", []))).toBeNull();
});

test("turns voice, files, video and quotes into text the model can answer", () => {
  expect(readMessage(userMsg("1", [{ type: 3, voice_item: { text: "今天好累" } }]))?.text).toBe("今天好累");
  expect(readMessage(userMsg("2", [{ type: 3, voice_item: {} }]))?.text).toContain("听不到");
  expect(readMessage(userMsg("3", [{ type: 4, file_item: { file_name: "a.pdf" } }]))?.text).toContain("「a.pdf」");
  expect(readMessage(userMsg("4", [{ type: 5, video_item: {} }]))?.text).toContain("视频");
  expect(readMessage(userMsg("5", [{ ...text("对"), ref_msg: { title: "明天见" } }]))?.text).toBe("（引用了：「明天见」）\n对");
});

test("merges a burst into one turn with the latest photo and token", () => {
  const img = (id: string) => ({ type: 2, image_item: { aeskey: id } });
  const batch = [userMsg("1", [text("看")]), userMsg("2", [img("a")]), userMsg("3", [img("b")])].map((m) => readMessage(m)!);
  const merged = mergeInbound(batch);
  expect(merged.text).toBe("看\n（用户还发了另外 1 张图，你只看到了最后一张）");
  expect(merged.image?.aeskey).toBe("b");
  expect(merged.contextToken).toBe("ctx-3");
});

// --- Login -----------------------------------------------------------------

function loginClient(statuses: QrStatusResp[]) {
  const polls: { host: string; verifyCode?: string }[] = [];
  let codes = 0;
  const client = {
    getLoginQrCode: async () => ({ qrcode: `qr${++codes}`, qrcode_img_content: `https://qr/${codes}` }),
    getLoginStatus: async (_qr: string, host: string, verifyCode?: string) => {
      polls.push({ host, verifyCode });
      return statuses.shift() ?? { status: "wait" };
    },
  } as unknown as IlinkClient;
  return { client, polls };
}

const loginIo = (answers: string[] = []) => {
  const shown: string[] = [];
  return {
    shown,
    io: { showQr: (u: string) => shown.push(u), say: () => {}, ask: async () => answers.shift() ?? "", sleep: async () => {} },
  };
};

test("login follows redirects and verify codes to a saved account", async () => {
  const { client, polls } = loginClient([
    { status: "wait" },
    { status: "scaned_but_redirect", redirect_host: "idc2.example" },
    { status: "need_verifycode" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", ilink_user_id: OWNER, baseurl: "https://api.example" },
  ]);
  const { io, shown } = loginIo(["42"]);
  const account = await loginWithQr(client, io);

  expect(account).toMatchObject({ botToken: "tok", botId: "bot1", ownerId: OWNER, baseUrl: "https://api.example" });
  expect(shown).toEqual(["https://qr/1"]);
  expect(polls[2].host).toBe("https://idc2.example");
  expect(polls[3]).toEqual({ host: "https://idc2.example", verifyCode: "42" });
});

test("login gives up after three expired codes", async () => {
  const { client } = loginClient([{ status: "expired" }, { status: "expired" }, { status: "expired" }]);
  const { io, shown } = loginIo();
  await expect(loginWithQr(client, io)).rejects.toThrow(LoginError);
  expect(shown).toHaveLength(3);
});

// --- Bridge ----------------------------------------------------------------

const reply = (...bubbles: string[]) => JSON.stringify({ bubbles });

function bridgeSetup(opts: { responses?: ConstructorParameters<typeof FakeModel>[0]; updates?: GetUpdatesResp[]; download?: () => Promise<Uint8Array> } = {}) {
  const store = Store.open(":memory:");
  const model = new FakeModel(opts.responses ?? []);
  const companion = new Companion({ store, model, parts: loadPromptParts(ROOT), timeZone: "Asia/Shanghai", historyMessages: 40 });
  const sent: { to: string; text: string; token: string }[] = [];
  const typing: number[] = [];
  const updates = [...(opts.updates ?? [])];
  const stop = new AbortController();
  const client = {
    sendText: async (to: string, t: string, token: string) => void sent.push({ to, text: t, token }),
    getTypingTicket: async () => "ticket",
    sendTyping: async (_u: string, _t: string, status: number) => void typing.push(status),
    getUpdates: async () => {
      const next = updates.shift();
      if (!next) stop.abort();
      return next ?? { ret: 0 };
    },
  } as unknown as IlinkClient;
  const events: BridgeEvent[] = [];
  const bridge = new WechatBridge({
    client,
    companion,
    store,
    ownerId: OWNER,
    downloadImage: opts.download ?? (async () => JPEG),
    onEvent: (e) => events.push(e),
    sleep: async () => {},
  });
  const settle = () => bridge.settle();
  return { store, model, bridge, sent, typing, events, stop, settle };
}

test("answers the owner's burst once, bubble by bubble, and ignores others", async () => {
  const { bridge, sent, typing, model, events, settle } = bridgeSetup({ responses: [reply("在呢", "咋了")] });
  bridge.accept([
    userMsg("1", [text("在吗")]),
    userMsg("2", [text("问你个事")]),
    userMsg("9", [text("hi")], { from_user_id: "stranger" }),
    userMsg("1", [text("在吗")]),
  ]);
  await settle();

  expect(sent).toEqual([
    { to: OWNER, text: "在呢", token: "ctx-2" },
    { to: OWNER, text: "咋了", token: "ctx-2" },
  ]);
  expect(model.calls[0].messages.at(-1)?.content).toBe("在吗\n问你个事");
  expect(typing.at(-1)).toBe(2);
  expect(events.filter((e) => e.type === "ignored").map((e) => e.type === "ignored" && e.reason)).toEqual(["other_user", "duplicate"]);
});

test("passes photos to the model and says so when a download fails", async () => {
  const ok = bridgeSetup();
  ok.bridge.accept([userMsg("1", [{ type: 2, image_item: { aeskey: "00" } }])]);
  await ok.settle();
  const content = ok.model.calls[0].messages.at(-1)?.content;
  expect(Array.isArray(content) && content.some((p) => p.type === "image_url")).toBe(true);

  const broken = bridgeSetup({ download: async () => Promise.reject(new Error("CDN 404")) });
  broken.bridge.accept([userMsg("1", [text("看我的猫"), { type: 2, image_item: { aeskey: "00" } }])]);
  await broken.settle();
  expect(broken.model.calls[0].messages.at(-1)?.content).toBe("看我的猫\n（用户发了一张图，但图片没加载出来，你看不到）");
});

test("sends the fallback reply when the model call fails", async () => {
  const { bridge, sent, settle } = bridgeSetup({
    responses: [
      () => {
        throw new Error("network down");
      },
    ],
  });
  bridge.accept([userMsg("1", [text("喂")])]);
  await settle();
  expect(sent.map((s) => s.text)).toEqual(FALLBACK_REPLY.bubbles);
});

test("the poll loop saves the cursor and reports a stale token", async () => {
  const { bridge, store, stop, events, sent, settle } = bridgeSetup({
    updates: [{ ret: 0, get_updates_buf: "cur-2", msgs: [userMsg("1", [text("早")])] }, { ret: -14, errcode: -14 }],
  });
  await bridge.run(stop.signal);
  await settle();
  expect(store.getSetting("ilink_cursor")).toBe("cur-2");
  expect(events.some((e) => e.type === "stale_token")).toBe(true);
  expect(sent).toHaveLength(2);
});

// --- Review follow-ups -----------------------------------------------------

test("QR login sends known tokens without base_info; status polls carry no token", async () => {
  const { calls, fetchImpl } = recordingFetch((url) => (url.includes("get_bot_qrcode") ? { qrcode: "q", qrcode_img_content: "u" } : { status: "wait" }));
  const client = new IlinkClient({ token: "tok", fetch: fetchImpl });
  await client.getLoginQrCode(["old-token"]);
  await client.getLoginStatus("q");
  expect(calls[0].body).toEqual({ local_token_list: ["old-token"] });
  expect(calls[1].headers.Authorization).toBeUndefined();
  expect(calls[1].headers["iLink-App-ClientVersion"]).toBe(String(0x020409));
});

test("a network error while polling the QR status keeps waiting", async () => {
  const client = new IlinkClient({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  expect(await client.getLoginStatus("q")).toEqual({ status: "wait" });
});

test("re-login keeps the saved account when iLink says it is already bound", async () => {
  const existing = { botToken: "t", botId: "b", baseUrl: "https://x.example", ownerId: OWNER, savedAt: "2026-09-24T00:00:00Z" };
  const { client } = loginClient([{ status: "binded_redirect" }]);
  expect(await loginWithQr(client, loginIo().io, existing)).toBe(existing);
  const fresh = loginClient([{ status: "binded_redirect" }]);
  await expect(loginWithQr(fresh.client, loginIo().io)).rejects.toThrow("已经连过");
});

test("the account file is private, and a broken one is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-acct-"));
  const path = join(dir, "account.json");
  writeFileSync(path, "{}", { mode: 0o644 });
  const account = { botToken: "t", botId: "b", baseUrl: "https://x.example", ownerId: OWNER, savedAt: "now" };
  saveAccount(path, account);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(loadAccount(path)).toEqual(account);

  writeFileSync(path, "{not json");
  expect(() => loadAccount(path)).toThrow(AccountFileError);
  writeFileSync(path, JSON.stringify({ ...account, baseUrl: "nope" }));
  expect(() => loadAccount(path)).toThrow("baseUrl");
  expect(loadAccount(join(dir, "missing.json"))).toBeNull();
});

test("a message arriving mid-reply becomes the next turn", async () => {
  let bridge!: WechatBridge;
  const setup = bridgeSetup({
    responses: [
      () => {
        // The owner sends another message while the first reply is generating.
        bridge.accept([userMsg("2", [text("还有这个")])]);
        return reply("一");
      },
      reply("二"),
    ],
  });
  bridge = setup.bridge;
  bridge.accept([userMsg("1", [text("先说这个")])]);
  await setup.settle();
  expect(setup.model.calls.map((c) => c.messages.at(-1)?.content)).toEqual(["先说这个", "还有这个"]);
  expect(setup.sent.map((s) => s.text)).toEqual(["一", "二"]);
});

test("settle waits for memory work started by the last turn", async () => {
  const { bridge, store, settle } = bridgeSetup({
    responses: [reply("好"), JSON.stringify({ facts: [{ category: "event", key: "interview", value: "用户下周三面试", eventDate: null, evidence: "我下周三面试" }] })],
  });
  store.setMemoryEnabled(true);
  bridge.accept([userMsg("1", [text("我下周三面试")])]);
  await settle();
  expect(store.activeFacts().map((f) => f.key)).toEqual(["interview"]);
});

test("a failed bubble is retried once with the same client id", async () => {
  const setup = bridgeSetup({ responses: [reply("在")] });
  const ids: string[] = [];
  let failures = 1;
  (setup.bridge as any).deps.client.sendText = async (_to: string, _t: string, _token: string, clientId: string) => {
    ids.push(clientId);
    if (failures-- > 0) throw new Error("timeout");
  };
  setup.bridge.accept([userMsg("1", [text("喂")])]);
  await setup.settle();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(setup.events.some((e) => e.type === "sent")).toBe(true);
});
