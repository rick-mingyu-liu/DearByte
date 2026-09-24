import { expect, test } from "vitest";
import type { FactCandidate } from "../src/domain.ts";
import { Store } from "../src/storage/store.ts";

const ielts = (value = "用户在准备雅思考试", eventDate: string | null = "2026-10-03"): FactCandidate => ({
  category: "event",
  key: "ielts_exam",
  value,
  eventDate,
  evidence: "下周六考雅思",
});

test("messages come back oldest first and survive reopening", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "dearbyte-")), "c.sqlite");

  const store = Store.open(path);
  store.addMessage("user", "一");
  store.addMessage("assistant", "二", { bubbles: ["二"] });
  store.addMessage("user", "三", { hasImage: true });
  store.setMemoryEnabled(true);
  store.close();

  const reopened = Store.open(path);
  const recent = reopened.recentMessages(2);
  expect(recent.map((m) => m.text)).toEqual(["二", "三"]);
  expect(recent[0].bubbles).toEqual(["二"]);
  expect(recent[1].hasImage).toBe(true);
  expect(reopened.memoryEnabled()).toBe(true);
  reopened.close();
});

test("memory is off by default", () => {
  expect(Store.open(":memory:").memoryEnabled()).toBe(false);
});

test("upsert inserts, ignores repeats, and replaces by key", () => {
  const store = Store.open(":memory:");
  const msg = store.addMessage("user", "下周六考雅思");
  expect(store.upsertFact(ielts(), msg)).toBe("inserted");
  expect(store.upsertFact(ielts(), msg)).toBe("unchanged");
  expect(store.upsertFact(ielts("用户的雅思考试改期了", "2026-10-10"), msg)).toBe("updated");
  const facts = store.activeFacts();
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ value: "用户的雅思考试改期了", eventDate: "2026-10-10" });
});

test("a forgotten fact is wiped and cannot be revived by older messages", () => {
  const store = Store.open(":memory:");
  const old = store.addMessage("user", "下周六考雅思", { createdAt: "2026-09-20T10:00:00.000Z" });
  store.upsertFact(ielts(), old, "2026-09-20T10:00:01.000Z");
  const id = store.activeFacts()[0].id;

  expect(store.forgetFact(id, "2026-09-21T00:00:00.000Z")).toBe(true);
  expect(store.activeFacts()).toHaveLength(0);
  expect(store.upsertFact(ielts(), old)).toBe("blocked");

  // The user brings it up again after forgetting: that is new evidence.
  const fresh = store.addMessage("user", "下周六考雅思", { createdAt: "2026-09-22T09:00:00.000Z" });
  expect(store.upsertFact(ielts(), fresh)).toBe("updated");
  expect(store.activeFacts()).toHaveLength(1);
});

test("clearing history keeps facts but drops their source link", () => {
  const store = Store.open(":memory:");
  const msg = store.addMessage("user", "下周六考雅思");
  store.upsertFact(ielts(), msg);
  expect(store.clearHistory()).toBe(1);
  expect(store.messageCount()).toBe(0);
  expect(store.activeFacts()[0].sourceMessageId).toBeNull();
});

test("an old database is migrated to never reuse message ids, keeping ids and fact links", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(mkdtempSync(join(tmpdir(), "db-")), "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text TEXT NOT NULL, bubbles TEXT, has_image INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE facts (id INTEGER PRIMARY KEY, category TEXT NOT NULL, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, event_date TEXT, evidence TEXT NOT NULL, source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'active', forgotten_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO messages VALUES (7, 'user', '我养了猫', NULL, 0, '2026-09-01T00:00:00Z');
    INSERT INTO facts (category, key, value, evidence, source_message_id, created_at, updated_at) VALUES ('pet', 'cat', '用户养了猫', '我养了猫', 7, 'x', 'x');`);
  old.close();

  const store = Store.open(path);
  expect(store.activeFacts()[0].sourceMessageId).toBe(7);
  expect(store.recentMessages(5).map((m) => m.id)).toEqual([7]);
  store.clearHistory();
  expect(store.addMessage("user", "新的").id).toBe(8); // not 1 again
  store.close();
});
