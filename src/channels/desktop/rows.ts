// Reads WeChat for Mac's message rows, as exposed by Accessibility.
// Observed on WeChat 3.8.4 with the English UI:
//   "AlexSaid:看看这张照片"      incoming text
//   "Alex:Sent aPhoto"          incoming photo
//   "MeSaid:hi"                 sent by this account (小拜)
//   "00:03", "Yesterday 23:51"  time labels
// The sender is the contact's own nickname ("Alex"), not the chat title, which
// can be a remark ("张三"). The bound chat is one-to-one, so anyone who isn't
// "Me" is the user; a group chat would need the sender kept.
//
// WeChat 4.x (observed on 4.1.13) no longer says who sent a row. The helper
// passes message rows as "Bubble:<text>", time labels as they are, and rows
// scrolled out of view as "". The channel tells 小拜's own bubbles apart by
// matching them with what it just sent.

export type Row =
  | { kind: "text"; sender: string; text: string }
  | { kind: "photo"; sender: string }
  /** Something else from the user: sticker, voice, file, … (label as WeChat shows it). */
  | { kind: "other"; sender: string; label: string }
  | { kind: "mine" }
  /** WeChat 4.x: a message from either side; the channel works out which. */
  | { kind: "bubble"; text: string }
  /** Time labels and blank rows. */
  | { kind: "meta" }
  /** Anything we don't recognise, e.g. WeChat switched to the Chinese UI. */
  | { kind: "unknown" };

const TIME_LABEL = /^(\d{1,2}:\d{2}|(Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2}:\d{2}|\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2})$/;

export function parseRow(title: string): Row {
  if (title.startsWith("Bubble:")) return { kind: "bubble", text: title.slice("Bubble:".length) };
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
 * How the new snapshot lines up with the previous one: the number of rows
 * dropped from the top, or null if they don't line up (the chat was scrolled,
 * switched, reloaded or read badly).
 *
 * The table may drop old rows from the top as new ones arrive, and a row can
 * change in place while it loads (a photo, a time label). So we try each
 * number of dropped rows and keep the alignment where the most positions
 * match; it must match at least half the overlap. Repeated identical messages
 * stay distinct because positions, not texts, are compared.
 */
export function alignRows(previous: string[], next: string[], known?: number): number | null {
  // An empty chat that gains a few rows is real; an empty read of a full chat isn't.
  if (!previous.length) return next.length <= 3 ? 0 : null;
  if (!next.length) return null;
  if (known !== undefined) return confirmAlignment(previous, next, known);
  let best = { dropped: -1, score: 0 };
  for (let dropped = 0; dropped < Math.min(previous.length, MAX_DROPPED + 1); dropped++) {
    const overlap = Math.min(previous.length - dropped, next.length);
    let score = 0;
    for (let i = 0; i < overlap; i++) if (previous[dropped + i] === next[i]) score++;
    if (score > best.score && score * 2 >= overlap) best = { dropped, score };
  }
  return best.dropped < 0 ? null : best.dropped;
}

/**
 * WeChat 4.x says how far its row window moved, so there's nothing to guess;
 * only check the rows agree. Guessing would go wrong there: most rows are
 * blank placeholders, and blank-matches-blank outscores the true shift once a
 * few messages arrive together, which silently skipped them.
 */
function confirmAlignment(previous: string[], next: string[], dropped: number): number | null {
  if (dropped < 0 || dropped >= previous.length) return null; // the list was rebuilt, or moved past everything we saw
  const overlap = Math.min(previous.length - dropped, next.length);
  let both = 0;
  let same = 0;
  for (let i = 0; i < overlap; i++) {
    const [a, b] = [previous[dropped + i], next[i]];
    if (!a || !b) continue; // placeholders say nothing
    both++;
    if (a === b) same++;
  }
  return same * 2 >= both ? dropped : null;
}

/**
 * Rows that are new since the last snapshot, or null if the snapshots don't
 * line up. A changed row counts as new only if `wasPending(oldTitle)` says its
 * old value was a placeholder, so a message already there is never answered twice.
 */
export function newRows(
  previous: string[],
  next: string[],
  /** `fromEnd` is the row's distance from the newest row (0 = last). */
  wasPending: (title: string, fromEnd: number) => boolean = () => true,
  /** How far the window moved, when WeChat says (4.x). */
  known?: number,
): string[] | null {
  const dropped = alignRows(previous, next, known);
  if (dropped === null) return null;
  const overlap = Math.min(previous.length - dropped, next.length);
  const changed = next
    .slice(0, overlap)
    .filter((row, i) => row !== previous[dropped + i] && wasPending(previous[dropped + i], next.length - 1 - i));
  return [...changed, ...next.slice(overlap)];
}

/**
 * The rows to remember for the next diff. A row that reads blank this time
 * (a partial Accessibility read) keeps its previous text, so when it reads
 * properly again it isn't mistaken for a new message.
 */
export function rememberRows(previous: string[], next: string[], known?: number): string[] {
  const dropped = alignRows(previous, next, known);
  if (dropped === null) return next;
  return next.map((row, i) => (row === "" && previous[dropped + i] !== undefined ? previous[dropped + i] : row));
}

/**
 * Bubble text reduced to what survives WeChat's display: no spaces, and no
 * emoji codes like [白眼], which 4.x may draw as pictures. Used to recognise
 * 小拜's own bubbles.
 */
export function bubbleKey(text: string): string {
  return text.replace(/\[[^\[\]\s]{1,12}\]/g, "").replace(/\s+/g, "");
}

/** A 4.x bubble that's really a placeholder for something that isn't text. */
export function bubbleLabel(text: string): string | null {
  // A received photo reads "Image" (observed on 4.1.13); the others are guesses in the same style.
  const m = /^\[?(Photo|Image|Picture|图片|照片|Sticker|Animated Sticker|动画表情|表情|Voice|语音|Video|视频|File|文件)\]?$/i.exec(text.trim());
  return m ? m[1] : null;
}

/** How an unfamiliar item is described to 小拜 so it answers honestly. */
export function describeOther(label: string): string {
  if (/voice|语音/i.test(label)) return "（用户发了一条语音，你听不到内容）";
  if (/photo|image|picture|图片|照片/i.test(label)) return "（用户发了一张图，你现在看不到图）";
  if (/sticker|表情/i.test(label)) return "（用户发了一个表情包，你看不清是什么）";
  if (/video|视频/i.test(label)) return "（用户发了一个视频，你看不了视频）";
  if (/file|文件/i.test(label)) return "（用户发了一个文件，你打不开文件）";
  return `（用户发了你看不到的内容：${label}）`;
}
