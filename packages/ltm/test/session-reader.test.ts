import { describe, expect, it } from "vitest";
import path from "node:path";
import { readSessionFile } from "../src/session/reader.ts";

const FIXTURE = path.join(import.meta.dirname, "../fixtures/sample-session.jsonl");

describe("session reader (pi v3 JSONL)", () => {
  it("parses header, title, and turns on the active branch only", () => {
    const session = readSessionFile(FIXTURE);
    expect(session.sessionId).toBe("11111111-2222-7333-8444-555555555555");
    expect(session.title).toBe("Planning a trip");
    expect(session.cwd).toBe("/home/user");

    const texts = session.turns.map((t) => t.text);
    expect(texts.some((t) => t.includes("abandoned branch"))).toBe(false);
    expect(texts.some((t) => t.includes("window seats"))).toBe(true);
    expect(texts.some((t) => t.includes("Lisbon trip"))).toBe(true);
  });

  it("keeps compaction summaries as summary turns", () => {
    const session = readSessionFile(FIXTURE);
    const summary = session.turns.find((t) => t.role === "summary");
    expect(summary).toBeDefined();
    expect(summary!.text).toContain("window seats");
  });

  it("skips corrupt lines with a warning instead of failing", () => {
    const session = readSessionFile(FIXTURE);
    expect(session.warnings.length).toBe(1);
    expect(session.warnings[0]).toContain("malformed");
  });

  it("excludes assistant thinking by default and includes it on request", () => {
    const without = readSessionFile(FIXTURE);
    expect(without.turns.some((t) => t.text.includes("shared a preference"))).toBe(false);
    const withThinking = readSessionFile(FIXTURE, { includeThinking: true });
    expect(withThinking.turns.some((t) => t.text.includes("shared a preference"))).toBe(true);
  });

  it("orders turns chronologically root-first", () => {
    const session = readSessionFile(FIXTURE);
    const stamps = session.turns.map((t) => t.timestamp);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
