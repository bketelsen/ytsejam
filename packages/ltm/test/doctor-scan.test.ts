import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { scanLog, type LogScan } from "../src/cli/doctor.ts";

function tmpFile(name = "scan.jsonl"): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ltm-scan-")), name);
}

/**
 * The behaviour scanLog had BEFORE PR-5, when it read the whole file into one
 * string and split on "\n". The streaming reader must produce byte-identical
 * LogScan output (same recorded line numbers, same malformed indices) for any
 * file small enough to fit in a string — that equivalence is the contract.
 */
function referenceSplitScan(filePath: string): LogScan | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const scan: LogScan = { file: path.basename(filePath), records: [], malformed: [] };
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      if (typeof json.id === "string" && json.id) {
        scan.records.push({ id: json.id, line: i + 1, json });
      } else {
        scan.malformed.push(i + 1);
      }
    } catch {
      scan.malformed.push(i + 1);
    }
  });
  return scan;
}

describe("doctor scanLog (streaming, D4 sibling site)", () => {
  it("returns undefined for a missing file (not an error)", () => {
    expect(scanLog(path.join(os.tmpdir(), "definitely-absent-xyz.jsonl"))).toBeUndefined();
  });

  it("matches the old split-based scan byte-for-byte across tricky inputs", () => {
    // blank lines, a malformed line, a no-id JSON line, valid records, and BOTH
    // a trailing-newline and a no-trailing-newline variant. Recorded line
    // numbers and malformed indices must be identical to the reference.
    const bodies = [
      // trailing newline:
      '{"id":"a","v":1}\n\n{broken\n{"noId":true}\n{"id":"b","v":2}\n',
      // NO trailing newline (last line is a real record):
      '{"id":"a","v":1}\n\n{broken\n{"id":"b","v":2}',
      // leading blank + interior blanks:
      '\n{"id":"a"}\n\n\n{"id":"b"}\n',
      // only blanks:
      "\n\n\n",
      // empty file:
      "",
    ];
    for (const body of bodies) {
      const f = tmpFile();
      fs.writeFileSync(f, body);
      const ref = referenceSplitScan(f);
      const got = scanLog(f);
      expect(got).toEqual(ref);
    }
  });

  it("decodes multi-byte UTF-8 records straddling a 4 MiB chunk seam", () => {
    // Pad with a valid record whose byte length pushes a later multi-byte char
    // across the chunk boundary; the streaming TextDecoder must not corrupt it.
    const seamPad = `{"id":"pad","t":"${"x".repeat(4 * 1024 * 1024)}"}\n`;
    const multibyte = `{"id":"emoji","t":"🌍🌎🌏 café déjà"}\n`;
    const f = tmpFile();
    fs.writeFileSync(f, seamPad + multibyte + '{"id":"tail"}\n');
    const scan = scanLog(f)!;
    expect(scan.malformed).toHaveLength(0);
    expect(scan.records.map((r) => r.id)).toEqual(["pad", "emoji", "tail"]);
    // the multi-byte payload survived the seam intact:
    expect((scan.records[1].json as { t: string }).t).toBe("🌍🌎🌏 café déjà");
  });

  // D4: a log larger than V8's max string length (~0.54 GB) made the OLD
  // readFileSync-based scanLog throw -> bare catch -> `return undefined`, so
  // doctor SILENTLY skipped the file and reported a clean store. This proves
  // the streaming scan reads such a file and still finds a malformed line near
  // the end. Opt-in (writes >0.5 GB to /tmp) via LTM_TEST_BIG_LOG=1.
  it.runIf(process.env.LTM_TEST_BIG_LOG === "1")(
    "scans a log larger than the V8 max string length and finds a late malformed line (D4)",
    () => {
      const cap = bufferConstants.MAX_STRING_LENGTH; // ~0.54 GB in chars
      const f = tmpFile("big.jsonl");
      const fd = fs.openSync(f, "w");
      const line = `{"id":"x","t":"${"y".repeat(900)}"}\n`; // ~0.9 KB/line
      const lineBytes = Buffer.byteLength(line);
      const targetBytes = cap + 64 * 1024 * 1024; // comfortably over the cap
      let written = 0;
      let validLines = 0;
      while (written < targetBytes) {
        fs.writeSync(fd, line);
        written += lineBytes;
        validLines++;
      }
      // one malformed line at the very end — only reachable if the WHOLE file
      // was scanned (the old loader never got here; it threw on the read).
      fs.writeSync(fd, "{not valid json\n");
      fs.closeSync(fd);

      const scan = scanLog(f);
      expect(scan).toBeDefined();
      expect(scan!.records).toHaveLength(validLines);
      expect(scan!.malformed).toEqual([validLines + 1]); // the trailing bad line
    },
    120_000,
  );
});
