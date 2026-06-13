# Recall Tool Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Ship a unified `recall(query)` agent tool that returns interleaved cog full-text + LTM semantic hits, deduped by origin, with per-hit normalized shape.

**Spec:** [docs/plans/2026-06-13-recall-tool-design.md](./2026-06-13-recall-tool-design.md)

**Architecture:** New module `server/src/memory/recall.ts` calls both substrates, normalizes per-hit shape, dedupes by `cog:<path>` origin prefix, strict-alternates the merge. Registered as agent tool `recall` alongside `cog_search` via `createCogTools()` in `server/src/tools/cog.ts`. Single small read-side accessor `getLtm()` added to `server/src/memory/index.ts` first so recall doesn't need module-internal access.

**Tech Stack:** TypeScript, vitest, node:fs/promises. In-process — no new dependencies.

**Worktree:** `~/projects/.worktrees/recall-tool` (persistent, NOT `/tmp` — see [docs/agents/tooling.md "Long-Lived Worktrees Belong In Persistent Dirs Not /tmp"](../agents/tooling.md))

**Branch:** `feat/recall-tool` (off `main` @ `e91f3a4`; design doc @ `d78ab50` already on branch)

---

## Conventions (apply to every task)

- `env -u NODE_ENV` on every npm/npx/vitest invocation (NODE_ENV=production breaks vitest under the systemd-running ytsejam env).
- `GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no` on every git invocation.
- `.ts` extension on every relative source import.
- WIP-commit owned changes BEFORE any long-running verification.
- One PR for the whole feature; commit per task; squash on merge.
- BRIEF-AUTHOR (Mentat) RE-GREPS HEAD before dispatching each task — the design doc was authored before some of the symbols existed (notably `getLtm` is a phantom API; Task 1 creates it).
- IMPLEMENTER STOP-on-bug-signal: if a failing test points at production code outside this task's scope, STOP, report the falsifying observation + minimal candidate fix, ask lead for split-vs-bundle.

---

## Task 1: Add `getLtm()` read accessor to memory module

**Why this task exists:** the design doc references `memory.getLtm()` but the function does NOT exist in HEAD. Only the setter `attachLtm(ltm)` is exported; the private module-level `attachedLtm` variable has no read accessor. Recall needs one. Symmetric API hygiene.

**Files:**
- Modify: `server/src/memory/index.ts` (add after the existing `attachLtm` at line 90)
- Test: `server/test/memory/lifecycle.test.ts` (extend existing — has the right setup pattern)

### Step 1: Add the failing test

Append to `server/test/memory/lifecycle.test.ts`, inside the existing `describe("memory lifecycle", ...)` block (verify the block name with `grep -nE 'describe\\(' server/test/memory/lifecycle.test.ts` first):

```ts
  describe("getLtm read accessor", () => {
    it("returns null when no LTM is attached", () => {
      // belt-and-suspenders: another test may have left state dirty
      attachLtm(null);
      expect(memory.getLtm()).toBeNull();
    });

    it("returns the attached MemorySystem instance", async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "ltm-getltm-"));
      const ltm = MemorySystem.open({ storeDir });
      try {
        attachLtm(ltm);
        expect(memory.getLtm()).toBe(ltm); // identity, not just equality
      } finally {
        attachLtm(null);
        ltm.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    });

    it("returns null after detach", async () => {
      const storeDir = await mkdtemp(join(tmpdir(), "ltm-getltm-"));
      const ltm = MemorySystem.open({ storeDir });
      try {
        attachLtm(ltm);
        attachLtm(null);
        expect(memory.getLtm()).toBeNull();
      } finally {
        ltm.close();
        await rm(storeDir, { recursive: true, force: true });
      }
    });
  });
```

Imports to add at the top of the file if not present (grep first):
- `import * as memory from "../../src/memory/index.ts";` (the test currently imports specific symbols; we also need the namespace for `memory.getLtm`)
- `mkdtemp`, `rm` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `MemorySystem` from `ltm` — all may already be there.

### Step 2: Run the test to verify it fails

