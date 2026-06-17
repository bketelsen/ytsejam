import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlLog } from "../src/store/jsonl-log.ts";

type TestRecord = {
  id: string;
  value: string;
  revision: number;
};

async function withLogFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ltm-jsonl-log-"));
  const filePath = join(dir, "nested", "records.jsonl");
  try {
    await mkdir(dirname(filePath), { recursive: true });
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("JsonlLog", () => {
  it("appends records and replays latest snapshot per id after reload", async () => {
    await withLogFile(async (filePath) => {
      const log = new JsonlLog<TestRecord>(filePath);
      log.append({ id: "a", value: "first", revision: 1 });
      log.append({ id: "b", value: "other", revision: 1 });
      log.append({ id: "a", value: "second", revision: 2 });

      const reloaded = new JsonlLog<TestRecord>(filePath).load();
      expect([...reloaded.entries()]).toEqual([
        ["a", { id: "a", value: "second", revision: 2 }],
        ["b", { id: "b", value: "other", revision: 1 }],
      ]);

      const text = await readFile(filePath, "utf8");
      expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    });
  });

  it("appends batches and returns an empty map for missing files", async () => {
    await withLogFile(async (filePath) => {
      const log = new JsonlLog<TestRecord>(filePath);
      expect(log.load().size).toBe(0);

      log.appendMany([
        { id: "a", value: "first", revision: 1 },
        { id: "b", value: "second", revision: 1 },
      ]);

      expect([...new JsonlLog<TestRecord>(filePath).load().values()]).toEqual([
        { id: "a", value: "first", revision: 1 },
        { id: "b", value: "second", revision: 1 },
      ]);
    });
  });

  it("skips malformed lines while preserving valid records", async () => {
    await withLogFile(async (filePath) => {
      await writeFile(
        filePath,
        [
          JSON.stringify({ id: "a", value: "before", revision: 1 }),
          "{not json",
          JSON.stringify({ id: "", value: "empty id", revision: 1 }),
          JSON.stringify({ id: "a", value: "after", revision: 2 }),
          JSON.stringify({ id: "b", value: "survives", revision: 1 }),
          "",
        ].join("\n"),
      );

      expect([...new JsonlLog<TestRecord>(filePath).load().entries()]).toEqual([
        ["a", { id: "a", value: "after", revision: 2 }],
        ["b", { id: "b", value: "survives", revision: 1 }],
      ]);
    });
  });
});
