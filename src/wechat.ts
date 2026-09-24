// WeChat runner: 小拜 answers you in WeChat through iLink (the API behind
// 微信 ClawBot). Only the WeChat user who scanned the QR code gets replies.
//
//   npm run dearbyte              # first run shows a QR code to scan
//   npm run dearbyte -- --login   # scan again (new token)
//   npm run dearbyte -- --logout  # delete the saved login
//   npm run dearbyte -- --fake    # no model calls; WeChat gets labelled fake replies

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";
import { AccountFileError, type Account, deleteAccount, loadAccount, saveAccount } from "./channels/ilink/account.ts";
import { WechatBridge, type BridgeEvent } from "./channels/ilink/bridge.ts";
import { IlinkClient } from "./channels/ilink/client.ts";
import { LoginError, loginWithQr } from "./channels/ilink/login.ts";
import { downloadImage } from "./channels/ilink/media.ts";
import { Companion } from "./companion/companion.ts";
import { loadPromptParts } from "./companion/prompt.ts";
import { loadConfig, ROOT } from "./config.ts";
import { COMMON_HELP, describeEvent, dim, log, runSharedCommand, sleep } from "./console.ts";
import { DeepSeekModel } from "./model/deepseek.ts";
import { FakeModel } from "./model/fake.ts";
import type { ChatModel } from "./model/provider.ts";
import { Store } from "./storage/store.ts";

const HELP = `命令（聊天请在微信里发给「微信 ClawBot」）：
${COMMON_HELP}`;

function describeBridgeEvent(e: BridgeEvent): string | null {
  switch (e.type) {
    case "inbound":
      return `微信 › ${e.text || "（无文字）"}${e.image ? " [图片]" : ""}${e.merged > 1 ? dim(`（${e.merged} 条合并为一轮）`) : ""}`;
    case "sent":
      return `小拜 › ${e.bubble}`;
    case "turn":
      return null;
    case "ignored":
      return e.reason === "other_user" ? "忽略了一条其他人发来的消息（只回复扫码的人）" : "忽略了一条重复消息";
    case "error":
      return `出错：${e.message}`;
    case "stale_token":
      return "微信登录已失效（errcode -14），暂停 1 小时。可以 /quit 后运行 npm run dearbyte -- --login 重新扫码";
  }
}

async function main() {
  const config = loadConfig();
  const argv = process.argv.slice(2);
  const fake = argv.includes("--fake");

  if (argv.includes("--logout")) {
    deleteAccount(config.wechatAccountPath);
    console.log("已删除本地保存的微信登录。要彻底断开，也可以在微信里删除「微信 ClawBot」。");
    return;
  }
  if (!fake && !config.apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（写在 .env 里），或用 --fake 测试连接。");
    process.exit(1);
  }

  // Commands need a terminal. Without one (nohup, launchd) the bot still runs
  // until SIGINT/SIGTERM.
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let onInterrupt: () => void = () => process.exit(130); // replaced by a clean shutdown once running
  const interrupt = () => onInterrupt();
  rl?.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt).on("SIGTERM", interrupt);

  let account = argv.includes("--login") ? null : loadAccount(config.wechatAccountPath);
  if (!account) {
    let existing: Account | null = null;
    try {
      existing = loadAccount(config.wechatAccountPath);
    } catch {
      // unusable file: log in from scratch and overwrite it
    }
    console.log("用手机微信扫描下面的二维码，把小拜连到你的微信：\n");
    account = await loginWithQr(
      new IlinkClient(),
      {
        showQr: (url) => {
          qrcode.generate(url, { small: true });
          console.log(dim(`二维码显示不全的话，用微信打开这个链接：${url}\n`));
        },
        say: (text) => log(text),
        ask: rl ? (question) => rl.question(question) : async () => Promise.reject(new LoginError("需要输入手机上的数字，请在交互终端里登录")),
        sleep,
      },
      existing,
    );
    if (account !== existing) {
      mkdirSync(dirname(config.wechatAccountPath), { recursive: true });
      saveAccount(config.wechatAccountPath, account);
      log(`登录成功，已保存到 ${config.wechatAccountPath.replace(ROOT, "")}（不会提交到 git）`);
      log("微信里会出现「微信 ClawBot」，可以给它设备注“小拜”。");
    }
  }

  const model: ChatModel = fake ? new FakeModel() : new DeepSeekModel(config.apiKey!, config.model);
  const store = Store.open(config.dbPath);
  const companion = new Companion({
    store,
    model,
    parts: loadPromptParts(ROOT),
    timeZone: config.timeZone,
    historyMessages: config.historyMessages,
    onEvent: (e) => {
      const line = describeEvent(e);
      if (line) log(line);
    },
  });
  const client = new IlinkClient({ baseUrl: account.baseUrl, token: account.botToken });
  const bridge = new WechatBridge({
    client,
    companion,
    store,
    ownerId: account.ownerId,
    downloadImage: (image) => downloadImage(image),
    onEvent: (e) => {
      const line = describeBridgeEvent(e);
      if (line) (e.type === "inbound" || e.type === "sent" ? console.log(line) : log(line));
    },
  });

  const status = () =>
    log(
      `模型 ${model.name}${fake ? "（假模型，微信里会收到标明是假的回复）" : ""} · ${store.messageCount()} 条聊天记录 · ` +
        `长期记忆${store.memoryEnabled() ? `开启（${store.activeFacts().length} 条）` : "关闭"} · 渠道：微信 ClawBot（只回复扫码的人）`,
    );
  status();

  await client.notify("start").catch(() => {});
  const stop = new AbortController();
  const running = bridge.run(stop.signal);

  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      rl?.close();
      stop.abort();
      await running;
      await bridge.settle(); // replies in flight and the memory work they start
      await client.notify("stop").catch(() => {});
      store.close();
    })());
  onInterrupt = () => void shutdown().then(() => process.exit(0));

  if (!rl) {
    log("正在等待微信消息…（没有交互终端，不接受命令；Ctrl+C 或 SIGTERM 退出）");
    await running;
  } else {
    log("正在等待微信消息… 输入 /help 查看命令，/quit 退出");
    const settle = () => bridge.settle();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      if (line === "/quit") break;
      else if (line === "/help") console.log(HELP);
      else if (line === "/status") status();
      else if (!(await runSharedCommand(line, { store, timeZone: config.timeZone, settle }))) {
        log(line.startsWith("/") ? `未知命令 ${line.split(/\s+/)[0]}，输入 /help 查看` : "这里只能输入命令，聊天请在微信里发");
      }
    }
  }
  await shutdown();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof AccountFileError) console.error("可以运行 npm run dearbyte -- --login 重新扫码");
  process.exit(1);
});