```
cd ~/projects/.worktrees/recall-tool
env -u NODE_ENV npx vitest run server/test/memory/lifecycle.test.ts -t "getLtm read accessor"
```

Expected: 3 failures with `TypeError: memory.getLtm is not a function` (or similar).

### Step 3: Add the implementation

In `server/src/memory/index.ts`, immediately after the existing `attachLtm` block (around line 92):

```ts
/**
 * Read-side accessor for the attached LTM MemorySystem. Returns null when
 * none is attached. Symmetric with attachLtm; needed by recall() so the
 * recall module doesn't need access to the module-private attachedLtm.
 */
export function getLtm(): MemorySystem | null {
  return attachedLtm;
}
```

### Step 4: Run the test to verify it passes

```
env -u NODE_ENV npx vitest run server/test/memory/lifecycle.test.ts -t "getLtm read accessor"
```

Expected: 3 passing.

### Step 5: Run full server test suite to confirm no regression

```
env -u NODE_ENV npx vitest run server/test
```

Expected: all green, +3 tests over baseline.

### Step 6: Commit

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git add server/src/memory/index.ts server/test/memory/lifecycle.test.ts
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git commit -m "feat(memory): add getLtm() read accessor

Symmetric with attachLtm(). Needed by recall() in PR 3 so the recall
module doesn't have to reach into the memory module's private state.

3 new tests cover null-when-detached, identity-when-attached,
null-after-detach.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Implement `recall.ts` module + tests

**Files:**
- Create: `server/src/memory/recall.ts`
- Create: `server/test/memory/recall.test.ts`

### Step 1: Write the failing tests

