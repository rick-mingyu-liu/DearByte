// A rough "does this read like an AI?" check for replies. Used by the
// bake-off to compare persona changes; never shown to the user.
// The patterns follow zhichi's AI-tone probe (MIT), extended for 小拜.

/** Bubbles longer than this rarely appear in real WeChat chats. */
export const LONG_BUBBLE_CHARS = 25;

const PATTERNS: [label: string, pattern: RegExp][] = [
  ["列表", /^\s*(\d+[.、)）]|[-•*]\s)|首先|其次|第一[，,、]|最后[，,]/],
  ["客服腔", /建议你|希望(能|对你)?(帮到|有帮助)|记得要|最重要的是|如果你需要|随时(找我|告诉我|来聊)|我(可以|能)帮你/],
  ["书面语", /然而|因此|此外|总之|综上|与此同时|不仅.{0,12}而且|值得一提/],
  ["Markdown", /\*\*|^#+\s/],
  ["提到自己是AI", /代码|程序|进程|待机|服务器|算法|数据库|人工智能|\bAI\b|模型|内存/],
  ["翻译腔", /翻译过来|换句话说|也就是说|这意味着/],
  ["描述腔", /看着像|看起来像|画面里|图里|照片里|可以看到/],
];

export type ToneReport = {
  bubbles: number;
  avgChars: number;
  longBubbles: number;
  /** Bubbles ending in 。 — people mostly don't. */
  periods: number;
  flags: string[];
  /** Lower is more human. One point per flag hit, long bubble or period. */
  score: number;
};

const chars = (s: string) => [...s].length;

export function toneReport(bubbles: string[]): ToneReport {
  const flags: string[] = [];
  for (const [label, pattern] of PATTERNS) {
    const hits = bubbles.filter((b) => pattern.test(b)).length;
    if (hits) flags.push(hits > 1 ? `${label}×${hits}` : label);
  }
  const longBubbles = bubbles.filter((b) => chars(b) > LONG_BUBBLE_CHARS).length;
  const periods = bubbles.filter((b) => b.trim().endsWith("。")).length;
  const flagHits = PATTERNS.reduce((n, [, p]) => n + bubbles.filter((b) => p.test(b)).length, 0);
  return {
    bubbles: bubbles.length,
    avgChars: bubbles.length ? Math.round(bubbles.reduce((n, b) => n + chars(b), 0) / bubbles.length) : 0,
    longBubbles,
    periods,
    flags,
    score: flagHits + longBubbles + periods,
  };
}
