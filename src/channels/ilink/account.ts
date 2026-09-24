// The WeChat login: bot token plus the one user allowed to talk to 小拜.
// Kept in data/ (gitignored), readable only by the current OS user.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";

const AccountSchema = z.object({
  botToken: z.string().min(1),
  botId: z.string().min(1),
  baseUrl: z.string().url(),
  /** ilink_user_id of the person who scanned the QR code. */
  ownerId: z.string().min(1),
  savedAt: z.string(),
});

export type Account = z.infer<typeof AccountSchema>;

export class AccountFileError extends Error {}

/** Returns null when there is no saved login; throws if the file is unusable. */
export function loadAccount(path: string): Account | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new AccountFileError(`${path} 不是有效的 JSON`);
  }
  const parsed = AccountSchema.safeParse(data);
  if (!parsed.success) throw new AccountFileError(`${path} 缺少字段或格式不对：${parsed.error.issues.map((i) => i.path.join(".")).join("、")}`);
  return parsed.data;
}

/** Writes a new 0600 file and renames it into place, so the token is never readable by others. */
export function saveAccount(path: string, account: Account): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(account, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

export function deleteAccount(path: string): void {
  rmSync(path, { force: true });
}
