import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DesktopChannel, type DesktopEvent, type Mode } from "../src/channels/desktop/channel.ts";
import { HelperError, type WechatUi } from "../src/channels/desktop/helper.ts";
import { PhotoFolder } from "../src/channels/desktop/photos.ts";
import { describeOther, newRows, parseRow } from "../src/channels/desktop/rows.ts";
import { mergeIncoming } from "../src/channels/reply-loop.ts";
import { Companion } from "../src/companion/companion.ts";
import { FALLBACK_REPLY } from "../src/companion/output.ts";
import { loadPromptParts } from "../src/companion/prompt.ts";
import { ROOT } from "../src/config.ts";
import { FakeModel } from "../src/model/fake.ts";
import { Store } from "../src/storage/store.ts";

const CHAT = "张三";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const reply = (...bubbles: string[]) => JSON.stringify({ bubbles });
/** Rows name the sender by nickname, which differs from the chat's remark name. */
const SENDER = "Alex";
const said = (t: string) => `${SENDER}Said:${t}`;

// --- Rows ------------------------------------------------------------------

test("parses the row formats WeChat for Mac exposes", () => {
  expect(parseRow(said("看看这张照片"))).toEqual({ kind: "text", sender: SENDER, text: "看看这张照片" });
  expect(parseRow(said("a:b"))).toEqual({ kind: "text", sender: SENDER, text: "a:b" });
  expect(parseRow("张三Said:hi")).toEqual({ kind: "text", sender: "张三", text: "hi" });
  expect(parseRow(`${SENDER}:Sent aPhoto`)).toEqual({ kind: "photo", sender: SENDER });
  expect(parseRow(`${SENDER}:Sent a Sticker`)).toEqual({ kind: "other", sender: SENDER, label: "Sent a Sticker" });
  expect(parseRow("MeSaid:hi")).toEqual({ kind: "mine" });
  expect(parseRow("MeSaid:AlexSaid:x")).toEqual({ kind: "mine" });
  expect(parseRow("Yesterday 23:51")).toEqual({ kind: "meta" });
  expect(parseRow("01:34")).toEqual({ kind: "meta" });
  expect(parseRow("")).toEqual({ kind: "meta" });
  expect(parseRow("张三说：你好")).toEqual({ kind: "unknown" }); // e.g. the Chinese UI
  expect(describeOther("Sent a Sticker")).toContain("表情包");
});

test("finds new rows, keeping repeated identical messages", () => {
  expect(newRows(["a", "b"], ["a", "b"])).toEqual([]);
  expect(newRows(["a", "b"], ["a", "b", "b"])).toEqual(["b"]);
  expect(newRows(["x", "a", "b"], ["a", "b", "c"])).toEqual(["c"]); // old row dropped from the top
  expect(newRows(["a", "b"], ["c", "d"])).toBeNull();
  expect(newRows([], ["a"])).toEqual(["a"]);
  // An empty read, or a full chat appearing after one, is not a list of new messages.
  expect(newRows(["a", "b"], [])).toBeNull();
  expect(newRows([], ["a", "b", "c", "d"])).toBeNull();
  // A row that changed in place counts only if its old value was a placeholder.
  expect(newRows(["a", "b"], ["a", "B"], (old) => old === "")).toEqual([]);
  // A row that changes while loading is reported once, alongside rows appended after it.
  expect(newRows(["a", "b", "loading"], ["a", "b", "photo", "c"])).toEqual(["photo", "c"]);
});

test("merges a burst: texts in order, latest photo, note for the rest", () => {
  const merged = mergeIncoming([
    { text: "看", image: null },
    { text: "", image: { seenAt: 1 } },
    { text: "", image: { seenAt: 2 } },
  ]);
  expect(merged).toEqual({ text: "看\n（用户还发了另外 1 张图，你只看到了最后一张）", image: { seenAt: 2 } });
});

// --- Photos ----------------------------------------------------------------

test("a burst of photos claims all of them and returns the newest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-photos-"));
  const folder = new PhotoFolder(dir, { sleep: async () => {} });
  const t = Date.now() / 1000;
  writeFileSync(join(dir, "1_.pic.jpg"), "first");
  utimesSync(join(dir, "1_.pic.jpg"), t - 2, t - 2);
  writeFileSync(join(dir, "2_.pic.jpg"), JPEG);
  expect(await folder.claim(Date.now(), 2)).toEqual(JPEG);
  let now = Date.now();
  const later = new PhotoFolder(dir, { sleep: async () => void (now += 20_000), now: () => now });
  later.markExistingSeen();
  await expect(later.claim(Date.now())).rejects.toThrow();
});

test("claims each new full-size photo once and ignores thumbnails and old files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-photos-"));
  const old = join(dir, "1_.pic.jpg");
  writeFileSync(old, "old");
  const folder = new PhotoFolder(dir, { sleep: async () => {} });
  folder.markExistingSeen();

  writeFileSync(join(dir, "2_.pic_thumb.jpg"), "thumb");
  writeFileSync(join(dir, "2_.pic.jpg"), JPEG);
  expect(await folder.claim(Date.now())).toEqual(JPEG);

  let t = 0;
  const empty = new PhotoFolder(dir, { sleep: async () => void (t += 20_000), now: () => t });
  empty.markExistingSeen();
  await expect(empty.claim(0)).rejects.toThrow("还没把这张图存到本地");
});

