import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { Indexer } from "../src/indexer.ts";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "idx-title-close-")), "index.db");
}

describe("Indexer.setTitle after close", () => {
  test("silently no-ops against a closed db handle", () => {
    const indexer = new Indexer(tempDb(), { checkpointIntervalMs: 0 });
    indexer.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => indexer.setTitle("some-id", "some-title")).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
