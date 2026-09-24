import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { acquireLock } from "../src/lock.ts";

test("a second runner can't start while the first holds the lock", () => {
  const path = join(mkdtempSync(join(tmpdir(), "lock-")), "runner.lock");
  const first = acquireLock(path);
  expect(first).toHaveProperty("release");
  expect(acquireLock(path, 999_999)).toEqual({ heldBy: process.pid });
  (first as { release: () => void }).release();
  expect(acquireLock(path, 999_999)).toHaveProperty("release");
});

test("a lock left by a dead runner is taken over", () => {
  const path = join(mkdtempSync(join(tmpdir(), "lock-")), "runner.lock");
  writeFileSync(path, "2147483646"); // no such process
  expect(acquireLock(path)).toHaveProperty("release");
});