test("photos saved long before the row appeared are not matched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-photos-"));
  const file = join(dir, "9_.pic.jpg");
  writeFileSync(file, JPEG);
  utimesSync(file, new Date("2026-01-01"), new Date("2026-01-01"));
  let t = Date.now();
  const folder = new PhotoFolder(dir, { sleep: async () => void (t += 20_000), now: () => t });
  await expect(folder.claim(Date.now())).rejects.toThrow();
});

// --- Channel ---------------------------------------------------------------

function setup(opts: { responses?: ConstructorParameters<typeof FakeModel>[0]; mode?: Mode; sendErrors?: string[]; photos?: PhotoFolder } = {}) {
  const store = Store.open(":memory:");
  const model = new FakeModel(opts.responses ?? []);
  const companion = new Companion({ store, model, parts: loadPromptParts(ROOT), timeZone: "Asia/Shanghai", historyMessages: 40 });
  const sent: string[] = [];
  const errors = [...(opts.sendErrors ?? [])];
  const ui: WechatUi = {
    snapshot: async () => ({ chat: CHAT, rows: [], draft: false }),
    send: async (chat, text) => {
      expect(chat).toBe(CHAT);
      const code = errors.shift();
      if (code) throw new HelperError(code);
      sent.push(text);
    },
    close: () => {},
  };
  const events: DesktopEvent[] = [];
  const channel = new DesktopChannel({
    ui,
    companion,
    chat: CHAT,
    photos: opts.photos ?? null,
    mode: opts.mode ?? "auto",
    onEvent: (e) => events.push(e),
    sleep: async () => {},
  });
  return { store, model, channel, sent, events };
}

test("never answers what was already in the chat, then answers new messages", async () => {
  const { channel, sent, model } = setup({ responses: [reply("在呢", "咋了")] });
  const history = [said("旧消息"), "MeSaid:旧回复"];
  channel.poll({ chat: CHAT, rows: history });
  channel.poll({ chat: CHAT, rows: [...history, "01:30", said("在吗"), said("问你个事")] });
  await channel.settle();

  expect(model.calls).toHaveLength(1);
  expect(model.calls[0].messages.at(-1)?.content).toBe("在吗\n问你个事");
  expect(sent).toEqual(["在呢", "咋了"]);
});

test("its own replies showing up as rows don't trigger another reply", async () => {
  const { channel, model } = setup({ responses: [reply("好")] });
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("hi")] });
  await channel.settle();
  channel.poll({ chat: CHAT, rows: [said("hi"), "MeSaid:好"] });
  await channel.settle();
  expect(model.calls).toHaveLength(1);
});

test("waits while another chat is open and catches up when it is back", async () => {
  const { channel, sent, events } = setup({ responses: [reply("回来啦")] });
  channel.poll({ chat: CHAT, rows: [said("a")] });
  channel.poll({ chat: "文件传输助手", rows: ["x"] });
  expect(events.at(-1)).toMatchObject({ type: "status", message: expect.stringContaining("文件传输助手") });
  channel.poll({ chat: CHAT, rows: [said("a"), said("你去哪了")] });
  await channel.settle();
  expect(sent).toEqual(["回来啦"]);
});

test("passes the saved photo to the model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dearbyte-photos-"));
  const photos = new PhotoFolder(dir, { sleep: async () => {} });
  const { channel, model } = setup({ photos });
  channel.poll({ chat: CHAT, rows: [] });
  writeFileSync(join(dir, "5_.pic.jpg"), JPEG);
  channel.poll({ chat: CHAT, rows: [`${SENDER}:Sent aPhoto`, said("这是什么")] });
  await channel.settle();
  const content = model.calls[0].messages.at(-1)?.content;
  expect(Array.isArray(content) && content.some((p) => p.type === "image_url")).toBe(true);
});

test("without the photo folder, 小拜 is told it can't see the picture", async () => {
  const { channel, model, events } = setup();
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [`${SENDER}:Sent aPhoto`] });
  await channel.settle();
  expect(model.calls[0].messages.at(-1)?.content).toBe("（用户发了一张图，但图片没加载出来，你看不到）");
  expect(events.some((e) => e.type === "error")).toBe(true);
});

test("an empty read never makes it re-answer the chat", async () => {
  const { channel, model } = setup({ responses: [reply("好")] });
  const history = [said("旧的一"), "MeSaid:旧回复", said("旧的二"), said("旧的三")];
  channel.poll({ chat: CHAT, rows: history });
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: history });
  channel.poll({ chat: CHAT, rows: [...history, said("新的")] });
  await channel.settle();
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0].messages.at(-1)?.content).toBe("新的");
});

