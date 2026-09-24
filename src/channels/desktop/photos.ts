// Finds the full-size copy of a received photo. WeChat for Mac 3.8.4 saves
// each received image as an unencrypted JPEG in the logged-in account's folder:
//   <account>/Message/MessageTemp/<chat>/Image/<id>_.pic.jpg   (plus _.pic_thumb.jpg)
// We only ever read the one folder configured for 小拜's chat.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SOURCE_BYTES } from "../../media/images.ts";

const WAIT_MS = 15_000;
const POLL_MS = 500;

export class PhotoFolder {
  private readonly claimed = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ) {}

  /**
   * Unclaimed photos saved at or after `notBefore`, oldest first: full-size
   * `*.pic.jpg`, or thumbnails `*.pic_thumb.jpg` when `thumbs` is set.
   *
   * A photo sent again reuses the old file through a hard link, which keeps
   * the old mtime but gets a new ctime, so the later of the two counts.
   */
  private candidates(notBefore: number, thumbs = false): { name: string; mtime: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const files: { name: string; mtime: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(thumbs ? ".pic_thumb.jpg" : ".pic.jpg") || this.claimed.has(name)) continue;
      try {
        const stat = lstatSync(join(this.dir, name));
        // Regular files only (no symlinks out of the folder), and nothing absurdly large.
        const saved = Math.max(stat.mtimeMs, stat.ctimeMs);
        if (stat.isFile() && stat.size <= MAX_SOURCE_BYTES && saved >= notBefore) files.push({ name, mtime: saved });
      } catch {
        // Renamed or removed between listing and stat.
      }
    }
    return files.sort((a, b) => a.mtime - b.mtime);
  }

  /** Photos already on disk now can never belong to a message we see later. */
  markExistingSeen(): void {
    for (const f of [...this.candidates(0), ...this.candidates(0, true)]) this.claimed.add(f.name);
  }

  /**
   * Waits for the `count` photos of a burst, saved at or after `seenAt` (minus
   * a little slack, since WeChat can save the file before the row appears).
   * All of them are claimed so none is mistaken for a later photo; the newest
   * is returned. If fewer arrive in time, the newest of those is returned.
   */
  async claim(seenAt: number, count = 1): Promise<Uint8Array> {
    const sleep = this.opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? Date.now;
    const deadline = now() + WAIT_MS;
    for (;;) {
      const found = this.candidates(seenAt - 60_000).slice(0, count);
      if (found.length >= count || (found.length && now() >= deadline)) {
        for (const f of found) {
          this.claimed.add(f.name);
          this.claimed.add(f.name.replace(/\.pic\.jpg$/, ".pic_thumb.jpg"));
        }
        return new Uint8Array(readFileSync(join(this.dir, found.at(-1)!.name)));
      }
      if (now() >= deadline) {
        // No full-size file in time (WeChat may only fetch it on demand): a
        // small thumbnail is still better than nothing.
        const thumbs = this.candidates(seenAt - 60_000, true).slice(0, count);
        if (!thumbs.length) throw new Error("微信还没把这张图存到本地");
        for (const f of thumbs) this.claimed.add(f.name);
        return new Uint8Array(readFileSync(join(this.dir, thumbs.at(-1)!.name)));
      }
      await sleep(POLL_MS);
    }
  }
}
