import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EpisodicStore } from "../src/episodic/store.ts";
import { retention } from "../src/episodic/decay.ts";
import { scoreSalience } from "../src/episodic/salience.ts";
import { chunkText } from "../src/episodic/chunk.ts";
import { consolidate } from "../src/episodic/consolidate.ts";
import { HashEmbedder } from "../src/embedding/embedder.ts";
import { DEFAULT_CONFIG, type EpisodicRecord } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-test-"));
}

function record(over: Partial<EpisodicRecord> = {}): EpisodicRecord {
  return {
    id: "s1/e1#0",
    kind: "turn",
    sessionId: "s1",
    entryId: "e1",
    role: "user",
    text: "I prefer TypeScript for new services.",
    timestamp: "2026-01-01T00:00:00.000Z",
    salience: 0.7,
    accessCount: 0,
    state: "active",
    ...over,
  };
}

describe("decay", () => {
  const cfg = DEFAULT_CONFIG.decay;

  it("is 1 at age zero and decreases monotonically with age", () => {
    const r = record();
    const r0 = retention(r, "2026-01-01T00:00:00.000Z", cfg);
    const r30 = retention(r, "2026-01-31T00:00:00.000Z", cfg);
    const r90 = retention(r, "2026-04-01T00:00:00.000Z", cfg);
    expect(r0).toBeCloseTo(1, 5);
    expect(r30).toBeLessThan(r0);
    expect(r90).toBeLessThan(r30);
  });

  it("decays slower for salient and frequently accessed records", () => {
    const now = "2026-03-01T00:00:00.000Z";
    const dull = retention(record({ salience: 0.1 }), now, cfg);
    const salient = retention(record({ salience: 0.9 }), now, cfg);
    const accessed = retention(record({ accessCount: 5 }), now, cfg);
    expect(salient).toBeGreaterThan(dull);
    expect(accessed).toBeGreaterThan(retention(record(), now, cfg));
  });

  it("per-kind half-life override stretches the base (SEAM 2)", () => {
    const now = "2027-01-01T00:00:00.000Z"; // 365 days after the record
    const base = retention(record({ salience: 0.5 }), now, cfg);
    const overridden = retention(record({ salience: 0.5 }), now, {
      ...cfg,
      halfLifeDaysByKind: { turn: 730 },
    });
    // halfLife = 730 * (0.5 + 0.5) = 730 → 2^(-365/730) ≈ 0.707
    expect(overridden).toBeCloseTo(Math.pow(2, -365 / 730), 5);
    expect(overridden).toBeGreaterThan(base);
  });

  it("Infinity half-life pins retention at 1 (SEAM 2)", () => {
    const pinned = retention(record(), "2036-01-01T00:00:00.000Z", {
      ...cfg,
      halfLifeDaysByKind: { turn: Infinity },
    });
    expect(pinned).toBe(1);
  });

  it("kinds without an override keep the base half-life (SEAM 2)", () => {
    const now = "2026-03-01T00:00:00.000Z";
    const plain = retention(record(), now, cfg);
    const withOther = retention(record(), now, {
      ...cfg,
      halfLifeDaysByKind: { consolidated: 730 },
    });
    expect(withOther).toBeCloseTo(plain, 12);
  });
});

describe("salience", () => {
  it("ranks preference statements above filler", () => {
    const pref = scoreSalience(
      "I really prefer dark roast coffee over light.",
      "user",
    );
    const filler = scoreSalience("ok thanks!", "user");
    expect(pref).toBeGreaterThan(0.6);
    expect(filler).toBeLessThanOrEqual(0.1);
  });

  it("weights user turns above assistant turns", () => {
    const text =
      "The deploy pipeline uses Docker and Kubernetes in production.";
    expect(scoreSalience(text, "user")).toBeGreaterThan(
      scoreSalience(text, "assistant"),
    );
  });
});