Create `server/test/memory/recall.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySystem } from "ltm";
import * as memory from "../../src/memory/index.ts";
import { attachLtm, recordObservation } from "../../src/memory/index.ts";
import { recall } from "../../src/memory/recall.ts";

let memRoot = "";
let ltmDir = "";
let ltm: MemorySystem | null = null;

async function setupMemRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-recall-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: root });
  return root;
}

beforeEach(async () => {
  attachLtm(null);
  memRoot = await setupMemRoot();
  ltmDir = await mkdtemp(join(tmpdir(), "ltm-recall-"));
  ltm = MemorySystem.open({ storeDir: ltmDir });
  attachLtm(ltm);
});

afterEach(async () => {
  attachLtm(null);
  if (ltm) {
    ltm.close();
    ltm = null;
  }
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (memRoot) await rm(memRoot, { recursive: true, force: true });
  if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
});

describe("recall", () => {
  // Case 1
  it("alternates cog and ltm hits in strict order when both have results", async () => {
    // Seed 3 cog observations that ALSO mirror into LTM via recordObservation
    // (so cog+ltm both have these 3, plus origin-linked → dedupe will drop the
    // ltm copies). To get pure LTM-only records that ALSO match the query,
    // seed 3 more directly via ltm.recordObservation with synthetic origins
    // that don't match any cog path.
    for (let i = 0; i < 3; i++) {
      await recordObservation({
        domainPath: "cog-meta",
        text: `recall-test alpha ${i}`,
        tags: ["recall-test"],
      });
    }
    for (let i = 0; i < 3; i++) {
      await ltm!.recordObservation({
        origin: `cog:ltm-only/observations.md#fake${i}`,
        text: `recall-test alpha ltmonly ${i}`,
        tags: ["recall-test", "ltm-only"],
        timestamp: new Date().toISOString(),
        salience: 0.85,
      });
    }
    const result = await recall("alpha");
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
    // strict alternation: first hit is cog, then ltm, then cog, ...
    expect(result.hits[0].from).toBe("cog");
    if (result.hits.length >= 2) expect(result.hits[1].from).toBe("ltm");
    if (result.hits.length >= 3) expect(result.hits[2].from).toBe("cog");
    if (result.hits.length >= 4) expect(result.hits[3].from).toBe("ltm");
  });

  // Case 2
  it("dedupes the ltm hit when its origin matches a cog hit's path", async () => {
    await recordObservation({
      domainPath: "cog-meta",
      text: "unique-dedupe-marker-2026 something to find",
      tags: ["dedupe-test"],
    });
    const result = await recall("unique-dedupe-marker-2026");
    // Both substrates have it (cog wrote it, mirror put it in ltm).
    // After dedupe, only the cog copy survives.
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].from).toBe("cog");
    expect(result.dropped).toBe(1);
  });

  // Case 3
  it("passes the stale flag through from LTM dormant facts", async () => {
    // Seed an LTM record with a stale-eligible profile shape, force its
    // retrieve to return stale. Use semantic facts via direct ingestion.
    // Simplest: seed a record + advance the clock by 100 days so decay
    // pushes it below the dormancy threshold; query its slot.
    // Use mem.recordObservation with very old timestamp + low salience.
    const oldTimestamp = "2025-01-01T00:00:00.000Z";
    await ltm!.recordObservation({
      origin: "cog:stale-test/observations.md#old123",
      text: "stale-marker-xyz this is a dormant memory",
      tags: ["stale-test"],
      timestamp: oldTimestamp,
      salience: 0.1,
    });
    // Retrieve via recall; if LTM marks it stale, recall propagates.
    const result = await recall("stale-marker-xyz");
    // Lenient: a stale flag may not be set depending on decay config.
    // If LTM returned the hit, the stale field should match the LTM item's stale field.
    const ltmHit = result.hits.find((h) => h.from === "ltm");
    if (ltmHit && ltmHit.stale !== undefined) {
      expect(typeof ltmHit.stale).toBe("boolean");
    }
    // Stronger assertion: if we can directly verify via ltm.retrieve, do that.
    const direct = await ltm!.retrieve("stale-marker-xyz", { k: 5 });
    const directItem = direct.items.find((i) => "origin" in i.record && i.record.origin === "cog:stale-test/observations.md#old123");
    if (directItem && directItem.stale === true) {
      expect(ltmHit?.stale).toBe(true);
    }
  });

  // Case 4
  it("returns ltm-only hits when cog has no matches", async () => {
    await ltm!.recordObservation({
      origin: "cog:ltm-only/observations.md#abc",
      text: "uniqueltmonlymarker something distinctive",
      tags: ["ltm-only"],
      timestamp: new Date().toISOString(),
      salience: 0.85,
    });
    const result = await recall("uniqueltmonlymarker");
    expect(result.cogCount).toBe(0);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((h) => h.from === "ltm")).toBe(true);
  });

  // Case 5
  it("returns cog-only hits when LTM is not attached", async () => {
    attachLtm(null); // detach mid-test
    await recordObservation({
      domainPath: "cog-meta",
      text: "cog-only-marker-9876 looking for this",
      tags: ["cog-only"],
    });
    const result = await recall("cog-only-marker-9876");
    expect(result.ltmCount).toBe(0);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((h) => h.from === "cog")).toBe(true);
  });

  // Case 6
  it("returns empty envelope when both substrates miss", async () => {
    const result = await recall("nonexistent-query-no-match-12345");
    expect(result.hits).toEqual([]);
    expect(result.cogCount).toBe(0);
    expect(result.ltmCount).toBe(0);
    expect(result.dropped).toBe(0);
  });

  // Case 7
  it("populates tags on cog hits parsed as observations", async () => {
    await recordObservation({
      domainPath: "cog-meta",
      text: "tag-extract-marker abcdef",
      tags: ["alpha", "beta"],
    });
    const result = await recall("tag-extract-marker");
    const cogHit = result.hits.find((h) => h.from === "cog");
    expect(cogHit).toBeDefined();
    expect(cogHit?.tags).toEqual(["alpha", "beta"]);
  });

  // Case 8
  it("OMITS tags on cog hits that don't parse as observations (mutant-kill via 'tags' in hit)", async () => {
    // Write a wiki page (not observation-shaped)
    await memory.write(
      "wiki/projects/recall-test/notes.md",
      "# notes\n\nwiki-page-marker some plain prose without observation shape.\n",
    );
    const result = await recall("wiki-page-marker");
    const cogHit = result.hits.find((h) => h.from === "cog");
    expect(cogHit).toBeDefined();
    // Mutant-kill: 'tags' must NOT be a property of the hit, even undefined.
    expect("tags" in (cogHit as object)).toBe(false);
  });

  // Case 9
  it("swallows substrate errors and returns results from the working substrate", async () => {
    // Mock memory.search to throw
    const spy = vi.spyOn(memory, "search").mockRejectedValueOnce(new Error("synthetic search failure"));
    await ltm!.recordObservation({
      origin: "cog:err-test/observations.md#err",
      text: "error-swallow-marker still findable",
      tags: ["err-test"],
      timestamp: new Date().toISOString(),
      salience: 0.85,
    });
    const result = await recall("error-swallow-marker");
    expect(result.cogCount).toBe(0);
    expect(result.hits.some((h) => h.from === "ltm")).toBe(true);
    spy.mockRestore();
    // NOTE for the implementer: after writing the recall.ts catch, MUTATION-TEST
    // this by temporarily removing the .catch() wrapper around memory.search()
    // and re-running this test. It MUST fail (the rejection propagates).
    // Once verified, restore the .catch().
  });

  // Case 10
  it("over-drops LTM hits from the same cog file (documents the path-prefix trade-off)", async () => {
    // Cog observation in domain-A/observations.md
    await recordObservation({
      domainPath: "cog-meta",
      text: "trade-off-marker first observation",
      tags: ["trade-off"],
    });
    // LTM-only record with origin pointing at the SAME cog path but different sha
    await ltm!.recordObservation({
      origin: "cog:cog-meta/observations.md#differentsha",
      text: "trade-off-marker totally distinct ltm content",
      tags: ["trade-off"],
      timestamp: new Date().toISOString(),
      salience: 0.85,
    });
    const result = await recall("trade-off-marker");
    // 1 cog hit + 1 ltm hit (different text!) → dedupe drops the ltm one
    // because its origin starts with "cog:cog-meta/observations.md"
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    // The surviving hits should not include the "totally distinct ltm content"
    expect(result.hits.find((h) => h.text.includes("totally distinct"))).toBeUndefined();
  });
});
```

### Step 2: Run the tests to verify they fail

```
env -u NODE_ENV npx vitest run server/test/memory/recall.test.ts
```

Expected: cannot import `recall` from `server/src/memory/recall.ts` (module does not exist).

### Step 3: Write the implementation

Create `server/src/memory/recall.ts`:

```ts
/**
 * recall(query) — unified recall across cog full-text search and LTM
 * semantic retrieve. Returns interleaved hits from both substrates, deduped
 * by origin (cog path wins on collision).
 *
 * Design: docs/plans/2026-06-13-recall-tool-design.md
 *
 * FILTER PARAMETER DEFERRED: this version takes only a query string. Filter
 * support (filterTags, scopePaths) was deferred from PR 3 — the two
 * substrates use different coordinate systems (LTM tags vs cog paths) and
 * conflating them in a single param is a footgun. When usage data shows
 * agents want scoped recall, add SEPARATE filterTags (LTM-only) and
 * scopePaths (cog-only) parameters — never a single conflated one.
 *
 * Ordering: strict alternation cog[0], ltm[0], cog[1], ltm[1], ...
 * Cog has no native score so score-based merge would require inventing
 * one; that's a separate design problem. Score on each hit is informational.
 */

