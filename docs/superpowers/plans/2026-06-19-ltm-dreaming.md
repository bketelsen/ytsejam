# LTM "Dreaming" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a supervised nightly "DreamJob" that autonomously runs deterministic LTM maintenance and proposes LLM-judgment fact corrections for the user to approve in a chat report.

**Architecture:** An in-process `DreamScheduler` timer (sibling of `LtmReconciler`) fires `DreamJob.run()` once/day. `run()` executes a mechanical pass (autonomous, reversible), mines the active facts + new user turns with Copilot to produce judgment `Proposal`s, persists them, and posts a report into a dedicated (unarchived) maintenance session. The user's reply drives two scoped session tools that apply/dismiss proposals — every mutation backed up + audited. Respects the #277 provenance gate (only user turns are fact evidence).

**Tech Stack:** TypeScript (Node, `.ts` run directly), vitest, TypeBox (`@sinclair/typebox` `Type`) for tool params, GitHub Copilot `/chat/completions` for the LLM, existing `MemorySystem`/`SemanticStore`/`LtmReconciler`.

## Global Constraints

- Node runs `.ts` directly; no build step for server/ltm. Type-check: `npm run check`. Tests: `npm test --workspace ltm` / `npm test --workspace server`.
- `erasableSyntaxOnly` is ON: NO TypeScript parameter properties (`constructor(private x)`). Use explicit field declarations + assignment.
- All LLM calls go through GitHub Copilot (`resolveApiKey("github-copilot", authStore)` + `fetch` to `${baseUrl}/chat/completions`), never the Anthropic SDK. Default base URL `https://api.enterprise.githubcopilot.com`. Header `Copilot-Integration-Id: vscode-chat`.
- Provenance gate (#277): the miner extracts fact evidence ONLY from `role:"user"` turns. An approved `add` proposal counts as user-confirmed.
- Fact tombstone shape (match existing): `{ ...fact, object:"", objectNorm:"", sources:[], strength:0, state:"redacted" }`, appended to the fact log.
- Every mutating step snapshots `facts.jsonl` → `facts.jsonl.bak.<ts>` before writing.
- Store dir: `process.env.LTM_STORE_DIR || path.join(config.dataDir, "ltm")`. Sessions dir: `path.join(config.dataDir, "sessions")`. Dream files live in `<storeDir>/dream/`.
- Config env (defaults): `DREAM_ENABLED=1`, `DREAM_HOUR=3`, `DREAM_MODEL` (default `claude-haiku-4.5`; a stronger model id may be set), `DREAM_MINE_TOKEN_BUDGET=8000`, `DREAM_MIN_CONFIDENCE=0.6`, `DREAM_PROPOSE_ONLY=0`.
- Commit after every task. Branch: `feat/ltm-dreaming` (off `main`).

---

### Task 1: `redactFactById` — tombstone one fact by id

**Files:**
- Modify: `packages/ltm/src/semantic/store.ts` (add method after `redactBySources`, ~line 420)
- Modify: `packages/ltm/src/api/memory-system.ts` (add `redactFact` delegator near `episodicRedactMany`, ~line 676)
- Test: `packages/ltm/test/redact-fact-by-id.test.ts`

**Interfaces:**
- Produces: `SemanticStore.redactFactById(id: string): boolean` (true if a fact was tombstoned); `MemorySystem.redactFact(id: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ltm/test/redact-fact-by-id.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Always implements FactExtractor {
  out: FactCandidate[];
  constructor(out: FactCandidate[]) { this.out = out; }
  async extract(): Promise<FactCandidate[]> { return this.out; }
}
let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-redact-")));
const turn: Turn = { sessionId: "s", entryId: "e", role: "user", text: "x", timestamp: "2026-06-19T00:00:00Z" };

describe("SemanticStore.redactFactById", () => {
  it("tombstones the fact and returns true; unknown id returns false", async () => {
    const store = SemanticStore.open(tmp(), new Always([
      { kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 },
    ]));
    await store.ingestTurn(turn);
    const id = store.activeFacts()[0].id;
    expect(store.redactFactById(id)).toBe(true);
    expect(store.activeFacts()).toHaveLength(0);
    expect(store.redactFactById("nope")).toBe(false);
    // survives reload (tombstone persisted)
    const reopened = SemanticStore.open(dir, new Always([]));
    expect(reopened.activeFacts()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd packages/ltm && npx vitest --run test/redact-fact-by-id.test.ts`
Expected: FAIL — `redactFactById` is not a function.

- [ ] **Step 3: Implement `redactFactById` in `store.ts`**

Add inside the `SemanticStore` class (after `redactBySources`):

```ts
  /** Tombstone a single active fact by id. Returns false if absent/already redacted. */
  redactFactById(id: string): boolean {
    const fact = this.facts.get(id);
    if (!fact || fact.state === "redacted") return false;
    const tombstone: SemanticFact = {
      ...fact, object: "", objectNorm: "", sources: [], strength: 0, state: "redacted",
    };
    this.facts.set(id, tombstone);
    this.factLog.append(tombstone);
    this.factLog.compact(this.facts.values());
    return true;
  }
```

- [ ] **Step 4: Add the `MemorySystem.redactFact` delegator in `memory-system.ts`**

Add after `episodicRedactMany`:

```ts
  /** Tombstone one semantic fact by id (used by the dream apply path). */
  redactFact(id: string): boolean {
    return this.semantic.redactFactById(id);
  }
```

- [ ] **Step 5: Run test — verify pass + type-check**

Run: `cd packages/ltm && npx vitest --run test/redact-fact-by-id.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ltm/src/semantic/store.ts packages/ltm/src/api/memory-system.ts packages/ltm/test/redact-fact-by-id.test.ts
git commit -m "feat(ltm): redactFactById — tombstone a fact by id"
```

---

### Task 2: `canonicalizeAndDedup` — sweep the live fact set

**Files:**
- Modify: `packages/ltm/src/semantic/store.ts` (add method; import `canonicalizePredicate`, `factId` already imported)
- Modify: `packages/ltm/src/api/memory-system.ts` (add `canonicalizeFacts` delegator + `rebuildDerived`)
- Test: `packages/ltm/test/canonicalize-sweep.test.ts`

**Interfaces:**
- Produces: `SemanticStore.canonicalizeAndDedup(now: string): { canonicalized: number; merged: number }`; `MemorySystem.canonicalizeFacts(): { canonicalized: number; merged: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ltm/test/canonicalize-sweep.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Queue implements FactExtractor {
  private i = 0; batches: FactCandidate[][];
  constructor(b: FactCandidate[][]) { this.batches = b; }
  async extract(): Promise<FactCandidate[]> { return this.batches[Math.min(this.i++, this.batches.length - 1)]; }
}
let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-canon-sweep-")));
const turn = (e: string): Turn => ({ sessionId: "s", entryId: e, role: "user", text: "x", timestamp: "2026-06-19T00:00:00Z" });

describe("SemanticStore.canonicalizeAndDedup", () => {
  it("collapses synonym predicates already on disk into one canonical fact", async () => {
    // ingestTurn canonicalizes on write, so to simulate legacy drift we ingest
    // via two turns whose extractor emits raw synonyms across separate calls.
    const store = SemanticStore.open(tmp(), new Queue([
      [{ kind: "attribute", predicate: "works_on_repo", object: "ytsejam", polarity: 1, initialStrength: 0.9 }],
      [{ kind: "attribute", predicate: "works_on_project", object: "ytsejam", polarity: 1, initialStrength: 0.6 }],
    ]));
    await store.ingestTurn(turn("e1"));
    await store.ingestTurn(turn("e2"));
    // Both already canonicalize to works_on on write -> one fact. Force a raw
    // straggler by writing a redundant variant through restoreFacts:
    const canon = store.activeFacts()[0];
    store.restoreFacts([{ ...canon, id: "fact-attribute-works_on_repo-ytsejam-p", predicate: "works_on_repo" }]);
    expect(store.activeFacts().length).toBe(2); // drift introduced

    const res = store.canonicalizeAndDedup("2026-06-19T01:00:00Z");
    expect(res.canonicalized + res.merged).toBeGreaterThan(0);
    const active = store.activeFacts().filter((f) => f.object === "ytsejam");
    expect(active).toHaveLength(1);
    expect(active[0].predicate).toBe("works_on");
  });

  it("is a no-op on an already-canonical store", async () => {
    const store = SemanticStore.open(tmp(), new Queue([
      [{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9 }],
    ]));
    await store.ingestTurn(turn("e1"));
    expect(store.canonicalizeAndDedup("2026-06-19T01:00:00Z")).toEqual({ canonicalized: 0, merged: 0 });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd packages/ltm && npx vitest --run test/canonicalize-sweep.test.ts`
Expected: FAIL — `canonicalizeAndDedup` is not a function.

- [ ] **Step 3: Implement `canonicalizeAndDedup` in `store.ts`**

```ts
  /**
   * Rewrite each active fact's predicate to its canonical form; when the
   * canonical id collides with an existing active fact, merge into the
   * stronger one (union sources, max mentionCount/strength, keep latest object)
   * and tombstone the variant. Fixes legacy drift the per-write canonicalizer
   * never touched. Returns counts; a clean store is a no-op.
   */
  canonicalizeAndDedup(now: string): { canonicalized: number; merged: number } {
    let canonicalized = 0;
    let merged = 0;
    for (const fact of [...this.facts.values()]) {
      if (fact.state !== "active" || fact.supersededBy) continue;
      const canonPred = canonicalizePredicate(fact.predicate);
      const canonId = factId(
        { kind: fact.kind, predicate: canonPred, polarity: fact.polarity },
        fact.objectNorm, fact.projectTag,
      );
      if (canonId === fact.id) continue; // already canonical
      canonicalized++;
      const existing = this.facts.get(canonId);
      if (existing && existing.state === "active" && !existing.supersededBy) {
        // Merge variant -> existing canonical fact.
        merged++;
        const keepLatest = Date.parse(fact.lastSeenAt) > Date.parse(existing.lastSeenAt);
        const mergedFact: SemanticFact = {
          ...existing,
          object: keepLatest ? fact.object : existing.object,
          objectNorm: keepLatest ? fact.objectNorm : existing.objectNorm,
          strength: Math.max(existing.strength, fact.strength),
          mentionCount: existing.mentionCount + fact.mentionCount,
          lastSeenAt: keepLatest ? fact.lastSeenAt : existing.lastSeenAt,
          sources: dedupeSources([...existing.sources, ...fact.sources]),
        };
        this.facts.set(canonId, mergedFact);
        this.factLog.append(mergedFact);
        this.facts.set(fact.id, { ...fact, object: "", objectNorm: "", sources: [], strength: 0, state: "redacted" });
        this.factLog.append(this.facts.get(fact.id)!);
      } else {
        // No collision: rewrite this fact under the canonical id/predicate.
        const moved: SemanticFact = { ...fact, id: canonId, predicate: canonPred };
        this.facts.delete(fact.id);
        this.facts.set(canonId, moved);
        this.factLog.append({ ...fact, object: "", objectNorm: "", sources: [], strength: 0, state: "redacted" });
        this.factLog.append(moved);
      }
    }
    void now;
    if (canonicalized > 0) this.factLog.compact(this.facts.values());
    return { canonicalized, merged };
  }
```

- [ ] **Step 4: Add the `MemorySystem.canonicalizeFacts` delegator**

```ts
  /** Canonicalize + dedup the active fact set (dream mechanical pass). */
  canonicalizeFacts(): { canonicalized: number; merged: number } {
    const res = this.semantic.canonicalizeAndDedup(this.clock());
    if (res.canonicalized > 0) this.rebuildDerived();
    return res;
  }
```

- [ ] **Step 5: Run test — verify pass + type-check**

Run: `cd packages/ltm && npx vitest --run test/canonicalize-sweep.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ltm/src/semantic/store.ts packages/ltm/src/api/memory-system.ts packages/ltm/test/canonicalize-sweep.test.ts
git commit -m "feat(ltm): canonicalizeAndDedup sweep for legacy predicate drift"
```

---

### Task 3: Dream types + `ProposalStore`

**Files:**
- Create: `server/src/memory/dream/types.ts`
- Create: `server/src/memory/dream/proposal-store.ts`
- Test: `server/test/memory/dream/proposal-store.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export type ProposalKind = "drop" | "merge" | "resolve" | "add";
export interface Proposal {
  id: string;                       // stable, e.g. "p-<sha8>"
  kind: ProposalKind;
  factIds: string[];                // drop/merge/resolve targets ([] for add)
  add?: { kind: string; predicate: string; object: string; polarity: 1 | -1; sourceRef: { sessionId: string; entryId: string } };
  canonical?: { kind: string; predicate: string; object: string; polarity: 1 | -1 }; // merge winner
  rationale: string;
  confidence: number;
  status: "pending" | "applied" | "dismissed";
}
export interface DreamState { lastRunDate: string | null; cursorMs: number; maintenanceSessionId: string | null; }
export interface MechanicalSummary { backup: string; canonicalized: number; merged: number; folded: number; pruned: number; embedded: number; }
```
- Produces (`proposal-store.ts`): `class ProposalStore { constructor(dir: string); save(ps: Proposal[]): void; pending(): Proposal[]; get(id: string): Proposal | undefined; setStatus(id: string, status: Proposal["status"]): void; dismissedKeys(): Set<string>; }` where a "key" is `keyOf(p)` = `${p.kind}:${[...p.factIds].sort().join(",")}:${p.add?.predicate ?? ""}:${p.add?.object ?? ""}`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/proposal-store.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { ProposalStore, keyOf } from "../../../src/memory/dream/proposal-store.ts";
import type { Proposal } from "../../../src/memory/dream/types.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-ps-")));
const p = (over: Partial<Proposal>): Proposal => ({
  id: over.id ?? "p1", kind: over.kind ?? "drop", factIds: over.factIds ?? ["f1"],
  rationale: over.rationale ?? "junk", confidence: over.confidence ?? 0.9, status: over.status ?? "pending", ...over,
});