describe("chunking", () => {
  it("keeps short turns whole and splits long ones under the ceiling", () => {
    expect(chunkText("short turn", 100)).toEqual(["short turn"]);
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i} talks about topic ${i}.`,
    ).join(" ");
    const chunks = chunkText(long, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(chunks.join(" ")).toContain("Sentence number 39");
  });
});

describe("episodic store persistence", () => {
  it("round-trips records through the JSONL log", () => {
    const dir = tmpDir();
    const store = EpisodicStore.open(dir);
    store.upsert(record());
    store.upsert(
      record({ id: "s1/e2#0", entryId: "e2", text: "Another memory." }),
    );

    const reopened = EpisodicStore.open(dir);
    expect(reopened.size).toBe(2);
    expect(reopened.get("s1/e1#0")?.text).toContain("TypeScript");
  });

  it("redaction tombstones content and survives reopen", () => {
    const dir = tmpDir();
    const store = EpisodicStore.open(dir);
    store.upsert(record());
    expect(store.redact("s1/e1#0")).toBe(true);

    const reopened = EpisodicStore.open(dir);
    const r = reopened.get("s1/e1#0")!;
    expect(r.state).toBe("redacted");
    expect(r.text).toBe("");
    expect(r.embedding).toBeUndefined();
    // The raw file must not contain the redacted text anywhere.
    const raw = fs.readFileSync(path.join(dir, "episodic.jsonl"), "utf8");
    expect(raw).not.toContain("TypeScript");
  });

  it("redactMany tombstones multiple records with one compacted JSONL line per id", () => {
    const dir = tmpDir();
    const store = EpisodicStore.open(dir);
    store.upsert(
      record({ id: "a", entryId: "a", text: "alpha", salience: 0.8 }),
    );
    store.upsert(
      record({ id: "b", entryId: "b", text: "bravo", salience: 0.7 }),
    );
    store.upsert(
      record({ id: "c", entryId: "c", text: "charlie", salience: 0.6 }),
    );

    expect(store.redact("b")).toBe(true);
    const rawAfterOneRedaction = fs
      .readFileSync(path.join(dir, "episodic.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(rawAfterOneRedaction).toHaveLength(3);

    const count = store.redactMany(["a", "b", "c", "missing"]);
    expect(count).toBe(2);

    for (const id of ["a", "b", "c"]) {
      const r = store.get(id)!;
      expect(r.state).toBe("redacted");
      expect(r.text).toBe("");
      expect(r.salience).toBe(0);
      expect(r.embedding).toBeUndefined();
    }

    const raw = fs
      .readFileSync(path.join(dir, "episodic.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(raw).toHaveLength(3);
    expect(raw.map((line) => JSON.parse(line).id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(raw.join("\n")).not.toContain("alpha");
    expect(raw.join("\n")).not.toContain("bravo");
    expect(raw.join("\n")).not.toContain("charlie");
    expect(store.redactMany(["a", "b", "c"])).toBe(0);
  });
});

describe("consolidation", () => {
  it("folds old faded turns into a session summary and demotes children", async () => {
    const dir = tmpDir();
    const store = EpisodicStore.open(dir);
    const embedder = new HashEmbedder(64);
    const old = "2025-06-01T00:00:00.000Z";
    for (let i = 0; i < 4; i++) {
      store.upsert(
        record({
          id: `s1/e${i}#0`,
          entryId: `e${i}`,
          timestamp: old,
          salience: 0.3,
          text: `Old turn ${i}: my sister Alice loves hiking near Boulder.`,
        }),
      );
    }
    // A recent record must not be touched.
    store.upsert(
      record({
        id: "s1/new#0",
        entryId: "new",
        timestamp: "2026-05-30T00:00:00.000Z",
      }),
    );

    const result = await consolidate(
      store,
      embedder,
      "2026-06-01T00:00:00.000Z",
      DEFAULT_CONFIG.consolidation,
      DEFAULT_CONFIG.decay,
    );

    expect(result.created.length).toBe(1);
    expect(result.consolidatedChildren).toBe(4);
    const summary = result.created[0];
    expect(summary.kind).toBe("consolidated");
    expect(summary.text).toContain("Alice");
    expect(summary.sourceIds).toHaveLength(4);
    expect(store.get("s1/e0#0")?.state).toBe("consolidated");
    expect(store.get("s1/new#0")?.state).toBe("active");
  });
});
