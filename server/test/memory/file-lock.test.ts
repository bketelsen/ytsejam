import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { append, patch, write } from "../../src/memory/index.ts";
import { withFileLock } from "../../src/memory/store/file-lock.ts";

/**
 * MEM-H3: the cog store's mutating primitives are read → modify →
 * atomicWrite(rename) sequences. Without per-file serialization, two concurrent
 * mutations of the SAME file both read the same `existing` and the second
 * rename clobbers the first (lost update). pi runs a turn's tool calls in
 * parallel, so two cog_append/cog_patch calls to the same file in one turn is a
 * reachable input — and cog markdown is the authoritative substrate.
 */

let root = "";
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-lock-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  warnSpy?.mockRestore();
  warnSpy = null;
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

async function slurp(rel: string): Promise<string> {
  return readFile(join(root, ...rel.split("/")), "utf8");
}

describe("withFileLock", () => {
  test("serializes same-key callbacks (no interleaving) while different keys run free", async () => {
    const order: string[] = [];
    const make = (key: string, tag: string) =>
      withFileLock(key, async () => {
        order.push(`${tag}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${tag}:end`);
      });
    // Two on the same key must not interleave; a third on another key is independent.
    await Promise.all([make("A", "a1"), make("A", "a2"), make("B", "b1")]);
    // a1 fully completes before a2 starts.
    expect(order.indexOf("a1:end")).toBeLessThan(order.indexOf("a2:start"));
  });

  test("a rejecting holder does not strand the next waiter on the same key", async () => {
    const results: string[] = [];
    const p1 = withFileLock("K", async () => {
      throw new Error("boom");
    }).catch(() => results.push("p1-rejected"));
    const p2 = withFileLock("K", async () => {
      results.push("p2-ran");
    });
    await Promise.all([p1, p2]);
    expect(results).toContain("p1-rejected");
    expect(results).toContain("p2-ran");
  });
});

describe("cog store concurrent same-file writes (MEM-H3)", () => {
  test("N concurrent appends to the same file all land (no lost update)", async () => {
    const N = 12;
    const calls = Array.from({ length: N }, (_, i) =>
      append("notes.md", `line-${i}`),
    );
    await Promise.all(calls);

    const content = await slurp("notes.md");
    for (let i = 0; i < N; i++) {
      expect(content).toContain(`line-${i}`);
    }
    // Exactly N non-empty lines — nothing dropped, nothing duplicated.
    const nonEmpty = content.split("\n").filter((l) => l.trim().length > 0);
    expect(nonEmpty).toHaveLength(N);
  });

  test("concurrent appends to DIFFERENT files all succeed independently", async () => {
    const N = 8;
    await Promise.all(Array.from({ length: N }, (_, i) => append(`f${i}.md`, `content-${i}`)));
    for (let i = 0; i < N; i++) {
      expect(await slurp(`f${i}.md`)).toContain(`content-${i}`);
    }
  });

  test("concurrent append + patch on the same file do not lose the append", async () => {
    await writeFile(join(root, "doc.md"), "SEED\n", "utf8");
    // Patch rewrites SEED -> SEEDED while an append adds a new line. With the
    // lock both land; without it, whichever renames last wins and the other
    // mutation is lost.
    await Promise.all([
      patch("doc.md", "SEED", "SEEDED"),
      append("doc.md", "appended-line"),
    ]);
    const content = await slurp("doc.md");
    expect(content).toContain("SEEDED");
    expect(content).toContain("appended-line");
  });

  test("concurrent writes to the same allow-listed file serialize to one winner cleanly", async () => {
    // domains.yml is an allow-listed whole-file write target. Fire several
    // concurrent writes; serialization guarantees the file ends as exactly one
    // of the written payloads (no torn/interleaved content).
    const payloads = Array.from(
      { length: 6 },
      (_, i) => `version: 1\ndomains:\n  - id: d${i}\n    path: projects/d${i}\n`,
    );
    await Promise.all(payloads.map((p) => write("domains.yml", p)));
    const content = await slurp("domains.yml");
    expect(payloads).toContain(content);
  });
});
