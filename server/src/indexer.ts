import { DatabaseSync } from "node:sqlite";
import type { TaskRow, TaskStatus } from "./tasks.ts";
import type { ScheduleRow } from "./schedules.ts";

const SCHEMA_VERSION = 4;

export interface SessionRow {
  id: string;
  path: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
  unread: boolean;
  archived: boolean;
}

type SqliteInteger = number | bigint;

interface SessionDbRow {
  id: string;
  path: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  preview: string;
  unread: SqliteInteger;
  archived: SqliteInteger;
}

interface TaskDbRow {
  id: string;
  parent_session_id: string;
  subagent_session_id: string | null;
  label: string;
  status: string;
  model: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string;
}

interface ScheduleDbRow {
  id: string;
  label: string;
  prompt: string;
  spec_json: string;
  target_session_id: string | null;
  enabled: SqliteInteger;
  cancelled: SqliteInteger;
  created_at: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  fired_count: SqliteInteger;
}

/** Default WAL truncation cadence (5 min). See `IndexerOptions.checkpointIntervalMs`. */
export const DEFAULT_WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

export interface IndexerOptions {
  /**
   * Cadence for periodic `PRAGMA wal_checkpoint(TRUNCATE)`. Default 5 min.
   * Pass `0` to disable the timer entirely (sqlite's `db.close()` already
   * finalizes and removes the `-wal` file at shutdown -- this option only
   * controls the long-running cadence).
   * SQLite's built-in auto-checkpoint is PASSIVE-only and never shrinks the
   * `-wal` file -- it just oscillates around `wal_autocheckpoint * page_size`
   * (~4 MB at defaults). A periodic TRUNCATE keeps the on-disk shape honest
   * for backups and `ls -lah` health checks. See issue #99.
   */
  checkpointIntervalMs?: number;
}

export class Indexer {
  private db: DatabaseSync;
  private checkpointTimer: NodeJS.Timeout | null = null;
  /** true when the constructor wiped a stale/corrupt index — caller should rebuild from JSONL */
  public wasReset = false;

  constructor(dbPath: string, options: IndexerOptions = {}) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    try {
      const version = this.readSchemaVersion();
      if (version !== SCHEMA_VERSION) {
        this.recreateSchema();
        this.wasReset = version !== null; // fresh db is not a "reset"
      }
    } catch {
      this.recreateSchema();
      this.wasReset = true;
    }

