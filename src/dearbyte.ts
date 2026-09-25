// 小拜 as a real WeChat account. WeChat for Mac runs logged in as 小拜; this
// answers one bound chat by reading and typing through macOS Accessibility.
//
//   npm run dearbyte                 # answer the bound chat automatically
//   npm run dearbyte -- --draft      # show replies in the terminal, never send
//   npm run dearbyte -- --film       # a clean log to show on camera
//   npm run dearbyte -- --chat 张三   # first run: create data/contacts.json for this chat
//   npm run dearbyte -- --fake       # no model calls; replies are labelled fake
//   npm run dearbyte -- --memory on  # long-term memory on (or off); saved
//   npm run dearbyte -- --proactive off  # 小拜 never writes first (on by default); saved

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DesktopChannel, type DesktopEvent } from "./channels/desktop/channel.ts";
import { DesktopHelper, HelperError } from "./channels/desktop/helper.ts";
import { PhotoFolder } from "./channels/desktop/photos.ts";
import { Companion, CRISIS_AT_SETTING } from "./companion/companion.ts";
import { dayState, planProactive, PROACTIVE_STATE_SETTING, readProactiveState, recordAttempt } from "./companion/proactive.ts";
import { loadPromptParts } from "./companion/prompt.ts";
import { localDate } from "./companion/time.ts";
import { systemNotifier, Watchdog } from "./alerts.ts";
import { filmChannelLine, filmCompanionLine } from "./film.ts";
import { loadConfig, ROOT } from "./config.ts";
import { applyRetention } from "./memory/summary.ts";
import { contactNamesMatch, loadContacts, saveContacts, type Contact } from "./contacts.ts";
import { COMMON_HELP, describeEvent, describeModel, describeReplyEvent, log, runSharedCommand } from "./console.ts";
import { FakeModel } from "./model/fake.ts";
import { createModel, type ModelSettings } from "./model/providers.ts";
import type { ChatModel } from "./model/provider.ts";
import { Store } from "./storage/store.ts";
import { acquireLock } from "./lock.ts";

