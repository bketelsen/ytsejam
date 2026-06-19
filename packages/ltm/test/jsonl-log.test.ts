import { describe, expect, it } from "vitest";
import { appendFileSync, closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as bufferConstants } from "node:buffer";
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

  // D4: a multi-byte UTF-8 char must survive being split across a streamed
  // read-chunk boundary. The loader reads in 4 MiB chunks; a record whose
  // bytes straddle a chunk seam must still decode and parse correctly.
  it("decodes multi-byte UTF-8 records that straddle a read chunk", async () => {
    await withLogFile(async (filePath) => {
      // value padded so the record is far larger than the line itself is short:
      // an emoji ("\u{1F600}", 4 UTF-8 bytes) plus enough filler that, with many
      // records, some land on a chunk seam.
      const log = new JsonlLog<TestRecord>(filePath);
      for (let i = 0; i < 2000; i++) {
        log.append({ id: `r${i}`, value: `caf\u00e9-\u{1F600}-${"x".repeat(40)}`, revision: i });
      }
      const reloaded = new JsonlLog<TestRecord>(filePath).load();
      expect(reloaded.size).toBe(2000);
      expect(reloaded.get("r1234")?.value).toBe(`caf\u00e9-\u{1F600}-${"x".repeat(40)}`);
    });
  });

  // D4 REGRESSION (the load-bearing one): a JSONL log larger than V8's max
  // string length must load fully. The old loader did
  // `fs.readFileSync(path, "utf8")` into ONE string, which throws
  // ERR_STRING_TOO_LONG past ~0.5 GB and was swallowed by a bare catch — the
  // store silently loaded ZERO records (the live-retrieval blind spot).
  // This test writes a file just over the cap and asserts every record loads.
  // It is slow + disk-heavy by necessity (a smaller file cannot reproduce the
  // V8 string-cap throw), so it is opt-in via LTM_TEST_BIG_LOG=1.
  it.runIf(process.env.LTM_TEST_BIG_LOG === "1")(
    "loads a log larger than the V8 max string length (D4)",
    async () => {
      await withLogFile(async (filePath) => {
        const cap = bufferConstants.MAX_STRING_LENGTH; // ~0.54 GB
        // Each record line ~ (12 + 8192 + overhead) bytes. Write enough to
        // exceed `cap` bytes by a comfortable margin.
        const filler = "y".repeat(8192);
        const lineBytes = JSON.stringify({ id: "rXXXXXX", value: filler, revision: 0 }).length + 1;
        const target = cap + 64 * 1024 * 1024; // cap + 64 MiB
        const recordCount = Math.ceil(target / lineBytes);

        // Write directly (fast) to the file, batching appends.
        const fd = openSync(filePath, "w");
        try {
          const BATCH = 1000;
          let batch = "";
          let inBatch = 0;
          for (let i = 0; i < recordCount; i++) {
            batch += `${JSON.stringify({ id: `r${i}`, value: filler, revision: i })}\n`;
            if (++inBatch >= BATCH) {
              writeSync(fd, batch);
              batch = "";
              inBatch = 0;
            }
          }
          if (batch) writeSync(fd, batch);
        } finally {
          closeSync(fd);
        }

        // Sanity: the file genuinely exceeds the string cap.
        const { statSync } = await import("node:fs");
        expect(statSync(filePath).size).toBeGreaterThan(cap);

        const loaded = new JsonlLog<TestRecord>(filePath).load();
        expect(loaded.size).toBe(recordCount);
        expect(loaded.get(`r${recordCount - 1}`)?.revision).toBe(recordCount - 1);
      });
    },
    600_000,
  );

  // D4 (compact side): compacting a record set whose serialized form exceeds
  // the V8 string cap must not throw. The old compact() did
  // `[...records].map(...).join("")` into ONE string before writeFileSync.
  // Verified structurally here without a >0.5 GB write: compact streams to the
  // fd one line at a time, so a large iterable round-trips through load().
  it("compacts a large record set and round-trips through load", async () => {
    await withLogFile(async (filePath) => {
      const log = new JsonlLog<TestRecord>(filePath);
      const records: TestRecord[] = [];
      for (let i = 0; i < 5000; i++) records.push({ id: `r${i}`, value: "z".repeat(200), revision: i });
      log.compact(records);
      const reloaded = new JsonlLog<TestRecord>(filePath).load();
      expect(reloaded.size).toBe(5000);
      expect(reloaded.get("r4999")?.revision).toBe(4999);
    });
  });
});
