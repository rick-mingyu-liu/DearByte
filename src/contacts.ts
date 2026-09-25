// Who 小拜 talks to, kept in data/contacts.json (gitignored: it holds real
// names). contacts.example.json shows the format. Edit the file and restart to
// change it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const ContactSchema = z.object({
  /** Stable id; names can change. Reserved for per-contact history later. */
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  /** Direct messages remain the default; group chats must be explicitly allowed. */
  type: z.enum(["direct", "group"]).optional(),
  /** Every name WeChat may show for this chat: the remark, the nickname, old names. */
  names: z.array(z.string().trim().min(1)).min(1),
  note: z.string().optional(),
});

const FileSchema = z.object({ contacts: z.array(ContactSchema).min(1) });

export type Contact = z.infer<typeof ContactSchema>;

/** Normalize WeChat's title variants; group titles may add a trailing member count. */
export function contactNameKey(value: string, groupChat = false): string {
  const normalized = value.normalize("NFKC");
  const withoutMemberCount = groupChat ? normalized.replace(/\s*\(\s*\d+\s*\)\s*$/u, "") : normalized;
  return withoutMemberCount.toLocaleLowerCase().replace(/[\s\p{P}]+/gu, "");
}

export function contactNamesMatch(left: string, right: string, groupChat = false): boolean {
  return contactNameKey(left, groupChat) === contactNameKey(right, groupChat);
}

export function loadContacts(path: string): Contact[] | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} 不是合法的 JSON：${(err as Error).message}`);
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} 格式不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
  const contacts = parsed.data.contacts;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const c of contacts) {
    if (ids.has(c.id)) throw new Error(`${path} 里 id「${c.id}」重复了`);
    ids.add(c.id);
    for (const n of c.names) {
      if (names.has(n)) throw new Error(`${path} 里名字「${n}」出现在两个联系人里`);
      names.add(n);
    }
  }
  return contacts;
}

export function saveContacts(path: string, contacts: Contact[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ contacts }, null, 2) + "\n");
}