/** Where the chat name was saved before data/contacts.json; read once to migrate. */
const LEGACY_CHAT_SETTING = "wechat_chat";
const PROACTIVE_SETTING = "proactive_enabled";

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
    case "send_failed":
      return `发送失败：${e.message}`;
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
  if (!fake && "problem" in config.model) {
    console.error(`${config.model.problem}\n或用 --fake 测试。`);
    process.exit(1);
  }

  const lock = acquireLock(join(ROOT, "data/runner.lock"));
  if ("heldBy" in lock) {
    console.error(`小拜已经在运行了（进程 ${lock.heldBy}）。同时开两个会互相回复，停掉那个再开，或者 kill ${lock.heldBy}。`);
    process.exit(1);
  }
  process.on("exit", lock.release);

  const ui = new DesktopHelper();
  const store = Store.open(config.dbPath);
  // Who to answer comes from data/contacts.json, so 小拜 never starts answering
  // whichever chat happened to be open.
  const contactsPath = join(ROOT, "data/contacts.json");
  const fail = (message: string): never => {
    console.error(message);
    ui.close();
    store.close();
    process.exit(1);
  };
  let contacts: Contact[] | null = null;
  try {
    contacts = loadContacts(contactsPath);
  } catch (err) {
    fail((err as Error).message);
  }
  const requested = argValue(argv, "--chat");
  if (contacts && requested && !contacts.some((c) => c.names.some((name) => contactNamesMatch(name, requested, c.type === "group")))) {
    fail(`data/contacts.json 已经有了。要改名字或加名字，直接编辑这个文件（格式见 contacts.example.json），然后重启。`);
  }
  const groupChat = contacts?.[0]?.type === "group";
  const first = contacts ? null : (requested ?? store.getSetting(LEGACY_CHAT_SETTING));

  let open: { chat: string; rows?: string[]; offset?: number | null } = { chat: "" };
  try {
    open = await ui.snapshot(contacts?.flatMap((contact) => contact.names), groupChat);
  } catch (err) {
    // An existing contact can wait for its chat to be opened. First-time setup
    // must show the actual capture/permission error instead of hiding it behind
    // the generic "chat name doesn't match" message below.
    const canWaitForChat = Boolean(contacts) && err instanceof HelperError && err.code === "no_open_chat";
    if (!canWaitForChat) {
      fail(`连不上微信：${(err as Error).message}`);
    }
  }

  if (contacts && open.chat && !contacts.some((contact) =>
    contact.names.some((name) => contactNamesMatch(name, open.chat, contact.type === "group"))
  )) {
    fail(`微信当前打开的是「${open.chat}」。小拜只连接已配置的聊天「${contacts.flatMap((contact) => contact.names).join("」「")}」。请先在微信中打开群聊后重新启动。`);
  }

  if (first) {
    // A typo here would leave 小拜 waiting for a chat that doesn't exist.
    if (requested && open.chat !== requested) {
      fail(
        open.chat
          ? `微信当前打开的是「${open.chat}」，和 --chat「${requested}」不一样。先点开要回复的聊天，名字照顶部写。`
          : `没读到微信里打开的聊天，没法确认「${requested}」写对了。先在 Mac 微信里点开这个聊天再运行。`,
      );
    }
    contacts = [{ id: "me", names: [first] }];
    saveContacts(contactsPath, contacts);
    log(`已创建 data/contacts.json：小拜只回复「${first}」。改名或加名字就编辑这个文件`);
  }

  if (!contacts) {
    fail(
      open.chat
        ? `还没设置聊天对象。微信当前打开的是「${open.chat}」；如要绑定这个聊天，运行：\n  npm run dearbyte -- --chat "${open.chat}"`
        : "还没设置聊天对象。先在 Mac 微信里点开和你的聊天，再运行 npm run dearbyte -- --chat <聊天名字>",
    );
  }
  // The current store is shared, so allow exactly one configured conversation type (direct or group).
  if (contacts!.length > 1) fail("data/contacts.json 里只能设置一个聊天（个人或群聊）；独立聊天记录和记忆暂不支持多个聊天");
  const names = contacts![0].names;

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
  const proactiveEnabled = () => !groupChat && store.getSetting(PROACTIVE_SETTING) !== "false";

  let photos: PhotoFolder | null = null;
  if (config.wechatMediaDir) {
    photos = new PhotoFolder(config.wechatMediaDir);
    photos.markExistingSeen();
  } else log("没有设置 COMPANION_WECHAT_MEDIA_DIR：收到图片时小拜会说看不到");

  // The filming log: a clean screen, then only the conversation and memories.
  const film = argv.includes("--film");
  if (film && process.stdout.isTTY) console.clear();

  const model: ChatModel = fake ? new FakeModel() : createModel(config.model as ModelSettings);
  const companion = new Companion({
    store,
    model,
    parts: loadPromptParts(ROOT),
    timeZone: config.timeZone,
    historyMessages: config.historyMessages,
    crisisCheck: !fake,
    onEvent: (e) => {
      const line = film ? filmCompanionLine(e, names[0]) : describeEvent(e);
      if (line) film ? console.log(line) : log(line);
    },
  });
  const watchdog = new Watchdog({ notify: systemNotifier(config.alertUrl, log) });
  const channel = new DesktopChannel({
    ui,
    companion,
    names,
    groupChat,
    initialSnapshot: open.rows ? { chat: open.chat, rows: open.rows, offset: open.offset } : undefined,
    photos,
    mode: argv.includes("--draft") ? "draft" : "auto",
    onEvent: (e) => {
      if (e.type === "send_failed") watchdog.sendFailed(e.message);
      const line = film ? filmChannelLine(e, names[0]) : describeDesktopEvent(e);
      if (!line) return;
      if (film || e.type === "inbound" || e.type === "sent" || e.type === "drafted") console.log(line);
      else log(line);
    },
  });

  const status = () =>
    film
      ? console.log(`💗 小拜 · DearByte   ${store.memoryEnabled() ? `记得 ${store.activeFacts().length} 件关于你的事` : ""}\n`)
      : log(
      `模型 ${describeModel(config.model, fake)}${fake ? "（假模型，会发出标明是假的回复）" : ""} · ${store.messageCount()} 条聊天记录 · ` +
        `长期记忆${store.memoryEnabled() ? `开启（${store.activeFacts().length} 条）` : "关闭"} · ` +
        `主动消息${proactiveEnabled() ? "开启" : "关闭"} · 时区 ${config.timeZone} · 微信${groupChat ? "群聊" : "聊天"}「${names.join("」「")}」· ${channel.mode === "draft" ? "草稿模式（不发送）" : channel.paused ? "已暂停" : "自动回复"}`,
    );
  status();

  const stop = new AbortController();
  const running = channel.run(stop.signal);

  let closing: Promise<void> | undefined;
  // Once a minute: should 小拜 write first? The plan's rules keep it rare.
  let ticking: Promise<void> | null = null;
  let retainedOn = "";
  const tick = async () => {
    const now = new Date();
    // Once a day (and at start): drop chat history past the retention window.
    if (retainedOn !== localDate(now, config.timeZone)) {
      retainedOn = localDate(now, config.timeZone);
      const pruned = applyRetention(store, config.historyDays, now);
      if (pruned) log(`删除了 ${pruned} 条超过 ${config.historyDays} 天的聊天记录（已并进摘要的部分）`);
    }
    if (!proactiveEnabled() || channel.mode === "draft") return;
    const state = dayState(readProactiveState(store), localDate(now, config.timeZone), Math.random);
    store.setSetting(PROACTIVE_STATE_SETTING, JSON.stringify(state));
    const plan = planProactive({
      now,
      timeZone: config.timeZone,
      state,
      history: store.recentMessages(config.historyMessages),
      facts: store.memoryEnabled() ? store.activeFacts() : [],
      crisisAt: store.getSetting(CRISIS_AT_SETTING),
    });
    if (!plan) return;
    const result = await channel.initiate(plan.key, () => companion.initiate(plan.note));
    store.setSetting(PROACTIVE_STATE_SETTING, JSON.stringify(recordAttempt(state, plan.key, result, now)));
  };
  const runTick = () => {
    if (ticking || closing) return;
    ticking = tick()
      .catch((err: Error) => log(`主动消息出错：${err.message}`))
      .finally(() => (ticking = null));
  };
  const ticker = setInterval(runTick, PROACTIVE_TICK_MS);
  runTick(); // retention at start; a proactive plan can't fire before the chat is in sync
  const watching = setInterval(() => watchdog.check(channel.health), 5_000);
  // Keep the Mac from idle-sleeping while 小拜 runs; ends with this process.
  // The display may still sleep: reading WeChat doesn't need it.
  spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
    .on("error", () => log("没能阻止 Mac 休眠（caffeinate 不可用）：请在系统设置里关掉自动休眠"))
    .unref();
  const shutdown = () =>
    (closing ??= (async () => {
      rl?.close();
      clearInterval(ticker);
      clearInterval(watching);
      channel.stopping = true; // type nothing more into WeChat
      stop.abort();
      await running;
      await ticking; // its state write must land before the store closes
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
    if (!film) log("没有交互终端，不接受命令；Ctrl+C 或 SIGTERM 退出");
    await running;
  } else {
    if (!film) log("输入 /help 查看命令，/quit 退出");
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