import { parseObservationLine } from "./bridge/ltm-observer.ts";
import * as memory from "./index.ts";

export type RecallHit = {
  from: "cog" | "ltm";
  text: string;
  /** "<path>:<line>" for cog, "ltm:<record.id>" for ltm. */
  where: string;
  /** cog=1.0 (informational), ltm=native retrieve score. */
  score: number;
  /** Pass-through from LTM (dormant fact / resurrected record). Absent on cog. */
  stale?: boolean;
  /** Populated when cog hit parses as observation OR LTM record carries tags. */
  tags?: string[];
};

export type RecallResult = {
  hits: RecallHit[];
  /** Total cog grep matches BEFORE truncation to top 5. */
  cogCount: number;
  /** LTM retrieve item count BEFORE dedupe. */
  ltmCount: number;
  /** LTM hits dropped by origin-based dedupe. */
  dropped: number;
};

const K = 5;

export async function recall(query: string): Promise<RecallResult> {
  // 1. Fan out to both substrates, swallowing per-substrate errors.
  const cogRaw = await memory.search(query).catch((err: Error) => {
    console.warn("[recall] cog search failed:", err.message);
    return { results: [], count: 0 };
  });
  const ltm = memory.getLtm();
  const ltmRaw = ltm
    ? await ltm.retrieve(query, { k: K }).catch((err: Error) => {
        console.warn("[recall] ltm retrieve failed:", err.message);
        return { items: [] as Array<{ record: any; score: number; stale?: boolean }>, profile: null as any };
      })
    : { items: [] as Array<{ record: any; score: number; stale?: boolean }>, profile: null as any };

  // 2. Normalize cog hits (top K). Parse observation-shaped lines for tags.
  const cogHits: RecallHit[] = cogRaw.results.slice(0, K).map((r) => {
    const parsed = parseObservationLine(r.text);
    const hit: RecallHit = {
      from: "cog",
      text: r.text.trim(),
      where: `${r.path}:${r.line}`,
      score: 1.0,
    };
    if (parsed) hit.tags = parsed.tags;
    return hit;
  });

  // 3. Build origin-prefix set from cog hits for dedupe.
  //    "cog-meta/observations.md:14" -> "cog:cog-meta/observations.md"
  const cogOriginPrefixes = new Set(
    cogHits.map((h) => `cog:${h.where.split(":")[0]}`),
  );

  // 4. Normalize LTM hits, dropping those whose origin starts with a cog
  //    prefix we already have. Non-observation records have no origin -> kept.
  let dropped = 0;
  const ltmHits: RecallHit[] = [];
  for (const item of ltmRaw.items.slice(0, K)) {
    const record = item.record;
    if (record.kind === "observation" && record.origin) {
      const prefix = record.origin.split("#")[0];
      if (cogOriginPrefixes.has(prefix)) {
        dropped++;
        continue;
      }
    }
    const hit: RecallHit = {
      from: "ltm",
      text: (record.text ?? "").trim(),
      where: `ltm:${record.id}`,
      score: item.score,
    };
    if (item.stale) hit.stale = true;
    if (Array.isArray(record.tags) && record.tags.length > 0) {
      hit.tags = record.tags;
    }
    ltmHits.push(hit);
  }

  // 5. Interleave: cog[0], ltm[0], cog[1], ltm[1], ...
  const hits: RecallHit[] = [];
  const maxLen = Math.max(cogHits.length, ltmHits.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < cogHits.length) hits.push(cogHits[i]);
    if (i < ltmHits.length) hits.push(ltmHits[i]);
  }

  return {
    hits,
    cogCount: cogRaw.count,
    ltmCount: ltmRaw.items.length,
    dropped,
  };
}
```

### Step 4: Run the tests to verify they pass

```
env -u NODE_ENV npx vitest run server/test/memory/recall.test.ts
```

Expected: 10/10 passing.

### Step 5: Mutation-test the substrate-error-swallow (case 9)

This is a REQUIRED quality check, not optional. Temporarily edit `server/src/memory/recall.ts` and REMOVE the `.catch(...)` around `memory.search(query)`:

```ts
const cogRaw = await memory.search(query);  // no .catch
```

Re-run case 9:
```
env -u NODE_ENV npx vitest run server/test/memory/recall.test.ts -t "swallows substrate errors"
```

Expected: case 9 FAILS (the rejection propagates, breaking `recall`). If it still passes, the assertion is asserting on a path that runs without the protection — the test is broken. Restore the `.catch` and reconsider the assertion.

After verifying the mutant kills the test, RESTORE the `.catch(...)`:
```ts
const cogRaw = await memory.search(query).catch((err: Error) => { ... });
```

### Step 6: Run full server test suite to confirm no regression

```
env -u NODE_ENV npx vitest run server/test
```

Expected: all green, +10 tests over Task 1's baseline.

### Step 7: Commit

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git add server/src/memory/recall.ts server/test/memory/recall.test.ts
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git commit -m "feat(memory): add recall(query) unified cross-substrate function

Implements PR 3 of the cog-LTM bridge roadmap. Returns interleaved hits
from cog full-text search + LTM semantic retrieve, deduped by origin
(cog:<path> prefix), normalized to {from, text, where, score, stale?, tags?}.

Filter parameter deferred to a future PR; documented in JSDoc.

10 new tests cover alternation, dedupe, stale pass-through, empty sides,
tag extraction, OMIT semantics, error swallow, over-drop trade-off.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Wire `recall` as an agent tool

**Files:**
- Modify: `server/src/tools/cog.ts` (add `recall` entry to `createCogTools()` return list)
- Test: `server/test/tools/cog.test.ts` if exists, else add to a sensible neighbor.

### Step 1: Find the registration site

```
grep -nE "createCogTools|name: \"cog_search\"" server/src/tools/cog.ts
```

The new tool entry goes immediately after `cog_search` to keep "search-like things" clustered.

### Step 2: Write the failing test

Look for an existing `server/test/tools/cog.test.ts`:

```
ls server/test/tools/
```

If it exists, append. If not, create `server/test/tools/cog.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { createCogTools } from "../../src/tools/cog.ts";

