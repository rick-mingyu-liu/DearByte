import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Fact, FactCandidate, Role, StoredMessage } from "../domain.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  bubbles TEXT,
  has_image INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- One row per key. A forgotten fact keeps its key and forgotten_at (value and
-- evidence are wiped) so extraction cannot resurrect it from older messages.
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  event_date TEXT,
  evidence TEXT NOT NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'forgotten')),
  forgotten_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type MessageRow = {
  id: number;
  role: Role;
  text: string;
  bubbles: string | null;
  has_image: number;
  created_at: string;
};

type FactRow = {
  id: number;
  category: Fact["category"];
  key: string;
  value: string;
  event_date: string | null;
  evidence: string;
  source_message_id: number | null;
  status: "active" | "forgotten";
  forgotten_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertResult = "inserted" | "updated" | "unchanged" | "blocked";

const toMessage = (r: MessageRow): StoredMessage => ({
  id: r.id,
  role: r.role,
  text: r.text,
  bubbles: r.bubbles ? JSON.parse(r.bubbles) : null,
  hasImage: r.has_image === 1,
  createdAt: r.created_at,
});

const toFact = (r: FactRow): Fact => ({
  id: r.id,
  category: r.category,
  key: r.key,
  value: r.value,
  eventDate: r.event_date,
  evidence: r.evidence,
  sourceMessageId: r.source_message_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Store {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  addMessage(
    role: Role,
    text: string,
    opts: { bubbles?: string[]; hasImage?: boolean; createdAt?: string } = {},
  ): StoredMessage {
    const row = this.db
      .prepare(
        `INSERT INTO messages (role, text, bubbles, has_image, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        role,
        text,
        opts.bubbles ? JSON.stringify(opts.bubbles) : null,
        opts.hasImage ? 1 : 0,
        opts.createdAt ?? new Date().toISOString(),
      ) as MessageRow;
    return toMessage(row);
  }

  /** Most recent messages, oldest first. */
  recentMessages(limit: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?")
      .all(limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  messageCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  }

  /** Deletes chat history only. Facts stay (their source link becomes null). */
  clearHistory(): number {
    return Number(this.db.prepare("DELETE FROM messages").run().changes);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  memoryEnabled(): boolean {
    return this.getSetting("memory_enabled") === "true";
  }

  setMemoryEnabled(enabled: boolean): void {
    this.setSetting("memory_enabled", String(enabled));
  }

  activeFacts(): Fact[] {
    const rows = this.db
      .prepare("SELECT * FROM facts WHERE status = 'active' ORDER BY updated_at DESC, id DESC")
      .all() as FactRow[];
    return rows.map(toFact);
  }

  /**
   * Insert or replace the fact for candidate.key. A forgotten key is only
   * revived by a message written after it was forgotten.
   */
  upsertFact(candidate: FactCandidate, source: StoredMessage, now = new Date().toISOString()): UpsertResult {
    const existing = this.db.prepare("SELECT * FROM facts WHERE key = ?").get(candidate.key) as
      | FactRow
      | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO facts (category, key, value, event_date, evidence, source_message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(candidate.category, candidate.key, candidate.value, candidate.eventDate, candidate.evidence, source.id, now, now);
      return "inserted";
    }

    if (existing.status === "forgotten" && existing.forgotten_at && source.createdAt <= existing.forgotten_at) {
      return "blocked";
    }
    if (
      existing.status === "active" &&
      existing.value === candidate.value &&
      existing.event_date === candidate.eventDate &&
      existing.category === candidate.category
    ) {
      return "unchanged";
    }

    this.db
      .prepare(
        `UPDATE facts SET category = ?, value = ?, event_date = ?, evidence = ?, source_message_id = ?,
           status = 'active', forgotten_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(candidate.category, candidate.value, candidate.eventDate, candidate.evidence, source.id, now, existing.id);
    return "updated";
  }

  /** Wipes the value and evidence; keeps the key as a tombstone. */
  forgetFact(id: number, now = new Date().toISOString()): boolean {
    const result = this.db
      .prepare(
        `UPDATE facts SET status = 'forgotten', value = '', evidence = '', event_date = NULL,
           source_message_id = NULL, forgotten_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(now, now, id);
    return Number(result.changes) === 1;
  }
}
