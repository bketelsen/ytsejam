import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ArchiveStore } from "../src/archive-store.ts";

describe("ArchiveStore", () => {
  test("defaults to false when nothing set; latest event wins after multiple writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-"));
    const store = new ArchiveStore(join(dir, "archived"));
    expect(store.isArchived("sess-1")).toBe(false);
    store.append("sess-1", { archived: true, timestamp: "2026-06-11T00:00:00Z" });
    expect(store.isArchived("sess-1")).toBe(true);
    // unarchive is a normal append of archived:false (latest-wins semantics)
    store.append("sess-1", { archived: false, timestamp: "2026-06-11T01:00:00Z" });
    expect(store.isArchived("sess-1")).toBe(false);
    store.append("sess-1", { archived: true, timestamp: "2026-06-11T02:00:00Z" });
    expect(store.isArchived("sess-1")).toBe(true);
    // independent per session
    expect(store.isArchived("sess-2")).toBe(false);
  });

  test("skips malformed lines so a single corrupt write can't break boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-"));
    mkdirSync(join(dir, "archived"), { recursive: true });
    const file = join(dir, "archived", "sess-1.jsonl");
    writeFileSync(
      file,
      '{"archived":true,"timestamp":"x"}\nnot json\n{"archived":false,"timestamp":"y"}\n',
    );
    const store = new ArchiveStore(join(dir, "archived"));
    expect(store.isArchived("sess-1")).toBe(false);
  });

  test("normalizes weird sessionId characters to a safe filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-"));
    const store = new ArchiveStore(join(dir, "archived"));
    // characters outside [a-zA-Z0-9_-] are replaced with _; same input round-trips
    store.append("sess/../x", { archived: true, timestamp: "x" });
    expect(store.isArchived("sess/../x")).toBe(true);
  });
});