describe("cog tools", () => {
  it("registers a recall tool alongside cog_search", () => {
    const tools = createCogTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("cog_search");
    expect(names).toContain("recall");
  });

  it("recall tool has a clear description distinguishing it from cog_search", () => {
    const tools = createCogTools();
    const recallTool = tools.find((t) => t.name === "recall");
    expect(recallTool).toBeDefined();
    expect(recallTool!.description.toLowerCase()).toContain("ltm");
    // Should mention BOTH substrates so the agent knows it's unified
    expect(recallTool!.description.toLowerCase()).toMatch(/cog|notes/);
  });

  it("recall tool exposes a query: string parameter", () => {
    const tools = createCogTools();
    const recallTool = tools.find((t) => t.name === "recall");
    // The exact param shape depends on TypeBox encoding; verify via execute call
    expect(recallTool?.parameters).toBeDefined();
  });
});
```

### Step 3: Run to verify failure

```
env -u NODE_ENV npx vitest run server/test/tools/cog.test.ts
```

Expected: 3 failures — `recall` not in tool list, description undefined, etc.

### Step 4: Add the tool registration

In `server/src/tools/cog.ts`, immediately after the `cog_search` tool entry (around the section beginning with `name: "cog_search"`), add:

```ts
    {
      name: "recall",
      label: "Recall from memory",
      description:
        "Unified recall across cog notes and long-term memory (LTM). Returns interleaved hits from both substrates labeled by source ('cog' or 'ltm'), deduped by content origin. Use when you want to know what we know about something without caring which substrate it lives in. For grep-style search of cog notes only, use cog_search.",
      parameters: searchParams, // {query: Type.String()} — same shape as cog_search
      execute: async (_id, p) => {
        const { query } = p as { query: string };
        const { recall } = await import("../memory/recall.ts");
        const r = await recall(query);
        return jsonResult(r);
      },
    },