test("a message that changes in place is not answered twice", async () => {
  const { channel, model } = setup({ responses: [reply("好")] });
  channel.poll({ chat: CHAT, rows: ["01:00", said("在吗")] });
  channel.poll({ chat: CHAT, rows: ["01:00", said("在吗？")] });
  await channel.settle();
  expect(model.calls).toHaveLength(0);
});

test("a row that reads blank once is not answered again when it reads properly", async () => {
  const { channel, model } = setup({ responses: [reply("好")] });
  channel.poll({ chat: CHAT, rows: ["00:01", said("hi")] });
  channel.poll({ chat: CHAT, rows: ["00:01", ""] });
  channel.poll({ chat: CHAT, rows: ["00:01", said("hi")] });
  await channel.settle();
  expect(model.calls).toHaveLength(0);
});

test("resume lifts a group-chat pause for good", async () => {
  const { channel, model } = setup({ responses: [reply("好")] });
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("hi"), "Alex2Said:hello"] });
  expect(channel.paused).toBe(true);
  channel.resume();
  channel.poll({ chat: CHAT, rows: [said("hi"), "Alex2Said:hello", said("还在吗")] });
  await channel.settle();
  expect(channel.paused).toBe(false);
  expect(model.calls).toHaveLength(1);
});

test("a second sender means a group chat: it pauses instead of answering", async () => {
  const { channel, model, events } = setup();
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("hi"), "BobSaid:hello"] });
  await channel.settle();
  expect(model.calls).toHaveLength(0);
  expect(channel.paused).toBe(true);
  expect(events).toContainEqual({ type: "status", message: expect.stringContaining("群聊") });
});

test("reports a row it can't read instead of dropping it silently", () => {
  const { channel, events } = setup();
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: ["张三说：你好"] });
  expect(events).toContainEqual({ type: "status", message: expect.stringContaining("看不懂") });
});

test("after shutdown starts, nothing more is typed into WeChat", async () => {
  const { channel, sent } = setup({ responses: [reply("一", "二")] });
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("hi")] });
  channel.stopping = true;
  await channel.settle();
  expect(sent).toEqual([]);
});

test("draft mode shows replies without sending", async () => {
  const { channel, sent, events } = setup({ mode: "draft", responses: [reply("草稿")] });
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("hi")] });
  await channel.settle();
  expect(sent).toEqual([]);
  expect(events).toContainEqual({ type: "drafted", bubble: "草稿" });
});

test("paused: new messages are skipped, not queued for later", async () => {
  const { channel, model, events } = setup();
  channel.poll({ chat: CHAT, rows: [] });
  channel.paused = true;
  channel.poll({ chat: CHAT, rows: [said("在吗")] });
  channel.paused = false;
  channel.poll({ chat: CHAT, rows: [said("在吗")] });
  await channel.settle();
  expect(model.calls).toHaveLength(0);
  expect(events).toContainEqual({ type: "skipped", count: 1 });
});

test("waits out a draft in the composer, but never resends an unconfirmed bubble", async () => {
  const busy = setup({ responses: [reply("一")], sendErrors: ["composer_not_empty"] });
  busy.channel.poll({ chat: CHAT, rows: [] });
  busy.channel.poll({ chat: CHAT, rows: [said("hi")] });
  await busy.channel.settle();
  expect(busy.sent).toEqual(["一"]);

  const unsure = setup({ responses: [reply("一", "二")], sendErrors: ["unconfirmed"] });
  unsure.channel.poll({ chat: CHAT, rows: [] });
  unsure.channel.poll({ chat: CHAT, rows: [said("hi")] });
  await unsure.channel.settle();
  expect(unsure.sent).toEqual([]);
  expect(unsure.events.filter((e) => e.type === "error")).toHaveLength(2);
});

test("a message arriving mid-reply becomes the next turn", async () => {
  let channel!: DesktopChannel;
  const s = setup({
    responses: [
      () => {
        channel.poll({ chat: CHAT, rows: [said("先说这个"), said("还有这个")] });
        return reply("一");
      },
      reply("二"),
    ],
  });
  channel = s.channel;
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("先说这个")] });
  await channel.settle();
  expect(s.model.calls.map((c) => c.messages.at(-1)?.content)).toEqual(["先说这个", "还有这个"]);
  expect(s.sent).toEqual(["一", "二"]);
});

test("sends the fallback reply when the model call fails", async () => {
  const { channel, sent } = setup({
    responses: [
      () => {
        throw new Error("network down");
      },
    ],
  });
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("喂")] });
  await channel.settle();
  expect(sent).toEqual(FALLBACK_REPLY.bubbles);
});

test("settle waits for memory work started by the last turn", async () => {
  const { channel, store } = setup({
    responses: [reply("好"), JSON.stringify({ facts: [{ category: "event", key: "interview", value: "用户下周三面试", eventDate: null, evidence: "我下周三面试" }] })],
  });
  store.setMemoryEnabled(true);
  channel.poll({ chat: CHAT, rows: [] });
  channel.poll({ chat: CHAT, rows: [said("我下周三面试")] });
  await channel.settle();
  expect(store.activeFacts().map((f) => f.key)).toEqual(["interview"]);
});
