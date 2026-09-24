import { z } from "zod";

export const MAX_BUBBLES = 4;
export const MAX_BUBBLE_CHARS = 120;

const codePoints = (s: string) => [...s].length;

export const ReplySchema = z.object({
  bubbles: z
    .array(
      z
        .string()
        .trim()
        .min(1, "empty bubble")
        .refine((s) => codePoints(s) <= MAX_BUBBLE_CHARS, `bubble over ${MAX_BUBBLE_CHARS} chars`),
    )
    .min(1, "no bubbles")
    .max(MAX_BUBBLES, `more than ${MAX_BUBBLES} bubbles`),
});

export type Reply = z.infer<typeof ReplySchema>;

export type ParseResult =
  | { ok: true; reply: Reply }
  | { ok: false; problems: string[]; salvage: Reply | null };

/**
 * Validates model output against the reply contract. On failure, `salvage` is
 * the best compliant reply recoverable from it (clipped), if any.
 */
export function parseReply(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ["not valid JSON"], salvage: null };
  }
  const result = ReplySchema.safeParse(json);
  if (result.success) return { ok: true, reply: result.data };

  const problems = result.error.issues.map((i) => [i.path.join("."), i.message].filter(Boolean).join(": "));
  const bubbles = (json as { bubbles?: unknown })?.bubbles;
  const strings = Array.isArray(bubbles)
    ? bubbles.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    : [];
  const salvage = strings.length
    ? { bubbles: strings.slice(0, MAX_BUBBLES).map((b) => [...b.trim()].slice(0, MAX_BUBBLE_CHARS).join("")) }
    : null;
  return { ok: false, problems, salvage };
}

export const FALLBACK_REPLY: Reply = { bubbles: ["我刚刚脑子卡了一下", "你再说一遍？"] };