```

(Verify `searchParams` is in scope — `grep -nE 'searchParams' server/src/tools/cog.ts`. If not, declare alongside or reuse `Type.Object({query: Type.String()})`.)

### Step 5: Run the tests to verify pass

```
env -u NODE_ENV npx vitest run server/test/tools/cog.test.ts
```

Expected: all 3 passing.

### Step 6: Run full server test suite

```
env -u NODE_ENV npx vitest run server/test
```

Expected: all green.

### Step 7: Commit

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git add server/src/tools/cog.ts server/test/tools/cog.test.ts
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git commit -m "feat(tools): register recall as an agent tool

Adds recall to createCogTools() alongside cog_search. The tool description
explains it spans both substrates so the agent picks it for unified queries
and cog_search for grep-only.

3 new tests verify registration + description content + parameter shape.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Docs + smoke + open PR

**Files:**
- Modify: `server/src/memory/README.md` (add recall section if README exists; verify with `ls server/src/memory/README.md`)
- Modify: `docs/plans/2026-06-13-cog-ltm-bridge.md` (check off PR 3 task list items with implementing shas)
- Modify: `package.json` (no new script needed; recall is invoked via the agent tool — not a CLI)

### Step 1: Add a recall section to server/src/memory/README.md

After confirming the README exists, append a new section:

````markdown
## `recall(query)` — unified cross-substrate recall

A single async function that queries BOTH cog full-text search and LTM
semantic retrieve, normalizing results into one labeled shape and deduping
by origin.

```ts
import { recall } from "./recall.ts";

