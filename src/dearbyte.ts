// 小拜 as a real WeChat account. WeChat for Mac runs logged in as 小拜; this
// answers one bound chat by reading and typing through macOS Accessibility.
//
//   npm run dearbyte                 # answer the bound chat automatically
//   npm run dearbyte -- --draft      # show replies in the terminal, never send
//   npm run dearbyte -- --chat 张三   # bind (or rebind) the chat to answer
//   npm run dearbyte -- --fake       # no model calls; replies are labelled fake

import { createInterface } from "node:readline/promises";
import { DesktopChannel, type DesktopEvent } from "./channels/desktop/channel.ts";
import { DesktopHelper } from "./channels/desktop/helper.ts";
import { PhotoFolder } from "./channels/desktop/photos.ts";
import { Companion } from "./companion/companion.ts";
import { loadPromptParts } from "./companion/prompt.ts";
import { loadConfig, ROOT } from "./config.ts";
import { COMMON_HELP, describeEvent, describeReplyEvent, log, runSharedCommand } from "./console.ts";
import { DeepSeekModel } from "./model/deepseek.ts";
import { FakeModel } from "./model/fake.ts";
import type { ChatModel } from "./model/provider.ts";
import { Store } from "./storage/store.ts";

const CHAT_SETTING = "wechat_chat";
const HELP = `命令（聊天请用手机微信发给小拜）：
  /pause                暂停：新消息跳过，不回复
  /resume               恢复自动回复
${COMMON_HELP}`;

function describeDesktopEvent(e: DesktopEvent): string | null {
  switch (e.type) {
    case "status":
      return e.message;
    case "skipped":
      return `暂停中，${e.count} 条新消息没有回复`;
    default:
      return describeReplyEvent(e);
  }
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
  const config = loadConfig();
  const argv = process.argv.slice(2);
  const fake = argv.includes("--fake");
  if (!fake && !config.apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（写在 .env 里），或用 --fake 测试。");
    process.exit(1);
  }

  const ui = new DesktopHelper();
  const store = Store.open(config.dbPath);
  let open;
  try {
    open = await ui.snapshot();
  } catch (err) {
    console.error(`连不上微信：${(err as Error).message}`);
    ui.close();
    process.exit(1);
  }

  // Bind the chat to answer. The first run binds whatever chat is open.
  const requested = argValue(argv, "--chat");
  const chat = requested ?? store.getSetting(CHAT_SETTING) ?? open.chat;
  if (!chat) {
    console.error("微信里没有打开的聊天。先在 Mac 微信里点开和你的聊天，再运行。");
    process.exit(1);
  }
  if (chat !== store.getSetting(CHAT_SETTING)) {
    store.setSetting(CHAT_SETTING, chat);
    log(`绑定聊天「${chat}」：小拜只回复这个聊天。换聊天用 --chat <名字>`);
  }

  let photos: PhotoFolder | null = null;
  if (config.wechatMediaDir) {
    photos = new PhotoFolder(config.wechatMediaDir);
    photos.markExistingSeen();
  } else log("没有设置 COMPANION_WECHAT_MEDIA_DIR：收到图片时小拜会说看不到");

  const model: ChatModel = fake ? new FakeModel() : new DeepSeekModel(config.apiKey!, config.model);
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
  const channel = new DesktopChannel({
    ui,
    companion,
    chat,
    photos,
    mode: argv.includes("--draft") ? "draft" : "auto",
    onEvent: (e) => {
      const line = describeDesktopEvent(e);
      if (!line) return;
      if (e.type === "inbound" || e.type === "sent" || e.type === "drafted") console.log(line);
      else log(line);
    },
  });

  const status = () =>
    log(
      `模型 ${model.name}${fake ? "（假模型，会发出标明是假的回复）" : ""} · ${store.messageCount()} 条聊天记录 · ` +
        `长期记忆${store.memoryEnabled() ? `开启（${store.activeFacts().length} 条）` : "关闭"} · ` +
        `微信「${chat}」· ${channel.mode === "draft" ? "草稿模式（不发送）" : channel.paused ? "已暂停" : "自动回复"}`,
    );
  status();

  const stop = new AbortController();
  const running = channel.run(stop.signal);
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      rl?.close();
      stop.abort();
      await running;
      await channel.settle(); // replies in flight and the memory work they start
      ui.close();
      store.close();
    })());

  // Commands need a terminal; without one the bot runs until SIGINT/SIGTERM.
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const interrupt = () => void shutdown().then(() => process.exit(0));
  rl?.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt).on("SIGTERM", interrupt);

  if (!rl) {
    log("没有交互终端，不接受命令；Ctrl+C 或 SIGTERM 退出");
    await running;
  } else {
    log("输入 /help 查看命令，/quit 退出");
    const settle = () => channel.settle();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      if (line === "/quit") break;
      else if (line === "/help") console.log(HELP);
      else if (line === "/status") status();
      else if (line === "/pause") {
        channel.paused = true;
        log("已暂停：新消息跳过，不回复（/resume 恢复）");
      } else if (line === "/resume") {
        channel.paused = false;
        log("已恢复自动回复。暂停期间的消息不会补回");
      } else if (!(await runSharedCommand(line, { store, timeZone: config.timeZone, settle }))) {
        log(line.startsWith("/") ? `未知命令 ${line.split(/\s+/)[0]}，输入 /help 查看` : "这里只能输入命令，聊天请用手机微信发给小拜");
      }
    }
  }
  await shutdown();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
