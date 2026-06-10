import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Indexer, type SessionRow } from "../src/indexer.ts";
import type { TaskRow } from "../src/tasks.ts";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "idx-")), "index.db");
}

const row: SessionRow = {
  id: "s1",
  path: "/data/sessions/--chat--/x_s1.jsonl",
  title: null,
  createdAt: "2026-06-09T10:00:00Z",
  updatedAt: "2026-06-09T10:00:00Z",
  preview: "",
  unread: false,
};

describe("Indexer", () => {
  test("upsert, touch, title, unread, list ordering, delete", () => {
    const idx = new Indexer(tempDb());
    idx.upsertSession(row);
    idx.upsertSession({ ...row, id: "s2", updatedAt: "2026-06-09T11:00:00Z" });
    idx.touchSession("s1", "2026-06-09T12:00:00Z", "hello there");
    idx.setTitle("s1", "Greetings");
    idx.setUnread("s1", true);

    const sessions = idx.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]); // newest updated first
    expect(sessions[0]).toMatchObject({ title: "Greetings", preview: "hello there", unread: true });

    idx.deleteSession("s1");
    expect(idx.listSessions().map((s) => s.id)).toEqual(["s2"]);
    expect(idx.getSession("s1")).toBeUndefined();
  });

  test("reset clears all rows for rebuild", () => {
    const path = tempDb();
    const idx = new Indexer(path);
    idx.upsertSession(row);
    idx.reset();
    expect(idx.listSessions()).toEqual([]);
  });

  test("reopening keeps data; stale schema version forces empty start", () => {
    const path = tempDb();
    const a = new Indexer(path);
    a.upsertSession(row);
    a.close();
    const b = new Indexer(path);
    expect(b.listSessions().length).toBe(1);
    b.setSchemaVersionForTest(0);
    b.close();
    const c = new Indexer(path);
    expect(c.listSessions()).toEqual([]);
    expect(c.wasReset).toBe(true);
  });
});

describe("tasks table", () => {
  const taskRow: TaskRow = {
    id: "t1",
    parentSessionId: "p1",
    subagentSessionId: null,
    label: "research",
    status: "pending",
    model: "faux/faux",
    createdAt: "2026-06-09T10:00:00Z",
    startedAt: null,
    finishedAt: null,
    resultSummary: "",
  };

  test("upsert, get, list ordering", () => {
    const idx = new Indexer(tempDb());
    idx.upsertTask(taskRow);
    idx.upsertTask({ ...taskRow, id: "t2", createdAt: "2026-06-09T11:00:00Z" });
    idx.upsertTask({ ...taskRow, status: "running", subagentSessionId: "s1", startedAt: "x" });
    expect(idx.getTask("t1")).toMatchObject({ status: "running", subagentSessionId: "s1" });
    expect(idx.listTasks().map((t) => t.id)).toEqual(["t2", "t1"]); // newest created first
    expect(idx.getTask("missing")).toBeUndefined();
  });
});
