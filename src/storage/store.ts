import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Fact, FactCandidate, Role, StoredMessage } from "../domain.ts";

// AUTOINCREMENT: ids are never reused, even after history is emptied, so the
// summary's position (an id) can't end up pointing past newer messages.
const MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  bubbles TEXT,
  has_image INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`;

const SCHEMA = `
${MESSAGES_TABLE}

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

-- One row per agent model call: what it cost and what it was for. The weekly
-- spending cap is the sum of cost over the last 7 days. cost is NULL when unknown.
CREATE TABLE IF NOT EXISTS agent_usage (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cache_hit_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost REAL,
  ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_usage_at ON agent_usage (at);

-- One row per day (the day you woke up): what DearByte saw, so it can learn
-- your normal beyond the bridge's short retention. NULL = not recorded.
CREATE TABLE IF NOT EXISTS health_daily (
  date TEXT PRIMARY KEY,
  asleep_minutes INTEGER,
  deep_minutes INTEGER,
  rem_minutes INTEGER,
  resting_hr REAL,
  hrv_ms REAL,
  updated_at TEXT NOT NULL
);

-- Everything the agent sent on its own: morning briefs and caution alerts.
-- kind + date keep one brief a day and each caution once a day.
CREATE TABLE IF NOT EXISTS agent_alerts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  triggers TEXT NOT NULL,
  text TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_alerts_date ON agent_alerts (date);
`;

/**
 * Databases made before 2026-09-24 have messages without AUTOINCREMENT. Rebuild
 * the table once, keeping every id; facts point at messages by id and still do.
 * Foreign keys must be off while the old table is dropped.
 */
function migrateMessagesToAutoincrement(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("AUTOINCREMENT")) return;
  db.exec("BEGIN");
  try {
    db.exec(MESSAGES_TABLE.replace("CREATE TABLE IF NOT EXISTS messages", "CREATE TABLE messages_new"));
    db.exec("INSERT INTO messages_new SELECT id, role, text, bubbles, has_image, created_at FROM messages");
    db.exec("DROP TABLE messages");
    db.exec("ALTER TABLE messages_new RENAME TO messages");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

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

export type AgentUsage = {
  at: string;
  purpose: string;
  tier: string;
  model: string;
  promptTokens: number;
  cacheHitTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  cost: number | null;
  ms: number;
};

export type AgentUsageTotal = {
  purpose: string;
  tier: string;
  model: string;
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  cost: number;
  unpriced: number;
};

export type HealthDay = {
  date: string;
  asleepMinutes: number | null;
  deepMinutes: number | null;
  remMinutes: number | null;
  restingHr: number | null;
  hrvMs: number | null;
};

export type AgentAlert = { id: number; at: string; date: string; kind: string; triggers: string[]; text: string; delivered: boolean };

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
    // node:sqlite turns foreign keys on by default; the migration needs them off,
    // or dropping the old table would null every fact's source link.
    // The runner and the simulator may open the same file; wait for a lock instead of failing.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;");
    migrateMessagesToAutoincrement(db);
    db.exec("PRAGMA foreign_keys = ON;");
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

  /** Messages with afterId < id < beforeId, oldest first. */
  messagesBetween(afterId: number, beforeId: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE id > ? AND id < ? ORDER BY id")
      .all(afterId, beforeId) as MessageRow[];
    return rows.map(toMessage);
  }

  messageCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  }

  /** Deletes chat history and its rolling summary. Facts stay (their source link becomes null). */
  clearHistory(): number {
    this.db.prepare("DELETE FROM settings WHERE key IN ('summary_text', 'summary_upto')").run();
    this.bumpSummaryRev();
    return Number(this.db.prepare("DELETE FROM messages").run().changes);
  }

  /**
   * Drops the rolling summary after a fact is forgotten. The summary is prose
   * and may mention the fact, and so may messages it hasn't folded yet, so its
   * position jumps to the newest message: those are never folded in. The
   * recent window still shows them verbatim until they age out.
   */
  clearSummary(): void {
    const max = (this.db.prepare("SELECT MAX(id) AS id FROM messages").get() as { id: number | null }).id ?? 0;
    this.db.prepare("DELETE FROM settings WHERE key = 'summary_text'").run();
    this.setSetting("summary_upto", String(Math.max(max, Number(this.getSetting("summary_upto") ?? 0))));
    this.bumpSummaryRev();
  }

  /** Changes whenever the summary is cleared, so a fold already in flight knows not to write. */
  summaryRev(): string {
    return this.getSetting("summary_rev") ?? "0";
  }

  private bumpSummaryRev(): void {
    this.setSetting("summary_rev", String(Number(this.summaryRev()) + 1));
  }

  /**
   * Writes `values` only if the summary wasn't cleared since `rev` was read and
   * its position is still `upto` (another process may have folded meanwhile).
   * Returns whether it wrote.
   */
  setSummaryIf(rev: string, upto: number, values: Record<string, string>): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.summaryRev() !== rev || Number(this.getSetting("summary_upto") ?? 0) !== upto) {
        this.db.exec("ROLLBACK");
        return false;
      }
      for (const [k, v] of Object.entries(values)) this.setSetting(k, v);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Deletes messages written before `before` (ISO). With `upToId`, only those
   * up to that id, i.e. already folded into the summary. Facts stay.
   */
  pruneMessages(before: string, upToId: number | null): number {
    const result =
      upToId === null
        ? this.db.prepare("DELETE FROM messages WHERE created_at < ?").run(before)
        : this.db.prepare("DELETE FROM messages WHERE created_at < ? AND id <= ?").run(before, upToId);
    return Number(result.changes);
  }

  /** Several settings in one transaction. */
  setSettings(values: Record<string, string>): void {
    this.db.exec("BEGIN");
    try {
      for (const [k, v] of Object.entries(values)) this.setSetting(k, v);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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

  recordAgentUsage(u: AgentUsage): void {
    this.db
      .prepare(
        `INSERT INTO agent_usage (at, purpose, tier, model, prompt_tokens, cache_hit_tokens, cache_write_tokens, completion_tokens, cost, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.at, u.purpose, u.tier, u.model, u.promptTokens, u.cacheHitTokens, u.cacheWriteTokens, u.completionTokens, u.cost, u.ms);
  }

  /** USD spent on agent calls since `since` (ISO); calls with unknown cost count as 0. */
  agentSpendSince(since: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS spent FROM agent_usage WHERE at >= ?").get(since) as { spent: number };
    return row.spent;
  }

  /** Totals since `since`, grouped by purpose, tier and model, most expensive first. */
  agentUsageSummary(since: string): AgentUsageTotal[] {
    return this.db
      .prepare(
        `SELECT purpose, tier, model, COUNT(*) AS calls, SUM(prompt_tokens) AS promptTokens, SUM(cache_hit_tokens) AS cacheHitTokens,
                SUM(completion_tokens) AS completionTokens, COALESCE(SUM(cost), 0) AS cost, SUM(cost IS NULL) AS unpriced
         FROM agent_usage WHERE at >= ? GROUP BY purpose, tier, model ORDER BY cost DESC`,
      )
      .all(since) as AgentUsageTotal[];
  }

  /** Records what's known for a day; a NULL never overwrites a known value. */
  upsertHealthDay(d: HealthDay, now = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO health_daily (date, asleep_minutes, deep_minutes, rem_minutes, resting_hr, hrv_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           asleep_minutes = COALESCE(excluded.asleep_minutes, asleep_minutes),
           deep_minutes = COALESCE(excluded.deep_minutes, deep_minutes),
           rem_minutes = COALESCE(excluded.rem_minutes, rem_minutes),
           resting_hr = COALESCE(excluded.resting_hr, resting_hr),
           hrv_ms = COALESCE(excluded.hrv_ms, hrv_ms),
           updated_at = excluded.updated_at`,
      )
      .run(d.date, d.asleepMinutes, d.deepMinutes, d.remMinutes, d.restingHr, d.hrvMs, now);
  }

  /** Days from `from` to `to` inclusive (YYYY-MM-DD), oldest first. */
  healthDays(from: string, to: string): HealthDay[] {
    const rows = this.db
      .prepare("SELECT date, asleep_minutes, deep_minutes, rem_minutes, resting_hr, hrv_ms FROM health_daily WHERE date >= ? AND date <= ? ORDER BY date")
      .all(from, to) as Array<{ date: string; asleep_minutes: number | null; deep_minutes: number | null; rem_minutes: number | null; resting_hr: number | null; hrv_ms: number | null }>;
    return rows.map((r) => ({ date: r.date, asleepMinutes: r.asleep_minutes, deepMinutes: r.deep_minutes, remMinutes: r.rem_minutes, restingHr: r.resting_hr, hrvMs: r.hrv_ms }));
  }

  recordAlert(a: { at: string; date: string; kind: string; triggers: string[]; text: string; delivered: boolean }): number {
    const row = this.db
      .prepare("INSERT INTO agent_alerts (at, date, kind, triggers, text, delivered) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(a.at, a.date, a.kind, JSON.stringify(a.triggers), a.text, a.delivered ? 1 : 0) as { id: number };
    return row.id;
  }

  alertsOn(date: string): AgentAlert[] {
    const rows = this.db.prepare("SELECT id, at, date, kind, triggers, text, delivered FROM agent_alerts WHERE date = ? ORDER BY id").all(date) as Array<
      Omit<AgentAlert, "triggers" | "delivered"> & { triggers: string; delivered: number }
    >;
    return rows.map((r) => ({ ...r, triggers: JSON.parse(r.triggers), delivered: r.delivered === 1 }));
  }

  recentAlerts(limit: number): AgentAlert[] {
    const rows = this.db.prepare("SELECT id, at, date, kind, triggers, text, delivered FROM agent_alerts ORDER BY id DESC LIMIT ?").all(limit) as Array<
      Omit<AgentAlert, "triggers" | "delivered"> & { triggers: string; delivered: number }
    >;
    return rows.map((r) => ({ ...r, triggers: JSON.parse(r.triggers), delivered: r.delivered === 1 }));
  }

  markAlertDelivered(id: number): void {
    this.db.prepare("UPDATE agent_alerts SET delivered = 1 WHERE id = ?").run(id);
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
    const forgotten = Number(result.changes) === 1;
    if (forgotten) this.clearSummary();
    return forgotten;
  }
}
