// Reads WeChat for Mac's message rows, as exposed by Accessibility.
// Observed on WeChat 3.8.4 with the English UI:
//   "AlexSaid:看看这张照片"      incoming text
//   "Alex:Sent aPhoto"          incoming photo
//   "MeSaid:hi"                 sent by this account (小拜)
//   "00:03", "Yesterday 23:51"  time labels
// The sender is the contact's own nickname ("Alex"), not the chat title, which
// can be a remark ("张三"). The bound chat is one-to-one, so anyone who isn't
// "Me" is the user; a group chat would need the sender kept.

export type Row =
  | { kind: "text"; text: string }
  | { kind: "photo" }
  /** Something else from the user: sticker, voice, file, … (label as WeChat shows it). */
  | { kind: "other"; label: string }
  | { kind: "mine" }
  | { kind: "meta" };

export function parseRow(title: string): Row {
  if (title.startsWith("MeSaid:") || title.startsWith("Me:")) return { kind: "mine" };
  const said = /^.+?Said:([\s\S]*)$/.exec(title);
  if (said) return { kind: "text", text: said[1] };
  const sent = /^.+?:(Sent [\s\S]*)$/.exec(title);
  if (sent) return /photo|image|picture|图片/i.test(sent[1]) ? { kind: "photo" } : { kind: "other", label: sent[1] };
  return { kind: "meta" };
}

/**
 * Rows that are new or changed since the last snapshot, or null if the two
 * snapshots don't line up (the chat was scrolled, switched or reloaded).
 *
 * The table may drop old rows from the top as new ones arrive, and a row can
 * change in place while it loads (a photo, a time label). So we try every
 * number of rows dropped from the top and keep the alignment where the most
 * positions match; it must match at least half the overlap. Repeated identical
 * messages stay distinct because positions, not texts, are compared.
 */
export function newRows(previous: string[], next: string[]): string[] | null {
  if (!previous.length) return next;
  let best = { dropped: -1, score: 0 };
  for (let dropped = 0; dropped < previous.length; dropped++) {
    const overlap = Math.min(previous.length - dropped, next.length);
    let score = 0;
    for (let i = 0; i < overlap; i++) if (previous[dropped + i] === next[i]) score++;
    if (score > best.score && score * 2 >= overlap) best = { dropped, score };
  }
  if (best.dropped < 0) return null;
  const overlap = previous.length - best.dropped;
  const changed = next.slice(0, overlap).filter((row, i) => row !== previous[best.dropped + i]);
  return [...changed, ...next.slice(overlap)];
}

/** How an unfamiliar item is described to 小拜 so it answers honestly. */
export function describeOther(label: string): string {
  if (/voice|语音/i.test(label)) return "（用户发了一条语音，你听不到内容）";
  if (/sticker|表情/i.test(label)) return "（用户发了一个表情包，你看不清是什么）";
  if (/video|视频/i.test(label)) return "（用户发了一个视频，你看不了视频）";
  if (/file|文件/i.test(label)) return "（用户发了一个文件，你打不开文件）";
  return `（用户发了你看不到的内容：${label}）`;
}
