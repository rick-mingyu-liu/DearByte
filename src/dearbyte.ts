// 小拜 as a real WeChat account. WeChat for Mac runs logged in as 小拜; this
// answers one bound chat by reading and typing through macOS Accessibility.
//
//   npm run dearbyte                 # answer the bound chat automatically
//   npm run dearbyte -- --draft      # show replies in the terminal, never send
//   npm run dearbyte -- --chat 张三   # bind (or rebind) the chat to answer
//   npm run dearbyte -- --fake       # no model calls; replies are labelled fake
//   npm run dearbyte -- --memory on  # long-term memory on (or off); saved
//   npm run dearbyte -- --proactive off  # 小拜 never writes first (on by default); saved

import { createInterface } from "node:readline/promises";
import { DesktopChannel, type DesktopEvent } from "./channels/desktop/channel.ts";
import { DesktopHelper } from "./channels/desktop/helper.ts";
import { PhotoFolder } from "./channels/desktop/photos.ts";
import { Companion } from "./companion/companion.ts";
import { dayState, planProactive, type ProactiveState } from "./companion/proactive.ts";
import { loadPromptParts } from "./companion/prompt.ts";
import { localDate } from "./companion/time.ts";
import { loadConfig, ROOT } from "./config.ts";
import { COMMON_HELP, describeEvent, describeReplyEvent, log, runSharedCommand } from "./console.ts";
import { DeepSeekModel } from "./model/deepseek.ts";
import { FakeModel } from "./model/fake.ts";
import type { ChatModel } from "./model/provider.ts";
import { Store } from "./storage/store.ts";

const CHAT_SETTING = "wechat_chat";
const PROACTIVE_SETTING = "proactive_enabled";
const PROACTIVE_STATE = "proactive_state";
/** How often to consider writing first. */
const PROACTIVE_TICK_MS = 60_000;
const HELP = `命令（聊天请用手机微信发给小拜）：
  /pause                暂停：新消息跳过，不回复
  /resume               恢复自动回复
  /proactive on | off   小拜会不会主动找你（早安、考试打气、好久没聊时问候）
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
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
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

  // Bind the chat to answer. Binding is always explicit, so 小拜 never starts
  // answering whichever chat happened to be open.
  const requested = argValue(argv, "--chat");
  const chat = requested ?? store.getSetting(CHAT_SETTING);
  if (!chat) {
    console.error(
      open.chat
        ? `还没绑定聊天。微信当前打开的是「${open.chat}」；确认是和你的一对一聊天后，运行：\n  npm run dearbyte -- --chat ${open.chat}`
        : "还没绑定聊天。先在 Mac 微信里点开和你的聊天，再运行 npm run dearbyte -- --chat <聊天名字>",
    );
    ui.close();
    store.close();
    process.exit(1);
  }
  if (chat !== store.getSetting(CHAT_SETTING)) {
    store.setSetting(CHAT_SETTING, chat);
    log(`绑定聊天「${chat}」：小拜只回复这个聊天。换聊天用 --chat <名字>`);
  }

  for (const [flag, apply] of [
    ["--memory", (on: boolean) => store.setMemoryEnabled(on)],
    ["--proactive", (on: boolean) => store.setSetting(PROACTIVE_SETTING, String(on))],
  ] as const) {
    const value = argValue(argv, flag);
    if (value === "on" || value === "off") apply(value === "on");
    else if (argv.includes(flag)) {
      console.error(`${flag} 后面要写 on 或 off`);
      process.exit(1);
    }
  }
  const proactiveEnabled = () => store.getSetting(PROACTIVE_SETTING) !== "false";

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
        `主动消息${proactiveEnabled() ? "开启" : "关闭"} · 微信「${chat}」· ${channel.mode === "draft" ? "草稿模式（不发送）" : channel.paused ? "已暂停" : "自动回复"}`,
    );
  status();

  const stop = new AbortController();
  const running = channel.run(stop.signal);

  // Once a minute: should 小拜 write first? The plan's rules keep it rare.
  let ticking = false;
  const tick = async () => {
    if (ticking || !proactiveEnabled() || channel.mode === "draft") return;
    ticking = true;
    try {
      const now = new Date();
      const saved = store.getSetting(PROACTIVE_STATE);
      const state = dayState(saved ? (JSON.parse(saved) as ProactiveState) : null, localDate(now, config.timeZone), Math.random);
      store.setSetting(PROACTIVE_STATE, JSON.stringify(state));
      const plan = planProactive({
        now,
        timeZone: config.timeZone,
        state,
        history: store.recentMessages(config.historyMessages),
        facts: store.memoryEnabled() ? store.activeFacts() : [],
      });
      if (!plan) return;
      const attempted = await channel.initiate(plan.key, async () => (await companion.initiate(plan.note)).bubbles);
      // Recorded once attempted, sent or not, so a failure isn't retried every minute.
      if (attempted) store.setSetting(PROACTIVE_STATE, JSON.stringify({ ...state, sent: [...state.sent, plan.key], lastAt: now.toISOString() }));
    } catch (err) {
      log(`主动消息出错：${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  };
  const ticker = setInterval(() => void tick(), PROACTIVE_TICK_MS);
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      rl?.close();
      clearInterval(ticker);
      channel.stopping = true; // type nothing more into WeChat
      stop.abort();
      await running;
      await channel.settle(); // replies in flight and the memory work they start
      ui.close();
      store.close();
    })());

  // Commands need a terminal; without one the bot runs until SIGINT/SIGTERM.
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  // A second Ctrl+C quits at once, without waiting for memory work.
  const interrupt = () => (closing ? process.exit(130) : void shutdown().then(() => process.exit(0)));
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
        channel.resume();
        log("已恢复自动回复。暂停期间的消息不会补回");
      } else if (line === "/proactive on" || line === "/proactive off") {
        store.setSetting(PROACTIVE_SETTING, String(line.endsWith("on")));
        log(line.endsWith("on") ? "主动消息已开启：每天最多 2 条，晚上不发，上一条没回不再发" : "主动消息已关闭");
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