const result = await recall("bridge1 substrate validation");
// {
//   hits: [
//     { from: "cog", text: "...", where: "cog-meta/observations.md:14", score: 1.0, tags: [...] },
//     { from: "ltm", text: "...", where: "ltm:obs-abc123", score: 0.87 },
//     ...
//   ],
//   cogCount: 3,      // total cog grep matches (before top-5 truncation)
//   ltmCount: 5,      // LTM items before dedupe
//   dropped: 2,       // LTM hits dropped on origin path match
// }
```

**Ordering:** strict alternation: `cog[0], ltm[0], cog[1], ltm[1], ...`. When
one substrate runs out, the other's remainder follows. Score is
informational (cog=1.0, LTM=native retrieve score), NOT used for ordering.

**Dedupe:** origin-based using path prefix. When an LTM record's
`origin` starts with `cog:<path>` and a cog hit exists at `<path>:<line>`,
the LTM hit drops. Conservative: this can over-drop when cog+LTM hold
different content from the same file. Trade-off accepted — see design doc.

**Filter parameter:** intentionally not in this version. See JSDoc on
`recall.ts` for the deferral rationale.

**Surface:** registered as agent tool `recall` in `createCogTools()`
(`server/src/tools/cog.ts`).
````

### Step 2: Check off PR 3 task list in the roadmap

Open `docs/plans/2026-06-13-cog-ltm-bridge.md`. Find the `## PR 3` section. Check off each task line:
- `- [x] New file server/src/memory/recall.ts (~80 LOC). **<sha-Task2>**`
- `- [x] Implement interleave-top-k merge ... **<sha-Task2>**`
- `- [x] Filter pass-through ... ` → REPLACE the bullet text with: `- [x] ~~Filter pass-through~~ **DEFERRED** — see design doc §"Non-goals"; revisit when usage data shows agents want scoped recall. **<sha-Task2>**`
- `- [x] Result shape ... **<sha-Task2>**`
- `- [x] Register as agent tool ... **<sha-Task3>**`
- `- [x] Tests: ...` (each sub-bullet, point at the relevant test case in recall.test.ts)
- `- [x] Manual smoke ...` (point at the smoke that PR description includes)

Replace `<sha-TaskN>` with the actual commit shas (`git log --oneline -5`).

### Step 3: Independently re-run the gate from a clean local clone perspective

```bash
cd ~/projects/.worktrees/recall-tool
time bash scripts/gate.sh
```

Expected: PASS, +16 tests over `e91f3a4` baseline (3 from Task 1 + 10 from Task 2 + 3 from Task 3).

### Step 4: Push branch and open PR

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git push -u origin feat/recall-tool
```

Write PR body to `/tmp/pr-body-recall-tool.md`:

```markdown
# `recall(query)` agent tool (PR 3 of cog-LTM bridge roadmap)

