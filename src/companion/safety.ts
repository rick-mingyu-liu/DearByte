// Deliberately broad keyword check: a false positive only makes one reply
// gentler, a false negative misses a crisis. It's the floor; a model check
// (crisis-check.ts) catches what these miss.
const CRISIS_PATTERNS = [
  // 「想死你了」「想死我了」 mean "missed you so much", common in a chat full of pet names.
  /想死(?!你|我了|了你)|不想活|活不下去|撑不下去|自杀|轻生|结束(自己的)?生命|了结自己|消失了?也挺好|不如消失|离开这个世界/,
  /割腕|跳楼|跳河|安眠药|吞药|烧炭|伤害自己|自残|自伤/,
  /家暴|被打|打我了|动手打|掐我|掐脖子|不让我出门|关着我|跟踪我|威胁我|要杀了?我/,
  /裸照|私密照|强迫我|逼我发生/,
];

export function looksLikeCrisis(text: string): boolean {
  return CRISIS_PATTERNS.some((p) => p.test(text));
}
