// Terminal simulator: you play the WeChat user, 小拜 replies through the real
// pipeline (model, SQLite history, long-term memory). No WeChat connection.
//
//   npm run companion              # DeepSeek, key from .env
//   npm run companion -- --fake    # no API calls; replies are labelled fake

import { createInterface } from "node:readline/promises";
import { Companion } from "./companion/companion.ts";
import { COMMON_HELP, describeEvent, dim, log, runSharedCommand, sleep } from "./console.ts";
import { loadPromptParts } from "./companion/prompt.ts";
import { loadConfig, ROOT } from "./config.ts";
import { ImageError, loadImage, parseImageArgs } from "./media/images.ts";
import { DeepSeekModel } from "./model/deepseek.ts";
import { FakeModel } from "./model/fake.ts";
import type { ChatModel } from "./model/provider.ts";
import { Store } from "./storage/store.ts";

const HELP = `命令：
  直接输入文字          以用户身份发消息
  /img <路径> [配文]    发一张图片（JPEG / PNG / WebP / HEIC，可直接拖进终端）
${COMMON_HELP}`;

async function main() {
  const config = loadConfig();
  const fake = process.argv.includes("--fake");
  if (!fake && !config.apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY（写在 .env 里），或用 --fake 离线运行。");
    process.exit(1);
  }
  // While bubbles are printing, event lines are held so they don't interleave.
  let held: string[] | null = null;
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
      if (line) held ? held.push(line) : log(line);
    },
  });

  const status = () =>
    log(
      `模型 ${model.name}${fake ? "（假模型，不是真实回复）" : ""} · 数据库 ${config.dbPath.replace(ROOT, "")} · ` +
        `${store.messageCount()} 条聊天记录 · 长期记忆${store.memoryEnabled() ? `开启（${store.activeFacts().length} 条）` : "关闭"} · 渠道：终端模拟（未连接微信）`,
    );
  status();
  console.log(dim("输入 /help 查看命令\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pending: Promise<unknown>[] = [];
  const shutdown = async () => {
    rl.close();
    await Promise.allSettled(pending);
    store.close();
  };
  rl.on("SIGINT", () => void shutdown().then(() => process.exit(0)));

  const send = async (text: string, imagePath?: string) => {
    let image;
    if (imagePath) {
      try {
        image = loadImage(imagePath);
      } catch (err) {
        if (err instanceof ImageError) return log(err.message);
        throw err;
      }
    }
    try {
      const turn = await companion.handle({ text, image });
      held = [];
      for (const [i, bubble] of turn.reply.bubbles.entries()) {
        if (i > 0) await sleep(700 + Math.random() * 800);
        console.log(`小拜 › ${bubble}`);
      }
      const lines: string[] = held;
      held = null;
      lines.forEach((line) => log(line));
      pending.push(turn.memory);
    } catch (err) {
      log(`出错了，这条消息没有回复：${(err as Error).message}`);
    }
  };

  // Async iteration buffers lines that arrive while a reply is generating
  // (question() would drop them), so pasted or piped input is handled in order.
  rl.setPrompt("你 › ");
  const prompt = () => process.stdin.isTTY && rl.prompt();
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (!process.stdin.isTTY) console.log(`你 › ${line}`);

    const command = line.split(/\s+/)[0];
    if (command === "/quit") break;
    else if (command === "/help") console.log(HELP);
    else if (command === "/status") status();
    else if (command === "/img") {
      const { path, caption } = parseImageArgs(line.slice("/img".length));
      if (!path) log("用法：/img <路径> [配文]（可以直接把图片拖进终端）");
      else await send(caption, path);
    } else if (!command.startsWith("/")) await send(line);
    else if (!(await runSharedCommand(line, { store, timeZone: config.timeZone, settle: () => Promise.allSettled(pending) }))) {
      log(`未知命令 ${command}，输入 /help 查看`);
    }
    prompt();
  }
  await shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
