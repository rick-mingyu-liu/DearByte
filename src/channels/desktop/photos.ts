// Finds the full-size copy of a received photo. WeChat for Mac 3.8.4 saves
// each received image as an unencrypted JPEG in the logged-in account's folder:
//   <account>/Message/MessageTemp/<chat>/Image/<id>_.pic.jpg   (plus _.pic_thumb.jpg)
// We only ever read the one folder configured for 小拜's chat.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WAIT_MS = 15_000;
const POLL_MS = 500;

export class PhotoFolder {
  private readonly claimed = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ) {}

  /** Full-size photos, oldest first. */
  private candidates(notBefore: number): { name: string; mtime: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".pic.jpg") && !this.claimed.has(n))
      .map((name) => ({ name, mtime: statSync(join(this.dir, name)).mtimeMs }))
      .filter((f) => f.mtime >= notBefore)
      .sort((a, b) => a.mtime - b.mtime);
  }

  /** Photos already on disk now can never belong to a message we see later. */
  markExistingSeen(): void {
    for (const f of this.candidates(0)) this.claimed.add(f.name);
  }

  /**
   * Waits for the next unclaimed photo saved at or after `seenAt` (minus a
   * little slack, since WeChat can save the file before the row appears).
   */
  async claim(seenAt: number): Promise<Uint8Array> {
    const sleep = this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? Date.now;
    const deadline = now() + WAIT_MS;
    for (;;) {
      const [next] = this.candidates(seenAt - 60_000);
      if (next) {
        this.claimed.add(next.name);
        return new Uint8Array(readFileSync(join(this.dir, next.name)));
      }
      if (now() >= deadline) throw new Error("微信还没把这张图存到本地");
      await sleep(POLL_MS);
    }
  }
}
