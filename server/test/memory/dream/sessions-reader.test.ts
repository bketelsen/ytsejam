// server/test/memory/dream/sessions-reader.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGatherUserTurns } from "../../../src/memory/dream/sessions-reader.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("makeGatherUserTurns", () => {
  it("returns user turns from session files newer than the cursor", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-sess-"));
    const sessions = path.join(dir, "sessions", "--chat--");
    fs.mkdirSync(sessions, { recursive: true });
    // v3 session file: header requires type, version, id, timestamp, cwd.
    // Entry lines require: type, id, parentId (string|null), timestamp, message.
    const file = path.join(sessions, "s1.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-06-19T00:00:00Z", cwd: "/tmp" });
    const userMsg = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-06-19T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "I prefer Go" }] } });
    fs.writeFileSync(file, header + "\n" + userMsg + "\n");
    const gather = makeGatherUserTurns(path.join(dir, "sessions"));
    const { turns, newCursorMs } = gather(0);
    expect(turns.some((t) => t.text.includes("Go"))).toBe(true);
    expect(newCursorMs).toBeGreaterThan(0);
    // cursor past the file's mtime returns nothing
    expect(gather(newCursorMs + 1000).turns).toHaveLength(0);
  });
});