    const intervalMs = options.checkpointIntervalMs ?? DEFAULT_WAL_CHECKPOINT_INTERVAL_MS;
    if (intervalMs > 0) {
      this.checkpointTimer = setInterval(() => this.checkpointWal(), intervalMs);
      // Never hold the event loop open just to run a maintenance checkpoint.
      this.checkpointTimer.unref();
    }
  }

  /**
   * Run `PRAGMA wal_checkpoint(TRUNCATE)`.
   * Errors are caught and logged at WARN -- this is best-effort maintenance.
   * Exposed for tests; production callers don't need it (the timer drives it).
   */
  checkpointWal(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.warn(
        `[indexer] wal_checkpoint(TRUNCATE) failed: ${(err as Error).message}`,
      );
    }
  }

  private readSchemaVersion(): number | null {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .all();
    if (tables.length === 0) return null;
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  }

  private recreateSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS schedules;
      DROP TABLE IF EXISTS meta;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        unread INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX sessions_updated ON sessions(updated_at DESC);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        subagent_session_id TEXT,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX tasks_parent ON tasks(parent_session_id);
      CREATE INDEX tasks_created ON tasks(created_at DESC);
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        prompt TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        target_session_id TEXT,
        enabled INTEGER NOT NULL,
        cancelled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_fired_at TEXT,
        next_fire_at TEXT,
        fired_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX schedules_created ON schedules(created_at DESC);
    `);
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, path, title, created_at, updated_at, preview, unread, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path=excluded.path, title=excluded.title,
           created_at=excluded.created_at, updated_at=excluded.updated_at,
           preview=excluded.preview, unread=excluded.unread, archived=excluded.archived`,
      )
      .run(
        row.id,
        row.path,
        row.title,
        row.createdAt,
        row.updatedAt,
        row.preview,
        row.unread ? 1 : 0,
        row.archived ? 1 : 0,
      );
  }

  touchSession(id: string, updatedAt: string, preview: string): void {
    this.db
      .prepare("UPDATE sessions SET updated_at=?, preview=? WHERE id=?")
      .run(updatedAt, preview, id);
  }

  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, id);
  }

  setUnread(id: string, unread: boolean): void {
    this.db.prepare("UPDATE sessions SET unread=? WHERE id=?").run(unread ? 1 : 0, id);
  }

  setArchived(id: string, archived: boolean): void {
    this.db.prepare("UPDATE sessions SET archived=? WHERE id=?").run(archived ? 1 : 0, id);
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionDbRow | undefined;
    return r ? this.toRow(r) : undefined;
  }

  listSessions(opts?: { includeArchived?: boolean }): SessionRow[] {
    const sql = opts?.includeArchived
      ? "SELECT * FROM sessions ORDER BY updated_at DESC"
      : "SELECT * FROM sessions WHERE archived=0 ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all() as unknown as SessionDbRow[]).map((r) => this.toRow(r));
  }

  reset(): void {
    this.recreateSchema();
  }

  close(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    // sqlite's own `db.close()` finalizes the WAL and removes the -wal file
    // when this is the last connection -- no explicit checkpoint needed here.
    // The periodic checkpointWal() above is the long-running fix; see #99.
    this.db.close();
  }

  /** test hook for simulating stale schema */
  setSchemaVersionForTest(version: number): void {
    this.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
  }

  upsertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, parent_session_id, subagent_session_id, label, status, model,
           created_at, started_at, finished_at, result_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET subagent_session_id=excluded.subagent_session_id,
           status=excluded.status, started_at=excluded.started_at,
           finished_at=excluded.finished_at, result_summary=excluded.result_summary`,
      )
      .run(
        row.id,
        row.parentSessionId,
        row.subagentSessionId,
        row.label,
        row.status,
        row.model,
        row.createdAt,
        row.startedAt,
        row.finishedAt,
        row.resultSummary,
      );
  }

  getTask(id: string): TaskRow | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskDbRow | undefined;
    return r ? this.toTaskRow(r) : undefined;
  }

  listTasks(): TaskRow[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as unknown as TaskDbRow[]).map((r) =>
      this.toTaskRow(r),
    );
  }

  upsertSchedule(row: ScheduleRow): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, label, prompt, spec_json, target_session_id, enabled, cancelled,
           created_at, last_fired_at, next_fire_at, fired_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, cancelled=excluded.cancelled,
           last_fired_at=excluded.last_fired_at, next_fire_at=excluded.next_fire_at,
           fired_count=excluded.fired_count`,
      )
      .run(
        row.id,
        row.label,
        row.prompt,
        JSON.stringify(row.spec),
        row.targetSessionId,
        row.enabled ? 1 : 0,
        row.cancelled ? 1 : 0,
        row.createdAt,
        row.lastFiredAt,
        row.nextFireAt,
        row.firedCount,
      );
  }

  getSchedule(id: string): ScheduleRow | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleDbRow | undefined;
    return r ? this.toScheduleRow(r) : undefined;
  }

  listSchedules(): ScheduleRow[] {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all() as unknown as ScheduleDbRow[]).map(
      (r) => this.toScheduleRow(r),
    );
  }

  private toScheduleRow(r: ScheduleDbRow): ScheduleRow {
    return {
      id: r.id,
      label: r.label,
      prompt: r.prompt,
      spec: JSON.parse(r.spec_json),
      targetSessionId: r.target_session_id,
      enabled: Number(r.enabled) === 1,
      cancelled: Number(r.cancelled) === 1,
      createdAt: r.created_at,
      lastFiredAt: r.last_fired_at,
      nextFireAt: r.next_fire_at,
      firedCount: Number(r.fired_count),
    };
  }

  private toTaskRow(r: TaskDbRow): TaskRow {
    return {
      id: r.id,
      parentSessionId: r.parent_session_id,
      subagentSessionId: r.subagent_session_id,
      label: r.label,
      status: r.status as TaskStatus,
      model: r.model,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      resultSummary: r.result_summary,
    };
  }

  private toRow(r: SessionDbRow): SessionRow {
    return {
      id: r.id,
      path: r.path,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      preview: r.preview,
      unread: Number(r.unread) === 1,
      archived: Number(r.archived) === 1,
    };
  }
}
