// Terminal simulator: you play the WeChat user, 小拜 replies through the real
// pipeline (model, SQLite history, long-term memory). No WeChat connection.
//
//   npm run companion              # DeepSeek, key from .env
//   npm run companion -- --fake    # no API calls; replies are labelled fake

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Companion, type CompanionEvent } from "./companion/companion.ts";
import { loadPromptParts } from "./companion/prompt.ts";
import { localDate } from "./companion/time.ts";
import { loadConfig, ROOT } from "./config.ts";
import { ImageError, loadImage, parseImageArgs } from "./media/images.ts";
import { DeepSeekModel } from "./model/deepseek.ts";
import { FakeModel } from "./model/fake.ts";
import type { ChatModel } from "./model/provider.ts";
import { Store } from "./storage/store.ts";

const HELP = `命令：
  直接输入文字          以用户身份发消息
  /img <路径> [配文]    发一张图片（JPEG / PNG / WebP / HEIC，可直接拖进终端）
  /memory               列出记得的事
  /memory on | off      开启 / 关闭长期记忆
  /memory forget <id>   删除一条记忆
  /memory export        导出记忆到 data/memory-export.md
  /history clear        清空聊天记录（记忆保留）
  /status               当前状态
  /help                 显示帮助
  /quit                 退出`;

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const time = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const log = (s: string) => console.log(dim(`${time()}  ${s}`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeEvent(e: CompanionEvent): string | null {
  switch (e.type) {
    case "context":
      return `上下文 · ${e.historyMessages} 条历史 · 记忆${e.memoryEnabled ? ` ${e.facts} 条` : "关闭"}${e.image ? " · 含图片" : ""}${e.crisis ? " · 安全模式" : ""}`;
    case "model": {
      const cost = e.cost === null ? "" : ` · $${e.cost.toFixed(5)}`;
      const label = { reply: "生成回复", repair: "修正格式", memory: "整理记忆" }[e.purpose];
      return `${label} · ${(e.ms / 1000).toFixed(1)}s · ${e.promptTokens} 入（${e.cacheHitTokens} 缓存）/ ${e.completionTokens} 出${cost}`;
    }
    case "reply_invalid":
      return `回复格式不合规（${e.problems.join("；")}）→ ${{ repair: "重试一次", salvage: "截断使用", fallback: "使用兜底回复" }[e.action]}`;
    case "memory": {
      const changed = e.outcome.results.filter((r) => r.result === "inserted" || r.result === "updated");
      const parts = [
        ...changed.map((r) => `${r.result === "inserted" ? "+" : "~"} ${r.value}`),
        ...e.outcome.results.filter((r) => r.result === "blocked").map((r) => `已删除的 ${r.key} 不再记录`),
        ...e.outcome.rejected.map((r) => `拒绝 ${r.key}：${r.reason}`),
      ];
      return parts.length ? `记忆 · ${parts.join(" · ")}` : null;
    }
    case "memory_error":
      return `记忆整理失败（不影响回复）：${e.message}`;
  }
}

function exportMemory(store: Store, timeZone: string): string {
  const facts = store.activeFacts();
  const lines = [
    "# 小拜记得的事",
    "",
    `导出于 ${localDate(new Date(), timeZone)} · 共 ${facts.length} 条`,
    "",
    ...facts.map(
      (f) => `- **${f.value}**${f.eventDate ? `（${f.eventDate}）` : ""}\n  - 原话：「${f.evidence}」 · ${f.category} · #${f.id}`,
    ),
  ];
  const path = join(ROOT, "data/memory-export.md");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

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

    const [command, ...args] = line.split(/\s+/);
    if (command === "/quit") break;
    else if (command === "/help") console.log(HELP);
    else if (command === "/status") status();
    else if (command === "/img") {
      const { path, caption } = parseImageArgs(line.slice("/img".length));
      if (!path) log("用法：/img <路径> [配文]（可以直接把图片拖进终端）");
      else await send(caption, path);
    } else if (command === "/memory") {
      await Promise.allSettled(pending); // show facts from the latest turn too
      const [sub, arg] = args;
      if (!sub) {
        const facts = store.activeFacts();
        if (!store.memoryEnabled()) log("长期记忆已关闭（/memory on 开启）");
        if (!facts.length) log("还没有记住任何事");
        for (const f of facts) console.log(`  #${f.id}  ${f.value}${f.eventDate ? `（${f.eventDate}）` : ""}  ${dim(`「${f.evidence}」`)}`);
      } else if (sub === "on" || sub === "off") {
        store.setMemoryEnabled(sub === "on");
        log(sub === "on" ? "长期记忆已开启：之后的消息里值得记的事会被记下" : "长期记忆已关闭：已有记忆保留但不再使用，也不再新增");
      } else if (sub === "forget") {
        log(store.forgetFact(Number(arg)) ? `已删除 #${arg}，之前的消息不会让它再被记起` : `没有找到 #${arg}`);
      } else if (sub === "export") {
        log(`已导出到 ${exportMemory(store, config.timeZone).replace(ROOT, "")}`);
      } else log("用法：/memory [on|off|forget <id>|export]");
    } else if (command === "/history" && args[0] === "clear") {
      log(`已清空 ${store.clearHistory()} 条聊天记录。长期记忆不受影响，需要的话用 /memory forget 删除。已发出的微信消息不会被撤回。`);
    } else if (command.startsWith("/")) log(`未知命令 ${command}，输入 /help 查看`);
    else await send(line);
    prompt();
  }
  await shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
