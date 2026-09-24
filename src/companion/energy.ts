// How much energy the user's message carries, so 小拜 answers in kind: a flat
// 「嗯」 gets one short bubble, a long or excited message may get two.

export type Energy = "low" | "mid" | "high";

/** Exclamations, double question marks, laughter, emojis and WeChat emoji codes. */
const EXCITED = /[!！]|[?？]{2}|哈哈哈|啊啊|嘿嘿|\p{Extended_Pictographic}|\[[^\]\s]{1,4}\]/u;

export function userEnergy(input: { text: string; image?: boolean }): Energy {
  if (input.image) return "high";
  const chars = [...input.text.replace(/\s/g, "")].length;
  const excited = EXCITED.test(input.text);
  if (chars > 25 || (excited && chars > 8)) return "high";
  if (chars <= 8 && !excited) return "low";
  return "mid";
}

/** The per-turn instruction for how many bubbles to send; none when two are fine. */
export function bubbleHint(energy: Energy): string | null {
  switch (energy) {
    case "low":
      return "对方这条很短、很随意。这一轮只回 1 条，短一点，但要带点温度（在乎、亲昵、撒个娇都行），别只做冷静的点评。";
    case "mid":
      return "这一轮回 1 条，要带点温度。只有真有两件不同的事要说（比如一个反应加一句贴心的话），才用 2 条。";
    case "high":
      return null;
  }
}

/** A Unicode emoji or a WeChat emoji code such as [捂脸]. */
const EMOJI = /\p{Extended_Pictographic}|\[[^\]\s]{1,4}\]/u;
/** After an emoji, this many of 小拜's replies go without one. */
const EMOJI_COOLDOWN = 2;

/** Whether one of 小拜's last replies had an emoji, so this one shouldn't. */
export function emojiRecently(history: { role: string; text: string }[]): boolean {
  return history
    .filter((m) => m.role === "assistant")
    .slice(-EMOJI_COOLDOWN)
    .some((m) => EMOJI.test(m.text));
}