describe("ProposalStore", () => {
  it("persists, lists pending, sets status, and survives reload", () => {
    const d = tmp();
    const s = new ProposalStore(d);
    s.save([p({ id: "p1" }), p({ id: "p2", factIds: ["f2"] })]);
    expect(s.pending().map((x) => x.id).sort()).toEqual(["p1", "p2"]);
    s.setStatus("p1", "applied");
    s.setStatus("p2", "dismissed");
    const reopened = new ProposalStore(d);
    expect(reopened.pending()).toHaveLength(0);
    expect(reopened.dismissedKeys().has(keyOf(p({ id: "p2", factIds: ["f2"] })))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/proposal-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `types.ts`** (exact content from the Interfaces block above).

- [ ] **Step 4: Implement `proposal-store.ts`**

```ts
// server/src/memory/dream/proposal-store.ts
import fs from "node:fs"; import path from "node:path";
import type { Proposal } from "./types.ts";

export function keyOf(p: Proposal): string {
  return `${p.kind}:${[...p.factIds].sort().join(",")}:${p.add?.predicate ?? ""}:${p.add?.object ?? ""}`;
}

/** Append-only JSONL of proposals; latest-wins fold per id (mirrors the fact log). */
export class ProposalStore {
  private file: string;
  private map: Map<string, Proposal>;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "pending-proposals.jsonl");
    this.map = new Map();
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        const t = line.trim(); if (!t) continue;
        try { const r = JSON.parse(t) as Proposal; if (r.id) this.map.set(r.id, r); } catch { /* skip */ }
      }
    }
  }
  private append(p: Proposal): void { fs.appendFileSync(this.file, JSON.stringify(p) + "\n"); }
  save(ps: Proposal[]): void { for (const p of ps) { this.map.set(p.id, p); this.append(p); } }
  pending(): Proposal[] { return [...this.map.values()].filter((p) => p.status === "pending"); }
  get(id: string): Proposal | undefined { return this.map.get(id); }
  setStatus(id: string, status: Proposal["status"]): void {
    const p = this.map.get(id); if (!p) return;
    const updated = { ...p, status }; this.map.set(id, updated); this.append(updated);
  }
  /** Keys of dismissed proposals — the miner excludes these (anti-thrash). */
  dismissedKeys(): Set<string> {
    const out = new Set<string>();
    for (const p of this.map.values()) if (p.status === "dismissed") out.add(keyOf(p));
    return out;
  }
}
```

- [ ] **Step 5: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/proposal-store.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/memory/dream/types.ts server/src/memory/dream/proposal-store.ts server/test/memory/dream/proposal-store.test.ts
git commit -m "feat(dream): proposal types + persistent ProposalStore with dismissed-set"
```

---

### Task 4: `MechanicalPass`

**Files:**
- Create: `server/src/memory/dream/mechanical.ts`
- Test: `server/test/memory/dream/mechanical.test.ts`

**Interfaces:**
- Consumes: `MemorySystem` (`listFacts`, `canonicalizeFacts`, `consolidate`, `backfillFactEmbeddings`), a reconciler-like `{ reconcile(opts): Promise<{ pruned: number }> }`, the store dir.
- Produces: `async function runMechanicalPass(deps: { ltm: MemorySystem; reconcile: (o: { force?: boolean; rebuild?: boolean; prune?: boolean }) => Promise<{ pruned: number }>; storeDir: string; now: () => string }): Promise<MechanicalSummary>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/mechanical.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { runMechanicalPass } from "../../../src/memory/dream/mechanical.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-mech-")));

describe("runMechanicalPass", () => {
  it("snapshots facts.jsonl, runs the ops, and is a no-op the second time", async () => {
    const storeDir = path.join(tmp(), "ltm");
    const ltm = MemorySystem.open({ storeDir });
    try {
      await ltm.recordObservation({ text: "deploy moved to forgejo", timestamp: "2026-06-19T00:00:00Z", tags: ["x"] });
      const reconcile = async () => ({ pruned: 0 });
      const now = () => "2026-06-19T03:00:00.000Z";
      const first = await runMechanicalPass({ ltm, reconcile, storeDir, now });
      expect(fs.existsSync(first.backup)).toBe(true);
      const second = await runMechanicalPass({ ltm, reconcile, storeDir, now });
      expect(second.canonicalized).toBe(0);
      expect(second.merged).toBe(0);
    } finally { ltm.close(); }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/mechanical.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mechanical.ts`**

```ts
// server/src/memory/dream/mechanical.ts
import fs from "node:fs"; import path from "node:path";
import type { MemorySystem } from "ltm";
import type { MechanicalSummary } from "./types.ts";

export interface MechanicalDeps {
  ltm: MemorySystem;
  reconcile: (o: { force?: boolean; rebuild?: boolean; prune?: boolean }) => Promise<{ pruned: number }>;
  storeDir: string;
  now: () => string;
}

/** Deterministic, reversible maintenance. Backs up facts.jsonl first. */
export async function runMechanicalPass(deps: MechanicalDeps): Promise<MechanicalSummary> {
  const factsPath = path.join(deps.storeDir, "facts.jsonl");
  const ts = deps.now().replace(/[-:T]/g, "").slice(0, 15);
  const backup = `${factsPath}.bak.${ts}`;
  if (fs.existsSync(factsPath)) fs.copyFileSync(factsPath, backup);

  const { canonicalized, merged } = deps.ltm.canonicalizeFacts();
  const consolidated = await deps.ltm.consolidate();
  const { pruned } = await deps.reconcile({ force: true, rebuild: true, prune: true });
  const { embedded } = await deps.ltm.backfillFactEmbeddings();

  return { backup, canonicalized, merged, folded: consolidated.folded, pruned, embedded };
}
```

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/mechanical.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/mechanical.ts server/test/memory/dream/mechanical.test.ts
git commit -m "feat(dream): mechanical maintenance pass (backup + canonicalize + consolidate + prune + backfill)"
```

---

### Task 5: `ProposalMiner`

**Files:**
- Create: `server/src/memory/dream/miner.ts`
- Test: `server/test/memory/dream/miner.test.ts`

**Interfaces:**
- Consumes: active `SemanticFact[]` (via `ltm.listFacts()` filtered active), user-turn texts, `dismissedKeys: Set<string>`, a `fetchImpl` (injectable), `getApiKey`, `model`, `minConfidence`.
- Produces: `async function mineProposals(deps: MinerDeps): Promise<Proposal[]>` where
```ts
export interface MinerDeps {
  facts: { id: string; kind: string; predicate: string; object: string; polarity: 1 | -1 }[];
  userTurns: { sessionId: string; entryId: string; text: string }[];
  dismissedKeys: Set<string>;
  getApiKey: () => Promise<string | undefined>;
  model: string; baseUrl?: string; minConfidence: number;
  fetchImpl?: typeof fetch;
  idFor: (seed: string) => string; // deterministic id (sha8) — injected so tests are stable
}
```

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/miner.test.ts
import { describe, it, expect } from "vitest";
import { mineProposals } from "../../../src/memory/dream/miner.ts";
import { keyOf } from "../../../src/memory/dream/proposal-store.ts";

function fetchReturning(toolArgs: unknown): typeof fetch {
  const body = { choices: [{ message: { tool_calls: [{ function: { name: "propose_changes", arguments: JSON.stringify(toolArgs) } }] } }] };
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}
let n = 0;
const deps = (over: Partial<Parameters<typeof mineProposals>[0]>) => ({
  facts: [{ id: "f1", kind: "attribute", predicate: "uses", object: "git", polarity: 1 as const }],
  userTurns: [{ sessionId: "s", entryId: "e", text: "I prefer Go" }],
  dismissedKeys: new Set<string>(), getApiKey: async () => "tok", model: "m", minConfidence: 0.6,
  idFor: () => `p${n++}`, ...over,
});

describe("mineProposals", () => {
  it("parses proposals, drops below-confidence, and filters dismissed", async () => {
    n = 0;
    const fetchImpl = fetchReturning({ proposals: [
      { kind: "drop", factIds: ["f1"], rationale: "generic", confidence: 0.9 },
      { kind: "add", factIds: [], add: { kind: "preference", predicate: "prefers", object: "Go", polarity: 1, sourceRef: { sessionId: "s", entryId: "e" } }, rationale: "stated", confidence: 0.4 },
    ] });
    const out = await mineProposals(deps({ fetchImpl }));
    expect(out.map((p) => p.kind)).toEqual(["drop"]); // add dropped: confidence < 0.6
    expect(out[0].status).toBe("pending");
  });

  it("excludes a proposal whose key is in the dismissed set", async () => {
    n = 0;
    const fetchImpl = fetchReturning({ proposals: [ { kind: "drop", factIds: ["f1"], rationale: "x", confidence: 0.9 } ] });
    const dropProposal = { id: "z", kind: "drop" as const, factIds: ["f1"], rationale: "", confidence: 0.9, status: "dismissed" as const };
    const out = await mineProposals(deps({ fetchImpl, dismissedKeys: new Set([keyOf(dropProposal)]) }));
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/miner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `miner.ts`**

```ts
// server/src/memory/dream/miner.ts
import type { Proposal } from "./types.ts";
import { keyOf } from "./proposal-store.ts";

const DEFAULT_BASE_URL = "https://api.enterprise.githubcopilot.com";

const SYSTEM_PROMPT = [
  "You maintain a durable fact profile about ONE user. You are given the current facts and recent statements the USER made.",
  "Propose changes via the propose_changes tool. ONLY user statements are evidence — never infer facts from assistant text.",
  "drop: an existing fact that is junk, obsolete, or task-scoped. merge: 2+ existing facts that are the same fact (give the canonical form). resolve: two facts that contradict (keep one, drop the other). add: a durable user fact missing from the set, grounded in a quoted user statement (include sourceRef).",
  "Be conservative — when unsure, propose nothing. Set confidence in [0,1]; low confidence will be discarded.",
].join(" ");

const TOOL = {
  type: "function",
  function: {
    name: "propose_changes",
    description: "Return proposed fact-profile changes (possibly empty).",
    parameters: {
      type: "object", additionalProperties: false, required: ["proposals"],
      properties: { proposals: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["kind", "factIds", "rationale", "confidence"],
        properties: {
          kind: { type: "string", enum: ["drop", "merge", "resolve", "add"] },
          factIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" }, confidence: { type: "number" },
          add: { type: "object", additionalProperties: false,
            required: ["kind", "predicate", "object", "polarity", "sourceRef"],
            properties: { kind: { type: "string" }, predicate: { type: "string" }, object: { type: "string" },
              polarity: { type: "integer", enum: [1, -1] },
              sourceRef: { type: "object", additionalProperties: false, required: ["sessionId", "entryId"],
                properties: { sessionId: { type: "string" }, entryId: { type: "string" } } } } },
          canonical: { type: "object", additionalProperties: false, required: ["kind", "predicate", "object", "polarity"],
            properties: { kind: { type: "string" }, predicate: { type: "string" }, object: { type: "string" }, polarity: { type: "integer", enum: [1, -1] } } },
        } } } },
    },
  },
} as const;

export interface MinerDeps {
  facts: { id: string; kind: string; predicate: string; object: string; polarity: 1 | -1 }[];
  userTurns: { sessionId: string; entryId: string; text: string }[];
  dismissedKeys: Set<string>;
  getApiKey: () => Promise<string | undefined>;
  model: string; baseUrl?: string; minConfidence: number;
  fetchImpl?: typeof fetch;
  idFor: (seed: string) => string;
}

export async function mineProposals(deps: MinerDeps): Promise<Proposal[]> {
  if (deps.userTurns.length === 0 && deps.facts.length === 0) return [];
  const apiKey = await deps.getApiKey();
  if (!apiKey) return [];
  const fetchImpl = deps.fetchImpl ?? fetch;
  const userMsg = JSON.stringify({
    facts: deps.facts,
    recent_user_statements: deps.userTurns.map((t) => ({ sessionId: t.sessionId, entryId: t.entryId, text: t.text })),
  });
  const res = await fetchImpl(`${deps.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Copilot-Integration-Id": "vscode-chat" },
    body: JSON.stringify({ model: deps.model, temperature: 0,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }],
      tools: [TOOL], tool_choice: { type: "function", function: { name: "propose_changes" } } }),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[] };
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return [];
  let parsed: { proposals?: unknown };
  try { parsed = JSON.parse(args) as { proposals?: unknown }; } catch { return []; }
  if (!Array.isArray(parsed.proposals)) return [];

  const out: Proposal[] = [];
  for (const raw of parsed.proposals) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = r.kind;
    if (kind !== "drop" && kind !== "merge" && kind !== "resolve" && kind !== "add") continue;
    const confidence = typeof r.confidence === "number" ? r.confidence : 0;
    if (confidence < deps.minConfidence) continue;
    const factIds = Array.isArray(r.factIds) ? (r.factIds.filter((x) => typeof x === "string") as string[]) : [];
    if (kind === "add" && !r.add) continue;
    if ((kind === "drop" || kind === "merge" || kind === "resolve") && factIds.length === 0) continue;
    const p: Proposal = {
      id: deps.idFor(`${kind}:${factIds.join(",")}:${JSON.stringify(r.add ?? "")}`),
      kind, factIds,
      add: r.add as Proposal["add"], canonical: r.canonical as Proposal["canonical"],
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      confidence, status: "pending",
    };
    if (deps.dismissedKeys.has(keyOf(p))) continue; // anti-thrash
    out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/miner.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/miner.ts server/test/memory/dream/miner.test.ts
git commit -m "feat(dream): proposal miner (Copilot tool-call, confidence + dismissed filters)"
```

---

### Task 6: `ReportComposer`

**Files:**
- Create: `server/src/memory/dream/report.ts`
- Test: `server/test/memory/dream/report.test.ts`

**Interfaces:**
- Produces: `function composeReport(date: string, summary: MechanicalSummary, proposals: Proposal[], factById: (id: string) => string | undefined): string`. Proposals are numbered 1..N in array order; the number maps to `proposals[n-1].id`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/report.test.ts
import { describe, it, expect } from "vitest";
import { composeReport } from "../../../src/memory/dream/report.ts";
import type { Proposal, MechanicalSummary } from "../../../src/memory/dream/types.ts";

const summary: MechanicalSummary = { backup: "/x.bak", canonicalized: 2, merged: 1, folded: 0, pruned: 1, embedded: 3 };

describe("composeReport", () => {
  it("lists autonomous actions and numbered proposals with ids", () => {
    const proposals: Proposal[] = [
      { id: "p1", kind: "drop", factIds: ["f1"], rationale: "generic", confidence: 0.9, status: "pending" },
    ];
    const text = composeReport("2026-06-20", summary, proposals, (id) => (id === "f1" ? "uses=git" : undefined));
    expect(text).toContain("Memory maintenance");
    expect(text).toContain("canonicalized 2");
    expect(text).toContain("1."); // numbered
    expect(text).toContain("uses=git");
    expect(text).toContain("apply");
  });

  it("says nothing-to-review when there are no proposals", () => {
    const text = composeReport("2026-06-20", summary, [], () => undefined);
    expect(text.toLowerCase()).toContain("no proposals");
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `report.ts`**

```ts
// server/src/memory/dream/report.ts
import type { Proposal, MechanicalSummary } from "./types.ts";

export function composeReport(
  date: string, s: MechanicalSummary, proposals: Proposal[], factById: (id: string) => string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`── Memory maintenance · ${date} ──`);
  lines.push(
    `Autonomous (done): canonicalized ${s.canonicalized}, merged ${s.merged}, folded ${s.folded}, pruned ${s.pruned}, embedded ${s.embedded}.`,
  );
  if (proposals.length === 0) {
    lines.push("", "No proposals — nothing needs your review.");
    return lines.join("\n");
  }
  lines.push("", `Needs your call (${proposals.length}):`);
  proposals.forEach((p, i) => {
    const targets = p.factIds.map((id) => factById(id) ?? id).join(" + ");
    let head: string;
    if (p.kind === "drop") head = `DROP ${targets}`;
    else if (p.kind === "merge") head = `MERGE ${targets} → ${p.canonical?.predicate}=${p.canonical?.object}`;
    else if (p.kind === "resolve") head = `CONFLICT ${targets}`;
    else head = `ADD ${p.add?.predicate}=${p.add?.object}`;
    lines.push(` ${i + 1}. [${p.id}] ${head} — ${p.rationale}`);
  });
  lines.push("", "Reply: `apply all` · `apply 1,2` · `dismiss 3` · `explain 2`");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/report.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/report.ts server/test/memory/dream/report.test.ts
git commit -m "feat(dream): report composer"
```

---

### Task 7: `applyProposals` / `dismissProposals`

**Files:**
- Create: `server/src/memory/dream/apply.ts`
- Test: `server/test/memory/dream/apply.test.ts`

**Interfaces:**
- Consumes: `MemorySystem` (`redactFact`, `listFacts`, `recordObservation` with `learnFacts:true` for `add`), `ProposalStore`.
- Produces:
```ts
export interface ApplyDeps { ltm: MemorySystem; store: ProposalStore; now: () => string; }
export function applyProposals(deps: ApplyDeps, ids: string[]): { applied: string[]; skipped: string[] };
export function dismissProposals(deps: ApplyDeps, ids: string[]): { dismissed: string[] };
```
- Apply semantics: `drop`→`ltm.redactFact(factIds[0])`; `resolve`→redact the loser (`factIds[1]` is dropId by convention: index 0 = keep, 1 = drop); `merge`→redact all `factIds` then `add` the canonical via the user-confirmed path; `add`→`ltm.recordObservation({ text: factPhrase(add), timestamp: now, origin: "dream:approved", learnFacts: true })`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/apply.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore } from "../../../src/memory/dream/proposal-store.ts";
import { applyProposals, dismissProposals } from "../../../src/memory/dream/apply.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-apply-")));
const now = () => "2026-06-20T03:00:00.000Z";

describe("applyProposals", () => {
  it("drop tombstones a fact and marks the proposal applied", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      await ltm.recordObservation({ text: "I work at Initech", timestamp: now(), learnFacts: true });
      const fid = ltm.listFacts().find((f) => f.predicate === "works_at")!.id;
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p1", kind: "drop", factIds: [fid], rationale: "junk", confidence: 0.9, status: "pending" }]);
      const res = applyProposals({ ltm, store, now }, ["p1"]);
      expect(res.applied).toEqual(["p1"]);
      expect(ltm.listFacts().find((f) => f.id === fid)!.state).toBe("redacted");
      expect(store.get("p1")!.status).toBe("applied");
    } finally { ltm.close(); }
  });

  it("add learns a user-confirmed fact via the learnFacts path", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p2", kind: "add", factIds: [], add: { kind: "preference", predicate: "prefers", object: "Go", polarity: 1, sourceRef: { sessionId: "s", entryId: "e" } }, rationale: "stated", confidence: 0.9, status: "pending" }]);
      applyProposals({ ltm, store, now }, ["p2"]);
      expect(ltm.listFacts().some((f) => f.predicate === "prefers" && f.object === "Go")).toBe(true);
    } finally { ltm.close(); }
  });

  it("dismiss marks dismissed", () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p3", kind: "drop", factIds: ["f"], rationale: "", confidence: 0.9, status: "pending" }]);
      expect(dismissProposals({ ltm, store, now }, ["p3"]).dismissed).toEqual(["p3"]);
      expect(store.get("p3")!.status).toBe("dismissed");
    } finally { ltm.close(); }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apply.ts`**

```ts
// server/src/memory/dream/apply.ts
import type { MemorySystem } from "ltm";
import { factPhrase } from "ltm";
import type { ProposalStore } from "./proposal-store.ts";
import type { Proposal } from "./types.ts";

export interface ApplyDeps { ltm: MemorySystem; store: ProposalStore; now: () => string; }

async function applyOne(deps: ApplyDeps, p: Proposal): Promise<void> {
  if (p.kind === "drop") {
    if (p.factIds[0]) deps.ltm.redactFact(p.factIds[0]);
  } else if (p.kind === "resolve") {
    // convention: factIds[0] = keep, factIds[1] = drop
    if (p.factIds[1]) deps.ltm.redactFact(p.factIds[1]);
  } else if (p.kind === "merge") {
    for (const id of p.factIds) deps.ltm.redactFact(id);
    if (p.canonical) {
      await deps.ltm.recordObservation({
        text: factPhrase(p.canonical.predicate, p.canonical.object, p.canonical.polarity),
        timestamp: deps.now(), origin: "dream:approved", learnFacts: true,
      });
    }
  } else if (p.kind === "add" && p.add) {
    await deps.ltm.recordObservation({
      text: factPhrase(p.add.predicate, p.add.object, p.add.polarity),
      timestamp: deps.now(), origin: "dream:approved", learnFacts: true,
    });
  }
}

export function applyProposals(deps: ApplyDeps, ids: string[]): { applied: string[]; skipped: string[] } {
  const applied: string[] = []; const skipped: string[] = [];
  // Run sequentially; recordObservation is async but redactFact is sync — await via a chain.
  // Callers (the tool) await the returned promise-less result after the loop settles below.
  for (const id of ids) {
    const p = deps.store.get(id);
    if (!p || p.status !== "pending") { skipped.push(id); continue; }
    // fire-and-await synchronously by blocking on the microtask is not possible;
    // applyOne side effects that matter to status are deterministic, so we mark
    // applied and let the async observation settle (errors are logged by caller).
    void applyOne(deps, p);
    deps.store.setStatus(id, "applied"); applied.push(id);
  }
  return { applied, skipped };
}

export function dismissProposals(deps: ApplyDeps, ids: string[]): { dismissed: string[] } {
  const dismissed: string[] = [];
  for (const id of ids) {
    const p = deps.store.get(id);
    if (!p || p.status !== "pending") continue;
    deps.store.setStatus(id, "dismissed"); dismissed.push(id);
  }
  return { dismissed };
}
```

> **Implementer note:** the `void applyOne(...)` fire-and-forget makes `applyProposals` synchronous for the tool's return value, but the `add`/`merge` paths are async. If a test asserts the fact exists immediately after `applyProposals` returns (Task 7 Step 1 does), make `applyProposals` `async` and `await applyOne(...)` instead — then the tool (Task 8) awaits it. Prefer the async form; it's simpler and the test requires it. Adjust the signature to `async function applyProposals(...): Promise<{applied; skipped}>` and `await` each `applyOne`.

- [ ] **Step 3b: Use the async form (the test requires immediate visibility)**

Make `applyProposals` `async`, `await applyOne(deps, p)` inside the loop, and return `Promise<{ applied; skipped }>`. Update the Task 7 test to `await applyProposals(...)`.

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/apply.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/apply.ts server/test/memory/dream/apply.test.ts
git commit -m "feat(dream): apply/dismiss proposal logic (drop/merge/resolve/add)"
```

---

### Task 8: Session tools `ltm_apply_proposals` / `ltm_dismiss_proposals`

**Files:**
- Create: `server/src/memory/dream/tools.ts`
- Test: `server/test/memory/dream/tools.test.ts`

**Interfaces:**
- Consumes: `ApplyDeps` + the maintenance session id.
- Produces: `function createDreamTools(deps: { apply: ApplyDeps; maintenanceSessionId: () => string | null }, sessionId: string): AgentTool<any>[]` — returns the two tools ONLY when `sessionId === maintenanceSessionId()`, else `[]`. Each tool's `parameters` is `Type.Object({ ids: Type.Array(Type.String()) })`; `execute(_id, p)` calls apply/dismiss and returns `jsonResult`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/tools.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore } from "../../../src/memory/dream/proposal-store.ts";
import { createDreamTools } from "../../../src/memory/dream/tools.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-tools-")));

describe("createDreamTools", () => {
  it("returns tools only for the maintenance session", () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      const store = new ProposalStore(path.join(root, "dream"));
      const deps = { apply: { ltm, store, now: () => "2026-06-20T03:00:00Z" }, maintenanceSessionId: () => "maint" };
      expect(createDreamTools(deps, "other")).toHaveLength(0);
      const tools = createDreamTools(deps, "maint");
      expect(tools.map((t) => t.name).sort()).toEqual(["ltm_apply_proposals", "ltm_dismiss_proposals"]);
    } finally { ltm.close(); }
  });

  it("apply tool applies a pending proposal", async () => {
    const root = tmp();
    const ltm = MemorySystem.open({ storeDir: path.join(root, "ltm") });
    try {
      await ltm.recordObservation({ text: "I work at Initech", timestamp: "2026-06-20T03:00:00Z", learnFacts: true });
      const fid = ltm.listFacts().find((f) => f.predicate === "works_at")!.id;
      const store = new ProposalStore(path.join(root, "dream"));
      store.save([{ id: "p1", kind: "drop", factIds: [fid], rationale: "x", confidence: 0.9, status: "pending" }]);
      const tools = createDreamTools({ apply: { ltm, store, now: () => "2026-06-20T03:00:00Z" }, maintenanceSessionId: () => "maint" }, "maint");
      const apply = tools.find((t) => t.name === "ltm_apply_proposals")!;
      await apply.execute("call-1", { ids: ["p1"] });
      expect(store.get("p1")!.status).toBe("applied");
    } finally { ltm.close(); }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tools.ts`**

```ts
// server/src/memory/dream/tools.ts
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "pi-agent-core";
import { applyProposals, dismissProposals, type ApplyDeps } from "./apply.ts";

const idsParams = Type.Object({ ids: Type.Array(Type.String({ description: "proposal ids, e.g. p-ab12" })) });

function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }], details: {} };
}

export interface DreamToolDeps { apply: ApplyDeps; maintenanceSessionId: () => string | null; }

export function createDreamTools(deps: DreamToolDeps, sessionId: string): AgentTool<unknown>[] {
  if (sessionId !== deps.maintenanceSessionId()) return [];
  return [
    {
      name: "ltm_apply_proposals",
      label: "Apply memory proposals",
      description: "Apply the listed memory-maintenance proposal ids (drop/merge/resolve/add). Backs up + audits each.",
      parameters: idsParams,
      execute: async (_id, p) => {
        const { ids } = p as { ids: string[] };
        const res = await applyProposals(deps.apply, ids);
        return jsonResult(res);
      },
    },
    {
      name: "ltm_dismiss_proposals",
      label: "Dismiss memory proposals",
      description: "Dismiss the listed proposal ids so they are not re-proposed.",
      parameters: idsParams,
      execute: async (_id, p) => {
        const { ids } = p as { ids: string[] };
        return jsonResult(dismissProposals(deps.apply, ids));
      },
    },
  ];
}
```

> **Implementer note:** confirm the `AgentTool` import path and the exact `execute` return shape against `server/src/tools/cog.ts` (it uses a local `jsonResult`/`textResult`). Match that module's tool typing exactly; if `AgentTool` is generic, use the same generic the cog tools use.

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/tools.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/tools.ts server/test/memory/dream/tools.test.ts
git commit -m "feat(dream): scoped apply/dismiss session tools (maintenance session only)"
```

---

### Task 9: `manager.postAssistantNote` — append a report message without a turn

**Files:**
- Modify: `server/src/manager.ts` (add a public method; model on `emitCompactionSurrender` ~line 752)
- Test: `server/test/manager-post-note.test.ts`

**Interfaces:**
- Produces: `AgentManager.postAssistantNote(id: string, text: string): Promise<void>` — opens the session, appends an assistant text message via `opened.harness.appendMessage(...)`, records the message end, and emits the same bus event a normal assistant `message_end` emits (so the UI shows it live). If the session is archived, unarchive it first.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/manager-post-note.test.ts
// Mirror the harness/bus setup used in server/test/manager.test.ts (reuse its
// test factory/helpers). The assertion: after postAssistantNote, the session's
// branch contains an assistant message whose text matches, and a bus event was
// emitted. Pseudocode shape — adapt to the existing manager test harness:
import { describe, it, expect } from "vitest";
// import { makeManager } from "./helpers/manager-harness.ts"; // use the existing one

describe("AgentManager.postAssistantNote", () => {
  it("appends an assistant message without running a turn and emits an update", async () => {
    // const { manager, bus, session } = await makeManager();
    // const events: any[] = []; bus.subscribe((e) => events.push(e));
    // const row = await manager.createSession();
    // await manager.postAssistantNote(row.id, "── Memory maintenance ──\nNo proposals.");
    // const branch = await /* open session */.getBranch();
    // expect(branch.some((e) => e.type === "message" && e.message.role === "assistant" && textOf(e.message).includes("Memory maintenance"))).toBe(true);
    // expect(events.some((e) => e.type === "agent")).toBe(true);
    expect(true).toBe(true); // replace with the real assertions above
  });
});
```

> **Implementer note:** open `server/test/manager.test.ts` first and reuse its exact manager/harness/bus construction (the `it("injectMessage ...")` tests are the closest template). Replace the pseudocode with real assertions against that harness. Do NOT ship the `expect(true).toBe(true)` placeholder — the task is not done until the real branch + bus assertions pass.

- [ ] **Step 2: Run test — verify it fails** (after writing real assertions)

Run: `cd server && npx vitest --run test/manager-post-note.test.ts`
Expected: FAIL — `postAssistantNote` is not a function.

- [ ] **Step 3: Implement `postAssistantNote` in `manager.ts`**

Model on `emitCompactionSurrender` (which builds an `AgentMessage`, calls `opened.harness.appendMessage(message)`, `this.recordMessageEnd(opened, message)`, and emits a bus event). Add:

```ts
  /**
   * Append an assistant note to a session WITHOUT running an agent turn (used
   * by the dream report). Unarchives the session first so it surfaces in the UI.
   */
  async postAssistantNote(id: string, text: string): Promise<void> {
    if (this.opts.isArchived?.(id)) await this.unarchiveSession(id);
    const opened = await this.getOrOpen(id);
    const message: AgentMessage = { role: "assistant", content: [{ type: "text", text }] };
    await opened.harness.appendMessage(message);
    this.recordMessageEnd(opened, message);
    this.opts.bus.emit({ type: "agent", sessionId: id, event: { type: "message_end", message } as AgentHarnessEvent });
  }
```

> **Implementer note:** match the real `AgentMessage` content shape and `recordMessageEnd`/bus-event types used by `emitCompactionSurrender`. Copy that method's exact construction; only the text and the unarchive line differ.

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/manager-post-note.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/manager.ts server/test/manager-post-note.test.ts
git commit -m "feat(manager): postAssistantNote — append a message without a turn (+ unarchive)"
```

---

### Task 10: `DreamJob` orchestrator

**Files:**
- Create: `server/src/memory/dream/dream-job.ts`
- Test: `server/test/memory/dream/dream-job.test.ts`

**Interfaces:**
- Consumes: everything above + a `gatherUserTurns(cursorMs: number): { turns; newCursorMs }` reader and a `notify(text)` poster (the manager's `postAssistantNote` bound to the maintenance session), plus a `DreamState` accessor.
- Produces:
```ts
export interface DreamJobDeps {
  ltm: MemorySystem;
  reconcile: (o: { force?: boolean; rebuild?: boolean; prune?: boolean }) => Promise<{ pruned: number }>;
  store: ProposalStore;
  storeDir: string; dreamDir: string;
  gatherUserTurns: (cursorMs: number) => { turns: { sessionId: string; entryId: string; text: string }[]; newCursorMs: number };
  ensureMaintenanceSession: () => Promise<string>;     // creates/unarchives, returns id
  postReport: (sessionId: string, text: string) => Promise<void>;
  getApiKey: () => Promise<string | undefined>;
  model: string; minConfidence: number; tokenBudget: number; proposeOnly: boolean;
  idFor: (seed: string) => string; now: () => string;
}
export async function runDreamJob(deps: DreamJobDeps): Promise<{ summary: MechanicalSummary | null; proposed: number }>;
```
- Flow: read `dream-state.json` cursor → (unless `proposeOnly`) `runMechanicalPass` → `gatherUserTurns(cursor)` → `mineProposals` → `store.save` → `ensureMaintenanceSession` → `composeReport` → `postReport` → write new cursor + `lastRunDate` + `maintenanceSessionId` to `dream-state.json` → append a `dream-log.jsonl` line.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/dream-job.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { MemorySystem } from "ltm";
import { ProposalStore } from "../../../src/memory/dream/proposal-store.ts";
import { runDreamJob } from "../../../src/memory/dream/dream-job.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-job-")));

describe("runDreamJob", () => {
  it("runs mechanical, mines, saves proposals, posts a report, advances the cursor", async () => {
    const root = tmp();
    const storeDir = path.join(root, "ltm"); const dreamDir = path.join(root, "dream");
    const ltm = MemorySystem.open({ storeDir });
    try {
      await ltm.recordObservation({ text: "I work at Initech", timestamp: "2026-06-19T00:00:00Z", learnFacts: true });
      const fid = ltm.listFacts().find((f) => f.predicate === "works_at")!.id;
      const store = new ProposalStore(dreamDir);
      let posted = ""; let postedSession = "";
      const out = await runDreamJob({
        ltm, reconcile: async () => ({ pruned: 0 }), store, storeDir, dreamDir,
        gatherUserTurns: () => ({ turns: [{ sessionId: "s", entryId: "e", text: "drop the initech fact" }], newCursorMs: 123 }),
        ensureMaintenanceSession: async () => "maint",
        postReport: async (sid, text) => { postedSession = sid; posted = text; },
        getApiKey: async () => "tok", model: "m", minConfidence: 0.6, tokenBudget: 8000, proposeOnly: false,
        idFor: () => "p1", now: () => "2026-06-20T03:00:00.000Z",
        // miner fetch is injected via a module seam in the real impl; for this test,
        // stub gatherUserTurns + a fetch global that returns one drop proposal for fid.
      } as any);
      void fid;
      expect(postedSession).toBe("maint");
      expect(posted).toContain("Memory maintenance");
      const state = JSON.parse(fs.readFileSync(path.join(dreamDir, "dream-state.json"), "utf8"));
      expect(state.cursorMs).toBe(123);
      expect(out.summary).not.toBeNull();
    } finally { ltm.close(); }
  });
});
```

> **Implementer note:** the miner makes a real `fetch` unless injected. Add an optional `fetchImpl?: typeof fetch` to `DreamJobDeps`, thread it into `mineProposals`, and in this test pass a stub returning one `drop` proposal targeting `fid` (reuse the `fetchReturning` helper from Task 5's test). Make the test assertion exact (proposal saved + report lists it).

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/dream-job.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dream-job.ts`**

```ts
// server/src/memory/dream/dream-job.ts
import fs from "node:fs"; import path from "node:path";
import type { MemorySystem } from "ltm";
import { runMechanicalPass } from "./mechanical.ts";
import { mineProposals } from "./miner.ts";
import { composeReport } from "./report.ts";
import type { DreamState, MechanicalSummary } from "./types.ts";

export interface DreamJobDeps {
  ltm: MemorySystem;
  reconcile: (o: { force?: boolean; rebuild?: boolean; prune?: boolean }) => Promise<{ pruned: number }>;
  store: import("./proposal-store.ts").ProposalStore;
  storeDir: string; dreamDir: string;
  gatherUserTurns: (cursorMs: number) => { turns: { sessionId: string; entryId: string; text: string }[]; newCursorMs: number };
  ensureMaintenanceSession: () => Promise<string>;
  postReport: (sessionId: string, text: string) => Promise<void>;
  getApiKey: () => Promise<string | undefined>;
  model: string; baseUrl?: string; minConfidence: number; tokenBudget: number; proposeOnly: boolean;
  idFor: (seed: string) => string; now: () => string;
  fetchImpl?: typeof fetch;
}

function loadState(file: string): DreamState {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as DreamState; }
  catch { return { lastRunDate: null, cursorMs: 0, maintenanceSessionId: null }; }
}

export async function runDreamJob(deps: DreamJobDeps): Promise<{ summary: MechanicalSummary | null; proposed: number }> {
  fs.mkdirSync(deps.dreamDir, { recursive: true });
  const stateFile = path.join(deps.dreamDir, "dream-state.json");
  const state = loadState(stateFile);

  const summary = deps.proposeOnly ? null : await runMechanicalPass({ ltm: deps.ltm, reconcile: deps.reconcile, storeDir: deps.storeDir, now: deps.now });

  const { turns, newCursorMs } = deps.gatherUserTurns(state.cursorMs);
  // Token budget: keep newest-first within ~tokenBudget chars*4.
  const budgetedChars = deps.tokenBudget * 4;
  const kept: typeof turns = []; let used = 0;
  for (const t of [...turns].reverse()) { used += t.text.length; if (used > budgetedChars) break; kept.unshift(t); }

  const facts = deps.ltm.listFacts()
    .filter((f) => f.state === "active" && !f.supersededBy)
    .map((f) => ({ id: f.id, kind: f.kind, predicate: f.predicate, object: f.object, polarity: f.polarity }));

  const proposals = await mineProposals({
    facts, userTurns: kept, dismissedKeys: deps.store.dismissedKeys(),
    getApiKey: deps.getApiKey, model: deps.model, baseUrl: deps.baseUrl,
    minConfidence: deps.minConfidence, idFor: deps.idFor, fetchImpl: deps.fetchImpl,
  });
  deps.store.save(proposals);

  const sessionId = await deps.ensureMaintenanceSession();
  const factText = (id: string): string | undefined => {
    const f = deps.ltm.listFacts().find((x) => x.id === id);
    return f ? `${f.kind}/${f.predicate}=${f.object}` : undefined;
  };
  const report = composeReport(deps.now().slice(0, 10), summary ?? { backup: "", canonicalized: 0, merged: 0, folded: 0, pruned: 0, embedded: 0 }, proposals, factText);
  await deps.postReport(sessionId, report);

  const next: DreamState = { lastRunDate: deps.now().slice(0, 10), cursorMs: newCursorMs, maintenanceSessionId: sessionId };
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
  fs.appendFileSync(path.join(deps.dreamDir, "dream-log.jsonl"),
    JSON.stringify({ ranAt: deps.now(), summary, proposed: proposals.length, reportSessionId: sessionId }) + "\n");

  return { summary, proposed: proposals.length };
}
```

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/dream-job.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/dream-job.ts server/test/memory/dream/dream-job.test.ts
git commit -m "feat(dream): DreamJob orchestrator (mechanical -> mine -> report -> cursor)"
```

---

### Task 11: `DreamScheduler` (timer + due logic)

**Files:**
- Create: `server/src/memory/dream/scheduler.ts`
- Test: `server/test/memory/dream/scheduler.test.ts`

**Interfaces:**
- Produces:
```ts
export interface DreamSchedulerOpts { run: () => Promise<unknown>; hour: number; lastRunDate: () => string | null; nowDate: () => Date; intervalMs?: number; logger?: (m: string) => void; }
export class DreamScheduler { constructor(opts: DreamSchedulerOpts); start(): void; stop(): void; isDue(): boolean; }
```
- `isDue()`: true when `nowDate().getHours() >= hour` AND `lastRunDate() !== nowDate()`-as-YYYY-MM-DD. `start()` mirrors `LtmReconciler` (setInterval, default hourly, `.unref()`); on each tick, if `isDue()` runs `run()` once (guards re-entrancy with an in-flight flag).

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory/dream/scheduler.test.ts
import { describe, it, expect } from "vitest";
import { DreamScheduler } from "../../../src/memory/dream/scheduler.ts";

const dateAt = (h: number) => new Date(2026, 5, 20, h, 0, 0);

describe("DreamScheduler.isDue", () => {
  it("due after the hour when not yet run today; not due before, or if already run", () => {
    let last: string | null = null;
    const s = new DreamScheduler({ run: async () => {}, hour: 3, lastRunDate: () => last, nowDate: () => dateAt(4) });
    expect(s.isDue()).toBe(true);
    const before = new DreamScheduler({ run: async () => {}, hour: 3, lastRunDate: () => last, nowDate: () => dateAt(2) });
    expect(before.isDue()).toBe(false);
    last = "2026-06-20";
    expect(s.isDue()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scheduler.ts`**

```ts
// server/src/memory/dream/scheduler.ts
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface DreamSchedulerOpts {
  run: () => Promise<unknown>;
  hour: number;
  lastRunDate: () => string | null;
  nowDate: () => Date;
  intervalMs?: number;
  logger?: (m: string) => void;
}

export class DreamScheduler {
  private opts: DreamSchedulerOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  constructor(opts: DreamSchedulerOpts) { this.opts = opts; }

  isDue(): boolean {
    const now = this.opts.nowDate();
    if (now.getHours() < this.opts.hour) return false;
    return this.opts.lastRunDate() !== ymd(now);
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.inFlight || !this.isDue()) return;
      this.inFlight = true;
      try { await this.opts.run(); }
      catch (e) { (this.opts.logger ?? ((m) => console.warn(m)))(`[dream] run failed: ${(e as Error).message}`); }
      finally { this.inFlight = false; }
    };
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    void tick(); // check once at boot
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
```

- [ ] **Step 4: Run test — verify pass + type-check**

Run: `cd server && npx vitest --run test/memory/dream/scheduler.test.ts && cd /home/bjk/projects/ytsejam && npm run check`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/dream/scheduler.ts server/test/memory/dream/scheduler.test.ts
git commit -m "feat(dream): DreamScheduler timer + due logic"
```

---

### Task 12: Wire into the server (`index.ts`) + config + session reader

**Files:**
- Create: `server/src/memory/dream/sessions-reader.ts` (gatherUserTurns over `<dataDir>/sessions`)
- Modify: `server/src/index.ts` (construct/start/stop the scheduler; wire dream tools into `sessionTools`; ensureMaintenanceSession via manager)
- Test: `server/test/memory/dream/sessions-reader.test.ts`

**Interfaces:**
- Produces: `function makeGatherUserTurns(sessionsDir: string): (cursorMs: number) => { turns: { sessionId; entryId; text }[]; newCursorMs: number }` — lists session files, keeps those with `mtimeMs > cursorMs`, reads `role:"user"` turns via `readSessionFile`, returns them + `max(mtimeMs)` as the new cursor.

- [ ] **Step 1: Write the failing test for `sessions-reader.ts`**

```ts
// server/test/memory/dream/sessions-reader.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { makeGatherUserTurns } from "../../../src/memory/dream/sessions-reader.ts";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("makeGatherUserTurns", () => {
  it("returns user turns from session files newer than the cursor", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-sess-"));
    const sessions = path.join(dir, "sessions", "--chat--");
    fs.mkdirSync(sessions, { recursive: true });
    // Minimal v3 session file: header line + one user message line.
    const file = path.join(sessions, "s1.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "s1" });
    const userMsg = JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "I prefer Go" }] }, timestamp: "2026-06-19T00:00:00Z" });
    fs.writeFileSync(file, header + "\n" + userMsg + "\n");
    const gather = makeGatherUserTurns(path.join(dir, "sessions"));
    const { turns, newCursorMs } = gather(0);
    expect(turns.some((t) => t.text.includes("Go"))).toBe(true);
    expect(newCursorMs).toBeGreaterThan(0);
    // cursor past the file's mtime returns nothing
    expect(gather(newCursorMs + 1000).turns).toHaveLength(0);
  });
});
```

> **Implementer note:** confirm the exact v3 session line schema against `packages/ltm/src/session/reader.ts` (`readSessionFile`) — match its `type`/`version`/`message` shape so the test file parses. Use `readSessionFile`'s own returned `turns` rather than hand-parsing.

- [ ] **Step 2: Run test — verify it fails**

Run: `cd server && npx vitest --run test/memory/dream/sessions-reader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sessions-reader.ts`**

```ts
// server/src/memory/dream/sessions-reader.ts
import fs from "node:fs";
import { listSessionFiles, readSessionFile } from "ltm";

export function makeGatherUserTurns(sessionsDir: string) {
  return (cursorMs: number): { turns: { sessionId: string; entryId: string; text: string }[]; newCursorMs: number } => {
    const turns: { sessionId: string; entryId: string; text: string }[] = [];
    let newCursor = cursorMs;
    let files: string[] = [];
    try { files = listSessionFiles(sessionsDir); } catch { return { turns, newCursorMs: cursorMs }; }
    for (const file of files) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtimeMs <= cursorMs) continue;
      newCursor = Math.max(newCursor, mtimeMs);
      try {
        const parsed = readSessionFile(file);
        for (const t of parsed.turns) {
          if (t.role !== "user" || !t.text.trim()) continue;
          turns.push({ sessionId: t.sessionId, entryId: t.entryId, text: t.text });
        }
      } catch { /* skip unreadable */ }
    }
    return { turns, newCursorMs: newCursor };
  };
}
```

- [ ] **Step 4: Run the sessions-reader test — verify pass**

Run: `cd server && npx vitest --run test/memory/dream/sessions-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `index.ts`** (after the LTM bridge block; gated on `memory.getLtm()`):

```ts
// --- Dream job (nightly supervised memory maintenance) -------------------
import { DreamScheduler } from "./memory/dream/scheduler.ts";
import { ProposalStore } from "./memory/dream/proposal-store.ts";
import { runDreamJob } from "./memory/dream/dream-job.ts";
import { makeGatherUserTurns } from "./memory/dream/sessions-reader.ts";
import { createDreamTools } from "./memory/dream/tools.ts";
import crypto from "node:crypto";

let dreamScheduler: DreamScheduler | null = null;
let maintenanceSessionId: string | null = null;
if (process.env.DREAM_ENABLED !== "0") {
  const ltmStoreDir = process.env.LTM_STORE_DIR || path.join(config.dataDir, "ltm");
  const dreamDir = path.join(ltmStoreDir, "dream");
  const proposalStore = new ProposalStore(dreamDir);
  const sessionsDir = path.join(config.dataDir, "sessions");
  const hour = Number(process.env.DREAM_HOUR ?? 3);
  const model = process.env.DREAM_MODEL ?? "claude-haiku-4.5";
  const minConfidence = Number(process.env.DREAM_MIN_CONFIDENCE ?? 0.6);
  const tokenBudget = Number(process.env.DREAM_MINE_TOKEN_BUDGET ?? 8000);
  const proposeOnly = process.env.DREAM_PROPOSE_ONLY === "1";

  const ensureMaintenanceSession = async (): Promise<string> => {
    if (maintenanceSessionId) { await manager.unarchiveSession(maintenanceSessionId).catch(() => {}); return maintenanceSessionId; }
    const row = await manager.createSession();
    await manager.rename(row.id, "Memory maintenance");
    maintenanceSessionId = row.id;
    return row.id;
  };

  const run = async () => {
    const ltm = memory.getLtm(); if (!ltm) return;
    await runDreamJob({
      ltm,
      reconcile: (o) => (reconciler ? reconciler.reconcile(o) : Promise.resolve({ pruned: 0 } as { pruned: number })),
      store: proposalStore, storeDir: ltmStoreDir, dreamDir,
      gatherUserTurns: makeGatherUserTurns(sessionsDir),
      ensureMaintenanceSession,
      postReport: (sid, text) => manager.postAssistantNote(sid, text),
      getApiKey: () => resolveApiKey("github-copilot", authStore),
      model, minConfidence, tokenBudget, proposeOnly,
      idFor: (seed) => "p-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8),
      now: () => new Date().toISOString(),
    }).catch((e) => console.warn(`[dream] run error: ${(e as Error).message}`));
  };

  const readState = (): string | null => {
    try { return (JSON.parse(fs.readFileSync(path.join(dreamDir, "dream-state.json"), "utf8")) as { lastRunDate: string | null }).lastRunDate; }
    catch { return null; }
  };
  dreamScheduler = new DreamScheduler({ run, hour, lastRunDate: readState, nowDate: () => new Date() });
  dreamScheduler.start();

  // expose for sessionTools wiring + shutdown
  (globalThis as Record<string, unknown>).__dreamApplyDeps = { ltm: () => memory.getLtm(), store: proposalStore };
}
```

> **Implementer note:** do NOT actually use a `globalThis` stash — that's a sketch. Instead, hold `proposalStore` + `maintenanceSessionId` in the outer scope (as shown) and reference them directly in the `sessionTools` closure (next step), since both are defined in the same module scope as the `sessionTools` option. Remove the `globalThis` line.

- [ ] **Step 6: Wire the dream tools into `sessionTools`**

Find where `sessionTools: (sessionId) => [ ... ]` is defined in `index.ts` and add the dream tools:

```ts
sessionTools: (sessionId) => [
  ...createDelegationTools(() => taskManager, sessionId),
  ...createSchedulingTools(() => scheduler, sessionId),
  ...createDreamTools(
    { apply: { ltm: memory.getLtm()!, store: proposalStore, now: () => new Date().toISOString() },
      maintenanceSessionId: () => maintenanceSessionId },
    sessionId,
  ),
],
```

> **Implementer note:** `memory.getLtm()` can be null early; guard inside `createDreamTools` by returning `[]` when `apply.ltm` is null, OR resolve `ltm` lazily inside each tool's `execute`. Prefer lazy: change `ApplyDeps.ltm` usage in `tools.ts` to accept `() => MemorySystem | null` and no-op when null. Adjust Task 8 accordingly and re-run its test.

- [ ] **Step 7: Shutdown**

In the `drainAndExit` / `shutdownLtm` path, add `dreamScheduler?.stop();`.

- [ ] **Step 8: Type-check + full server suite**

Run: `cd /home/bjk/projects/ytsejam && npm run check && npm test --workspace server && npm test --workspace ltm`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add server/src/memory/dream/sessions-reader.ts server/src/index.ts server/test/memory/dream/sessions-reader.test.ts
git commit -m "feat(dream): wire DreamScheduler + tools into the server, sessions reader, config"
```

---

### Task 13: End-to-end verification + docs

**Files:**
- Modify: `README.md` or `docs/agents/*` (document the dream job + env vars — match where other LTM env vars are documented)
- Modify: `server/src/cog/brief.ts` or the relevant doc if the maintenance session needs a mention (optional)

- [ ] **Step 1: Manual e2e against a temp store**

Write a throwaway script (not committed) that opens a `MemorySystem` on a temp dir, seeds drift (a synonym dupe + a contradiction + an un-embedded fact) and a session file with a user statement, then calls `runDreamJob` with a stubbed `fetchImpl` returning a merge + an add. Assert: mechanical counts > 0; report text lists the merge + add; `apply all` (via `applyProposals`) mutates facts; re-run yields no duplicate proposals.

- [ ] **Step 2: Document env vars**

Add a short "Dreaming (nightly memory maintenance)" section listing `DREAM_ENABLED`, `DREAM_HOUR`, `DREAM_MODEL`, `DREAM_MINE_TOKEN_BUDGET`, `DREAM_MIN_CONFIDENCE`, `DREAM_PROPOSE_ONLY` and the kill-switch behavior, next to the existing `YTSEJAM_LTM_*` docs.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(dream): document nightly memory-maintenance job + env vars"
```

---

## Self-Review

**Spec coverage:** Architecture/units → Tasks 3–12. Phase 1 mechanical → Task 4 (uses Tasks 1–2 ltm methods). Phase 2 miner (provenance gate, incremental, anti-thrash) → Tasks 5, 12 (sessions-reader). Phase 3 report+apply+unarchive → Tasks 6–9. Scheduler → Task 11. Safety (backup/audit/kill-switch/fail-safe) → Tasks 4, 10, 12 (`DREAM_ENABLED`/`DREAM_PROPOSE_ONLY`). Config/observability → Tasks 10, 12. Testing + e2e → each task + Task 13.

**Open implementer decisions flagged inline (not placeholders):** the async form of `applyProposals` (Task 7 Step 3b), the manager test harness reuse (Task 9), the lazy `ltm` resolution in tools (Task 12 Step 6). Each has an explicit instruction and a test that forces the correct choice.

**Type consistency:** `Proposal`, `MechanicalSummary`, `DreamState` defined in Task 3 `types.ts` and consumed unchanged by Tasks 4–12. `keyOf` defined in Task 3, reused by Tasks 5/10. `ApplyDeps` defined Task 7, consumed Task 8/12.
