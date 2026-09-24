// One runner per WeChat. Two runners each take the other's bubbles for the
// user's messages on WeChat 4.x, and answer each other without end.

import { openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";

/** Takes the lock, or returns the pid of the runner that holds it. A lock left by a dead process is taken over. */
export function acquireLock(path: string, pid = process.pid): { release: () => void } | { heldBy: number } {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            if (readFileSync(path, "utf8") === String(pid)) rmSync(path);
          } catch {}
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(readFileSync(path, "utf8"));
      if (holder && holder !== pid && alive(holder)) return { heldBy: holder };
      rmSync(path, { force: true });
    }
  }
  throw new Error(`拿不到运行锁：${path}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
