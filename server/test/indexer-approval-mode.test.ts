import { describe, expect, test } from "vitest";
import { Indexer } from "../src/indexer.ts";

describe("indexer approval_mode column", () => {
  test("new session defaults to yolo", () => {
    const indexer = new Indexer(":memory:");
    indexer.upsertSession({
      id: "s1",
      path: "/tmp/s1.jsonl",
      title: null,
      createdAt: "2026-06-14T00:00:00Z",
      updatedAt: "2026-06-14T00:00:00Z",
      preview: "",
      unread: false,
      archived: false,
      approvalMode: "yolo",
    });
    const rows = indexer.listSessions();
    expect(rows[0]!.approvalMode).toBe("yolo");
  });

  test("ask mode round-trips", () => {
    const indexer = new Indexer(":memory:");
    indexer.upsertSession({
      id: "s2",
      path: "/tmp/s2.jsonl",
      title: null,
      createdAt: "2026-06-14T00:00:00Z",
      updatedAt: "2026-06-14T00:00:00Z",
      preview: "",
      unread: false,
      archived: false,
      approvalMode: "ask",
    });
    expect(indexer.listSessions()[0]!.approvalMode).toBe("ask");
  });

  test("invalid mode rejected by CHECK", () => {
    const indexer = new Indexer(":memory:");
    expect(() =>
      indexer.upsertSession({
        id: "s3",
        path: "/tmp/s3.jsonl",
        title: null,
        createdAt: "2026-06-14T00:00:00Z",
        updatedAt: "2026-06-14T00:00:00Z",
        preview: "",
        unread: false,
        archived: false,
        approvalMode: "bogus" as any,
      }),
    ).toThrow();
  });
});
