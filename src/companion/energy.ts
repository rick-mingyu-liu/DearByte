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
      return "对方这条很短、很随意。这一轮只回 1 条，也短一点。";
    case "mid":
      return "这一轮回 1 条。只有真有两件不同的事要说（比如一个反应加一个问题），才用 2 条。";
    case "high":
      return null;
  }
}
