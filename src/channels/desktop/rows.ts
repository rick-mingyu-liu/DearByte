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
  | { kind: "text"; sender: string; text: string }
  | { kind: "photo"; sender: string }
  /** Something else from the user: sticker, voice, file, … (label as WeChat shows it). */
  | { kind: "other"; sender: string; label: string }
  | { kind: "mine" }
  /** Time labels and blank rows. */
  | { kind: "meta" }
  /** Anything we don't recognise, e.g. WeChat switched to the Chinese UI. */
  | { kind: "unknown" };

const TIME_LABEL = /^(\d{1,2}:\d{2}|(Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2}:\d{2}|\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2})$/;

export function parseRow(title: string): Row {
  if (title.startsWith("MeSaid:") || title.startsWith("Me:")) return { kind: "mine" };
  const said = /^(.+?)Said:([\s\S]*)$/.exec(title);
  if (said) return { kind: "text", sender: said[1], text: said[2] };
  const sent = /^(.+?):(Sent [\s\S]*)$/.exec(title);
  if (sent) {
    return /photo|image|picture|图片/i.test(sent[2])
      ? { kind: "photo", sender: sent[1] }
      : { kind: "other", sender: sent[1], label: sent[2] };
  }
  if (!title.trim() || TIME_LABEL.test(title)) return { kind: "meta" };
  return { kind: "unknown" };
}

/** How far down the table rows may have scrolled off the top between two polls. */
const MAX_DROPPED = 50;

/**
 * Rows that are new since the last snapshot, or null if the two snapshots
 * don't line up (the chat was scrolled, switched, reloaded or read badly).
 *
 * The table may drop old rows from the top as new ones arrive, and a row can
 * change in place while it loads (a photo, a time label). So we try each
 * number of rows dropped from the top and keep the alignment where the most
 * positions match; it must match at least half the overlap. Repeated identical
 * messages stay distinct because positions, not texts, are compared.
 *
 * A changed row counts as new only if `wasPending(oldTitle)` says its old value
 * was a placeholder. A message that was already there is never answered twice.
 */
export function newRows(previous: string[], next: string[], wasPending: (title: string) => boolean = () => true): string[] | null {
  // An empty chat that gains a few rows is real; an empty read of a full chat isn't.
  if (!previous.length) return next.length <= 3 ? next : null;
  if (!next.length) return null;
  let best = { dropped: -1, score: 0 };
  for (let dropped = 0; dropped < Math.min(previous.length, MAX_DROPPED + 1); dropped++) {
    const overlap = Math.min(previous.length - dropped, next.length);
    let score = 0;
    for (let i = 0; i < overlap; i++) if (previous[dropped + i] === next[i]) score++;
    if (score > best.score && score * 2 >= overlap) best = { dropped, score };
  }
  if (best.dropped < 0) return null;
  const overlap = Math.min(previous.length - best.dropped, next.length);
  const changed = next.slice(0, overlap).filter((row, i) => row !== previous[best.dropped + i] && wasPending(previous[best.dropped + i]));
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