**Spec:** [docs/plans/2026-06-13-recall-tool-design.md](https://github.com/bketelsen/ytsejam/blob/feat/recall-tool/docs/plans/2026-06-13-recall-tool-design.md)
**Plan:** [docs/plans/2026-06-13-recall-tool-plan.md](https://github.com/bketelsen/ytsejam/blob/feat/recall-tool/docs/plans/2026-06-13-recall-tool-plan.md)
**Predecessor:** #96 (Bridge 1 — recordObservation + reconciler), shipped 2026-06-13.

## What this adds

A single async function `recall(query)` and an agent tool of the same name that returns interleaved hits from BOTH:
- **cog** (full-text grep over markdown notes), and
- **LTM** (semantic retrieve, with profile fact promotion and decay-aware scoring)

deduped by content origin (cog wins on path match), in a normalized shape.

```ts
{
  hits: [{from, text, where, score, stale?, tags?}, ...],
  cogCount, ltmCount, dropped
}
```

## Design highlights

| Decision | Choice |
|---|---|
| Dedupe | Origin-based, cog wins on path-prefix match |
| Ordering | Strict alternation; score informational only |
| Filter param | DEFERRED — see design doc §"Non-goals" |
| LTM surface change | None — narrow `record.kind` at call site |
| Tool name | `recall` (no prefix; spans substrates) |

## Substrate validation

Bridge 1 was substrate-validated live before this PR:
- 2026-06-13 06:51: wrote test observation through `cog_append("cog-meta/observations.md", ...)`.
- Inline mirror landed in `~/.ytsejam/data/ltm/episodic.jsonl` as `obs-c3f2962779f0` within milliseconds.
- Reconciler back-filled ~178 historical observations from cog into LTM (cog memory dir → LTM episodic) on first boot.

## Tests

- +3 lifecycle tests (`getLtm()` accessor)
- +10 recall behavior tests (alternation, dedupe, stale, empty sides, tags, error swallow, over-drop trade-off doc)
- +3 cog-tool registration tests
- Total: +16, gate green.

Substrate-error-swallow test (case 9) was mutation-tested per docs/agents/testing.md — temporarily removed the `.catch` and verified the assertion fails.

## Manual smoke (Brian, post-merge)

In a fresh ytsejam session: `recall("bridge1 substrate-validation smoke")`.
Expected: cog hit at `cog-meta/observations.md:<line>`, `dropped >= 1` (LTM dup `obs-c3f2962779f0` dropped), final hit count reflects cog win.

## Roadmap

After this ships:
- **PR 2** (next): LTM fact promotion → cog observation. Bridge 1 + recall both live; promotion gates can be tuned against real data.
- Future filter param (deferred): revisit when there's evidence agents want scoped recall.
```

Then open the PR:

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no gh pr create \
  --base main \
  --head feat/recall-tool \
  --title "feat(memory): recall(query) unified cross-substrate tool (PR 3 of cog-LTM roadmap)" \
  --body-file /tmp/pr-body-recall-tool.md
```

### Step 5: Commit docs + roadmap changes

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git add server/src/memory/README.md docs/plans/2026-06-13-cog-ltm-bridge.md docs/plans/2026-06-13-recall-tool-plan.md
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git commit -m "docs(recall): README section + roadmap PR 3 checkbox sweep

- server/src/memory/README.md: add recall section with usage, ordering,
  dedupe rules, filter-param deferral note.
- docs/plans/2026-06-13-cog-ltm-bridge.md: check off PR 3 task list with
  implementing shas; mark filter pass-through as DEFERRED with rationale.
- docs/plans/2026-06-13-recall-tool-plan.md: implementation plan for
  this PR (4 tasks, ~80 LOC + tests, ~150 LOC test).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

(NOTE: the plan was authored BEFORE Task 1; the plan doc commit goes LAST so the plan-doc commit can reference the actual implementation shas if useful. If markdown lint rejects the plan doc on commit, fix in place per lessons/planning.md.)

### Step 6: Push the doc commit, refresh PR

```bash
GIT_EDITOR=true GIT_MERGE_AUTOEDIT=no git push
```

PR auto-refreshes.

### Done when

- One PR opened, ytsejam gate (test suite) green.
- Tool appears in `createCogTools()` with the unified-recall description.
- Manual smoke documented in PR description for Brian to run post-merge.

---

## Lessons to batch (collect through dev loop, write all post-ship)

(Empty so far — will populate as the loop surfaces them.)
