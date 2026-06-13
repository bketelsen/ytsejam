# Strong-Cue Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A direct question becomes a strong retrieval cue that can recall decayed/consolidated memories (marked stale, counted as rehearsal), while decay keeps governing unprompted surfacing.

**Architecture:** Three coordinated changes per the spec (`docs/superpowers/specs/2026-06-12-strong-cue-recall-design.md`): (1) the profile gains a `dormant` section (active facts below their floor) and slot promotion falls back to it with `stale: true` + a rehearsal `recallCount` bump; (2) consolidated turns stay in the vector index and resurrect when their cosine is a z-score outlier over the candidate pool; (3) the vector channel switches from pool-max ratio to mean-relative spread normalization so semantic margins survive into ranking.

**Tech Stack:** TypeScript (Node type-stripping, `.ts` imports), vitest, no new dependencies.

**Conventions:** every commit message ends with the task tag `[RECALL n]` (suffix, matching repo style). Gate after each task: the named tests pass + `npm run check` clean. Full gate at the end: `npm test && npm run check && npm run eval && npm run eval:ollama && npm run eval:sweep && npm run bench`.

**Key existing facts (verified against the code):**
- `effectiveStrength(fact, now)` in `src/semantic/store.ts:50-53` — read-time disuse decay, per-kind half-lives in `FACT_HALF_LIFE_DAYS` (preference 120d, attribute 180d, directive 365d, identity 365d).
- `SemanticStore.profile(now, floors)` at `src/semantic/store.ts:228-246` filters active facts by per-kind floor — the ONLY place floors apply.
- `promoteFacts(query, profile)` in `src/retrieval/promote.ts` — keyword map → predicates, renders facts, `MAX_PROMOTED = 3`.
- `Retriever.rank()` in `src/retrieval/retriever.ts` — pool-max normalization at lines 89-94, consolidated records skipped at line 107, `admit()` drops consolidated from both indexes at lines 56-64.
- `MemorySystem.retrieve()` in `src/api/memory-system.ts:194-229` — calls `promoteFacts`, bumps `episodic.bumpAccess` for returned non-fact items unless `dryRun`.
- `EpisodicStore.bumpAccess` persists at powers of two — `recordRecall` mirrors this.
- Default weights `{vector: 0.3, lexical: 0.4, recency: 0.08, salience: 0.07, graph: 0.15}`, `DEFAULT_CONFIG` in `src/types.ts:347-357`.
- Eval probes: 8 facts in `src/eval/synthetic.ts`. Paraphrase probes slot-coverable via the keyword map: sister-name (`sibling`), dog-name (`canine`), employer (`employed`), home-city (`town`, `based`), allergy (`food`, `eat`) — 5 of 8. project-name's paraphrase ("hobby codebase I keep tinkering with"), guitar, marathon are episodic-only → vector-resurrection territory.
- `identityCorrect`/`directiveRecall`/preference-F1/stability in the eval are computed from the floor-filtered profile — NOT from question probes. They must not change.

---

### Task 1: Types + config + rehearsal-aware effectiveStrength

**Files:**
- Modify: `src/types.ts` (SemanticFact, PromotedFact, RetrievedMemory, LtmConfig, LtmConfigPatch, mergeConfig, DEFAULT_CONFIG)
- Modify: `src/semantic/store.ts:50-53` (effectiveStrength)
- Test: `test/semantic.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `test/semantic.test.ts` (reuse the file's existing imports of `effectiveStrength` / `SemanticFact`; add them if absent: `import { effectiveStrength } from "../src/semantic/store.ts"; import type { SemanticFact } from "../src/types.ts";`):

```ts
describe("rehearsal-aware effective strength (RECALL 1)", () => {
  const fact: SemanticFact = {
    id: "fact-attribute-works_at-initech-p",
    kind: "attribute",
    predicate: "works_at",
    object: "Initech",
    objectNorm: "initech",
    polarity: 1,
    strength: 0.7,
    mentionCount: 1,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    sources: [{ sessionId: "s1", entryId: "e1" }],
    state: "active",
  };
  // 270 days later: 0.7 * 2^(-270/180) ≈ 0.247 — below the 0.3 floor.
  const now = "2026-09-28T00:00:00.000Z";

  it("recallCount stretches the disuse half-life", () => {
    const dormant = effectiveStrength(fact, now);
    expect(dormant).toBeLessThan(0.3);
    // recallCount 2 → half-life 180 * (1 + 0.5*2) = 360d → 0.7 * 2^(-0.75) ≈ 0.416
    const rehearsed = effectiveStrength({ ...fact, recallCount: 2 }, now);
    expect(rehearsed).toBeGreaterThan(0.3);
    expect(rehearsed).toBeGreaterThan(dormant);
  });

  it("recallCount undefined behaves as zero", () => {
    expect(effectiveStrength(fact, now)).toBeCloseTo(
      effectiveStrength({ ...fact, recallCount: 0 }, now),
      12,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest --run test/semantic.test.ts -t "rehearsal"`
Expected: FAIL (recallCount not in SemanticFact → tsc/test error, or strengths equal).

- [ ] **Step 3: Implement.** In `src/types.ts`, inside `SemanticFact` after `mentionCount: number;`:

```ts
  /**
   * Times this fact was recalled from dormancy by a direct slot question
   * (strong-cue recall). Rehearsal: stretches the disuse half-life the same
   * way accessCount does for episodic records. Optional — absent on facts
   * written before this field existed.
   */
  recallCount?: number;
```

In `PromotedFact` after `accessCount: number;`:

```ts
  /** Set when the fact was promoted from the dormant (below-floor) profile
   *  section by a direct slot question — consumers should phrase it as
   *  historical ("you told me on <date>"), not current. */
  stale?: boolean;
```

In `RetrievedMemory` after `breakdown: ScoreBreakdown;`:

```ts
  /** Set when this item was recalled past decay: a dormant promoted fact or
   *  a resurrected consolidated record. */
  stale?: boolean;
```

In `LtmConfig` after `recencyHalfLifeDays: number;`:

```ts
  /**
   * Z-score (over the candidate pool's cosines) a consolidated record must
   * reach to be resurrected by a semantic match. Calibrated against the
   * eval (Task RECALL 9); pools with ~zero variance never resurrect.
   */
  resurrectZ: number;
```

In `LtmConfigPatch`: `resurrectZ?: number;`. In `mergeConfig`: `resurrectZ: patch.resurrectZ ?? DEFAULT_CONFIG.resurrectZ,`. In `DEFAULT_CONFIG`: `resurrectZ: 2.5,` (initial value; Task 9 re-measures and may change it).

In `src/semantic/store.ts` replace `effectiveStrength`:

```ts
/** Half-life multiplier per dormant recall (mirrors episodic accessBonus). */
const RECALL_BONUS = 0.5;

export function effectiveStrength(fact: SemanticFact, now: string): number {
  const age = Math.max(0, Date.parse(now) - Date.parse(fact.lastSeenAt)) / DAY_MS;
  const halfLife =
    FACT_HALF_LIFE_DAYS[fact.kind] * (1 + RECALL_BONUS * (fact.recallCount ?? 0));
  return fact.strength * Math.pow(2, -age / halfLife);
}
```

- [ ] **Step 4: Verify** — Run: `npx vitest --run test/semantic.test.ts && npm run check`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/semantic/store.ts test/semantic.test.ts
git commit -m "types: recallCount, stale flags, resurrectZ; rehearsal stretches fact half-life [RECALL 1]"
```

---

### Task 2: Dormant profile section

**Files:**
- Modify: `src/types.ts` (ProfileSummary)
- Modify: `src/semantic/store.ts:228-246` (profile())
- Test: `test/semantic.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `test/semantic.test.ts`. The file already builds `SemanticStore` instances over tmp dirs and ingests `Turn`s; follow its existing helper if one exists, otherwise:

```ts
import { SemanticStore } from "../src/semantic/store.ts"; // if not already imported
import type { Turn } from "../src/types.ts";

function userTurn(text: string, timestamp: string, entryId = "e1"): Turn {
  return { sessionId: "s-dormant", entryId, role: "user", text, timestamp };
}

describe("dormant profile section (RECALL 2)", () => {
  it("active facts below their floor land in dormant, sorted strongest-first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
    const store = SemanticStore.open(dir);
    store.ingestTurn(userTurn("I work at Initech.", "2026-01-01T00:00:00.000Z"));
    const now = "2026-09-28T00:00:00.000Z"; // works_at attribute decayed below 0.3

    const profile = store.profile(now);
    expect(profile.attributes.find((f) => f.predicate === "works_at")).toBeUndefined();
    const dormant = profile.dormant.find((f) => f.predicate === "works_at");
    expect(dormant).toBeDefined();
    expect(dormant!.object).toBe("Initech");
  });

  it("above-floor facts never appear in dormant", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
    const store = SemanticStore.open(dir);
    store.ingestTurn(userTurn("I work at Initech.", "2026-01-01T00:00:00.000Z"));
    const profile = store.profile("2026-01-02T00:00:00.000Z"); // fresh
    expect(profile.attributes.some((f) => f.predicate === "works_at")).toBe(true);
    expect(profile.dormant.some((f) => f.predicate === "works_at")).toBe(false);
  });
});
```

(If "I work at Initech." does not extract a `works_at` fact, check `src/semantic/extract.ts` for the exact supported phrasing — the eval plants exactly this sentence shape, so it should.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest --run test/semantic.test.ts -t "dormant"`. Expected: FAIL (`profile.dormant` undefined / compile error).

- [ ] **Step 3: Implement.** In `src/types.ts`, `ProfileSummary` gains (after `attributes`):

```ts
  /**
   * Active, non-superseded facts whose effective strength fell below their
   * floor — invisible to unprompted composition, but reachable by a direct
   * slot question (strong-cue recall). Sorted by effective strength desc.
   */
  dormant: SemanticFact[];
```

In `src/semantic/store.ts` replace `profile()`:

```ts
  profile(
    now: string,
    floors: ProfileFloors = { floor: 0.3, identityFloor: 0.3, directiveFloor: 0.3 },
  ): ProfileSummary {
    const floorFor = (f: SemanticFact): number =>
      f.kind === "identity" ? floors.identityFloor : f.kind === "directive" ? floors.directiveFloor : floors.floor;
    const all = this.activeFacts().sort(
      (a, b) => effectiveStrength(b, now) - effectiveStrength(a, now),
    );
    const facts = all.filter((f) => effectiveStrength(f, now) >= floorFor(f));
    const dormant = all.filter((f) => effectiveStrength(f, now) < floorFor(f));
    return {
      identity: facts.filter((f) => f.kind === "identity"),
      preferences: facts.filter((f) => f.kind === "preference"),
      directives: facts.filter((f) => f.kind === "directive"),
      attributes: facts.filter((f) => f.kind === "attribute"),
      dormant,
      topEntities: this.activeEntities()
        .sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, 12),
    };
  }
```

- [ ] **Step 4: Fix compile fallout** — Run: `npm run check`. Any test/src code constructing a `ProfileSummary` literal needs `dormant: []` added. Find them: `grep -rn "topEntities:" src test`. Fix each.

- [ ] **Step 5: Verify** — `npx vitest --run test/semantic.test.ts && npm run check && npm test 2>&1 | tail -3`. Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src test
git commit -m "semantic: dormant profile section — below-floor facts stay addressable [RECALL 2]"
```

---

### Task 3: SemanticStore.recordRecall

**Files:**
- Modify: `src/semantic/store.ts` (new method after `profile()`)
- Test: `test/semantic.test.ts` (append)

- [ ] **Step 1: Write the failing test:**

```ts
describe("recordRecall rehearsal persistence (RECALL 3)", () => {
  it("bumps in memory and persists at powers of two (like bumpAccess)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
    const store = SemanticStore.open(dir);
    store.ingestTurn(userTurn("I work at Initech.", "2026-01-01T00:00:00.000Z"));
    const id = store.activeFacts().find((f) => f.predicate === "works_at")!.id;

    for (let i = 0; i < 3; i++) store.recordRecall(id);
    expect(store.allFacts().find((f) => f.id === id)!.recallCount).toBe(3);

    // 3 is not a power of two — the last persisted snapshot is recallCount 2.
    const reopened = SemanticStore.open(dir);
    expect(reopened.allFacts().find((f) => f.id === id)!.recallCount).toBe(2);
  });

  it("ignores unknown and non-active facts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-sem-"));
    const store = SemanticStore.open(dir);
    store.recordRecall("no-such-fact"); // must not throw
  });
});
```

(Both `SemanticStore.open` calls hold no lock — `SemanticStore` has no lock; only `MemorySystem` does. If the suite complains, close/reuse per existing patterns in the file.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest --run test/semantic.test.ts -t "recordRecall"`. Expected: FAIL (method missing).

- [ ] **Step 3: Implement** in `src/semantic/store.ts` (after `profile()`):

```ts
  /**
   * Rehearsal: a dormant fact was recalled by a direct slot question.
   * In-memory count always updates; the log snapshot is appended only at
   * powers of two, mirroring EpisodicStore.bumpAccess — recall counts are a
   * decay heuristic, not accounting.
   */
  recordRecall(id: string): void {
    const fact = this.facts.get(id);
    if (!fact || fact.state !== "active") return;
    const updated = { ...fact, recallCount: (fact.recallCount ?? 0) + 1 };
    this.facts.set(id, updated);
    const c = updated.recallCount;
    if ((c & (c - 1)) === 0) this.factLog.append(updated);
  }
```

- [ ] **Step 4: Verify** — `npx vitest --run test/semantic.test.ts && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/semantic/store.ts test/semantic.test.ts
git commit -m "semantic: recordRecall — rate-limited rehearsal persistence [RECALL 3]"
```

---

### Task 4: Dormant fallback in promoteFacts + stale rendering + keyword additions

**Files:**
- Modify: `src/retrieval/promote.ts`
- Test: `test/retrieval.test.ts` (extend the existing `promoteFacts` describe block; `grep -n "promoteFacts" test/retrieval.test.ts` to find it)

- [ ] **Step 1: Write the failing tests.** Use the existing test file's fact/profile helpers if present; otherwise build a minimal profile literal:

```ts
function fact(partial: Partial<SemanticFact> & Pick<SemanticFact, "kind" | "predicate" | "object">): SemanticFact {
  return {
    id: `fact-${partial.kind}-${partial.predicate}-${partial.object.toLowerCase()}-p`,
    objectNorm: partial.object.toLowerCase(),
    polarity: 1,
    strength: 0.7,
    mentionCount: 1,
    firstSeenAt: "2026-01-05T00:00:00.000Z",
    lastSeenAt: "2026-01-05T00:00:00.000Z",
    sources: [{ sessionId: "s1", entryId: "e1" }],
    state: "active",
    ...partial,
  } as SemanticFact;
}
const emptyProfile = { identity: [], preferences: [], directives: [], attributes: [], dormant: [], topEntities: [] };

describe("dormant promotion (RECALL 4)", () => {
  const sister = fact({ kind: "attribute", predicate: "rel_sister", object: "Alice" });

  it("promotes a dormant fact on a slot query, stale with last-mentioned date", () => {
    const out = promoteFacts("Tell me about my sibling.", { ...emptyProfile, dormant: [sister] });
    expect(out).toHaveLength(1);
    expect(out[0].stale).toBe(true);
    expect(out[0].text).toBe("The user's sister is named Alice (last mentioned 2026-01-05).");
  });

  it("prefers an above-floor fact over a dormant one for the same predicate", () => {
    const fresh = fact({ kind: "attribute", predicate: "rel_sister", object: "Alice" });
    const out = promoteFacts("Tell me about my sibling.", {
      ...emptyProfile, attributes: [fresh], dormant: [sister],
    });
    expect(out).toHaveLength(1);
    expect(out[0].stale).toBeUndefined();
    expect(out[0].text).toBe("The user's sister is named Alice.");
  });

  it("never promotes dormant facts for a slot-free query", () => {
    const out = promoteFacts("Can you help me untangle a git rebase?", {
      ...emptyProfile, dormant: [sister],
    });
    expect(out).toHaveLength(0);
  });

  it("maps project/codebase/hobby to works_on", () => {
    const proj = fact({ kind: "attribute", predicate: "works_on", object: "Chapterhouse" });
    for (const q of ["What is my project called?", "What's the hobby codebase I keep tinkering with?"]) {
      const out = promoteFacts(q, { ...emptyProfile, dormant: [proj] });
      expect(out.map((p) => p.fact.predicate)).toContain("works_on");
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest --run test/retrieval.test.ts -t "dormant promotion"`. Expected: FAIL.

- [ ] **Step 3: Implement** in `src/retrieval/promote.ts`. Add to `PREDICATE_KEYWORDS`:

```ts
  project: ["works_on"],
  projects: ["works_on"],
  codebase: ["works_on"],
  hobby: ["works_on"],
```

Add after `renderFact`:

```ts
/** Stale facts carry their age so consumers phrase them as historical. */
function renderStale(fact: SemanticFact): string {
  return `${renderFact(fact).replace(/\.$/, "")} (last mentioned ${fact.lastSeenAt.slice(0, 10)}).`;
}
```

Replace the body of `promoteFacts` from the `const facts = [...]` line down:

```ts
  const aboveFloor = [
    ...profile.identity,
    ...profile.attributes,
    ...profile.directives,
    ...profile.preferences,
  ].filter((f) => predicates.has(f.predicate));
  aboveFloor.sort((a, b) => b.strength - a.strength);

  // Strong-cue recall: a slot question reaches past the floor. Only
  // predicates with NO above-floor answer fall back to the dormant section
  // (strongest first — profile.dormant is pre-sorted), one fact each.
  const covered = new Set(aboveFloor.map((f) => f.predicate));
  const dormantPicks: SemanticFact[] = [];
  for (const f of profile.dormant) {
    if (!predicates.has(f.predicate) || covered.has(f.predicate)) continue;
    covered.add(f.predicate);
    dormantPicks.push(f);
  }

  const toPromoted = (fact: SemanticFact, stale: boolean): PromotedFact => ({
    id: `fact/${fact.id}`,
    kind: "fact",
    fact,
    sessionId: fact.sources[0]?.sessionId ?? "profile",
    entryId: fact.sources[0]?.entryId,
    role: "summary",
    text: stale ? renderStale(fact) : renderFact(fact),
    timestamp: fact.lastSeenAt,
    salience: fact.strength,
    accessCount: 0,
    ...(stale ? { stale: true } : {}),
  });

  return [
    ...aboveFloor.map((f) => toPromoted(f, false)),
    ...dormantPicks.map((f) => toPromoted(f, true)),
  ].slice(0, MAX_PROMOTED);
```

- [ ] **Step 4: Verify** — `npx vitest --run test/retrieval.test.ts && npm run check`. Expected: PASS (existing promotion tests must still pass — above-floor behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/promote.ts test/retrieval.test.ts
git commit -m "retrieval: slot questions recall dormant facts, rendered stale [RECALL 4]"
```

---

### Task 5: Wire rehearsal + stale into MemorySystem.retrieve()

**Files:**
- Modify: `src/api/memory-system.ts:204-226` (retrieve())
- Test: `test/retrieval.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Pattern: `generateFixtures` + `MemorySystem.open({ now })` as in the existing "score-channel normalization" describe:

```ts
describe("strong-cue recall end to end (RECALL 5)", () => {
  it("a slot question recalls a dormant fact as stale and rehearses it back above floor", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 24, turnsPerSession: 12, intervalDays: 30, seed: 7 });
    const mem = MemorySystem.open({
      storeDir: path.join(work, "store"),
      now: () => truth.horizonEnd,
      config: { profile: { identityFloor: 0.2, directiveFloor: 0.2 } },
    });
    await mem.ingestSessionDir(path.join(work, "sessions"));

    // The sister attribute has decayed below the 0.3 attribute floor at the
    // 24-month horizon (the medium-band eval condition).
    const before = mem.profile();
    expect(before.attributes.some((f) => f.predicate === "rel_sister")).toBe(false);
    expect(before.dormant.some((f) => f.predicate === "rel_sister")).toBe(true);

    const result = await mem.retrieve("Tell me about my sibling.");
    const promoted = result.items.find((i) => i.record.kind === "fact" && i.record.fact.predicate === "rel_sister");
    expect(promoted).toBeDefined();
    expect(promoted!.stale).toBe(true);
    expect(promoted!.record.text).toContain("Alice");
    expect(promoted!.record.text).toContain("(last mentioned");

    // Rehearsal: repeated asks stretch the half-life until it re-crosses the floor.
    for (let i = 0; i < 8; i++) await mem.retrieve("Tell me about my sibling.");
    expect(mem.profile().attributes.some((f) => f.predicate === "rel_sister")).toBe(true);
    mem.close();
  });

  it("dryRun never rehearses", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 24, turnsPerSession: 12, intervalDays: 30, seed: 7 });
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd });
    await mem.ingestSessionDir(path.join(work, "sessions"));
    await mem.retrieve("Tell me about my sibling.", { dryRun: true });
    const fact = mem.listFacts().find((f) => f.predicate === "rel_sister");
    expect(fact?.recallCount ?? 0).toBe(0);
    mem.close();
  });
});
```

Notes for the implementer: check `generateFixtures`'s actual options signature (`grep -n "export function generateFixtures" -A 10 src/eval/synthetic.ts`) and pass the medium-band shape the eval uses (24 sessions × 30-day interval). If 8 rehearsals don't re-cross the floor, compute the needed count from the fixture's planted strength/date and adjust the loop bound — the assertion shape stays.

- [ ] **Step 2: Run to verify failure** — `npx vitest --run test/retrieval.test.ts -t "strong-cue recall"`. Expected: FAIL (`stale` undefined on the item; fact never promoted because dormant isn't consulted... Task 4 made promoteFacts consult it, so the first failure should be `promoted.stale` / rehearsal).

- [ ] **Step 3: Implement** in `src/api/memory-system.ts` `retrieve()`. The promoted mapping (line ~204) carries the flag:

```ts
    const promoted = promoteFacts(query, profile).map((record): RetrievedMemory => ({
      record,
      score: 1,
      ...(record.stale ? { stale: true } : {}),
      breakdown: {
        vector: 0,
        lexical: 0,
        recency: 0,
        salience: record.salience, // = fact.strength
        graph: 0,
        retention: 1,
        total: 1,
      },
    }));
```

And the access loop becomes:

```ts
    if (!opts.dryRun) {
      for (const item of items) {
        if (item.record.kind === "fact") {
          // Dormant facts recalled by a direct question count as rehearsal.
          if (item.record.stale) this.semantic.recordRecall(item.record.fact.id);
        } else {
          this.episodic.bumpAccess(item.record.id, now);
        }
      }
    }
```

- [ ] **Step 4: Verify** — `npx vitest --run test/retrieval.test.ts && npm run check && npm test 2>&1 | tail -3`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/memory-system.ts test/retrieval.test.ts
git commit -m "api: stale promotion surfaces + rehearsal bump in retrieve() [RECALL 5]"
```

---

### Task 6: Mean-relative vector normalization

**Files:**
- Modify: `src/retrieval/retriever.ts:85-94` (+ fallback path line ~115)
- Test: `test/retrieval.test.ts` (append)

- [ ] **Step 1: Write the failing test:**

```ts
import { spreadNormalize } from "../src/retrieval/retriever.ts"; // add to imports

describe("mean-relative vector normalization (RECALL 6)", () => {
  it("spreads a compressed cosine cluster: top=1, runner-up near 0", () => {
    const pool = [0.62, 0.6, 0.59, 0.58];
    const mean = pool.reduce((s, x) => s + x, 0) / pool.length; // 0.5975
    const max = 0.62;
    expect(spreadNormalize(0.62, mean, max)).toBeCloseTo(1, 9);
    expect(spreadNormalize(0.6, mean, max)).toBeLessThan(0.2);
    expect(spreadNormalize(0.5, mean, max)).toBe(0); // below mean clamps to 0
  });

  it("degenerate pools fall back to max-ratio", () => {
    expect(spreadNormalize(0.5, 0.5, 0.5)).toBeCloseTo(1, 9); // all equal
    expect(spreadNormalize(0, 0, 0)).toBe(0); // empty/zero pool
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest --run test/retrieval.test.ts -t "mean-relative"`. Expected: FAIL (not exported).

- [ ] **Step 3: Implement** in `src/retrieval/retriever.ts`. Add (above the class):

```ts
/**
 * Vector-channel normalization: mean-relative spread over the candidate
 * pool, clamped to [0,1]. Real embedders cluster cosines tightly (e.g.
 * nomic ~0.55-0.62 across a conversational corpus), so the previous
 * pool-max ratio left the best match ~0.02 ahead of distractors — less
 * than the recency weight, which is why fresh chatter outranked perfect
 * semantic matches. Mean-relative spread gives the pool's best match the
 * full vector weight and typical distractors ~0. Degenerate pools
 * (max ≈ mean) fall back to the old max-ratio.
 */
export function spreadNormalize(cos: number, mean: number, max: number): number {
  const c = Math.max(0, cos);
  const range = max - mean;
  if (range < 1e-9) return max > 1e-9 ? Math.min(1, c / max) : 0;
  return Math.min(1, Math.max(0, (c - mean) / range));
}
```

In `rank()`, replace lines 84-94 (the normalization block):

```ts
    // Lexical normalizes to its pool max (BM25 spreads naturally). The
    // vector channel uses mean-relative spread — see spreadNormalize.
    const maxLexical = lexicalHits[0]?.score || 1;
    const rawCosines = vectorHits.map((h) => Math.max(0, h.score));
    const maxVector = rawCosines[0] ?? 0;
    const meanVector = rawCosines.length
      ? rawCosines.reduce((s, x) => s + x, 0) / rawCosines.length
      : 0;
    const lexicalById = new Map(lexicalHits.map((h) => [h.id, h.score / maxLexical]));
    const vectorById = new Map(
      vectorHits.map((h) => [h.id, spreadNormalize(h.score, meanVector, maxVector)]),
    );
```

And the fallback path in the breakdown (line ~113-116):

```ts
        vector:
          vectorById.get(id) ??
          (record.embedding
            ? spreadNormalize(cosine(queryVector, record.embedding), meanVector, maxVector)
            : 0),
```

- [ ] **Step 4: Verify, including the survivor test** — `npx vitest --run test/retrieval.test.ts && npm test 2>&1 | tail -3 && npm run check`. The existing "PLAN 2.2" test asserts the top verbatim match reads `vector ≈ 1` — that still holds (max maps to 1). Some eval-threshold tests may shift; if `npm test` eval-threshold assertions fail here, note the failures and continue — Task 9 re-baselines. Do NOT loosen non-eval unit tests; investigate any of those that fail.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/retriever.ts test/retrieval.test.ts
git commit -m "retrieval: mean-relative vector normalization replaces pool-max ratio [RECALL 6]"
```

---

### Task 7: Vector resurrection of consolidated records

**Files:**
- Modify: `src/retrieval/retriever.ts` (admit(), rank())
- Test: `test/retrieval.test.ts` (append)

- [ ] **Step 1: Write the failing test.** Drive the Retriever directly with hand-built embeddings (dimension 4; query [1,0,0,0]; distractor cosines = first vector component):

```ts
import { Retriever } from "../src/retrieval/retriever.ts"; // add to imports
import { EpisodicStore } from "../src/episodic/store.ts";
import { PreferenceGraph } from "../src/semantic/graph.ts";
import { mergeConfig } from "../src/types.ts";
import type { EpisodicRecord, Embedder } from ... // match existing imports

function unitVec(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}
function turnRecord(id: string, cos: number, state: "active" | "consolidated", timestamp: string): EpisodicRecord {
  return {
    id, kind: "turn", sessionId: "s1", entryId: id, role: "user",
    text: `turn ${id}`, timestamp, salience: 0.5, accessCount: 0, state,
    embedding: unitVec(cos),
  };
}
const stubEmbedder: Embedder = { dimension: 4, embed: () => Promise.resolve([1, 0, 0, 0]) };

function buildRetriever(records: EpisodicRecord[]) {
  const store = EpisodicStore.open(fs.mkdtempSync(path.join(os.tmpdir(), "ltm-res-")));
  store.upsertMany(records);
  return { store, retriever: new Retriever({ store, embedder: stubEmbedder, graph: PreferenceGraph.build([], []), config: mergeConfig() }) };
}
const NOW = "2026-06-01T00:00:00.000Z";

describe("vector resurrection of consolidated records (RECALL 7)", () => {
  // 9 recent active distractors with cosines 0.22..0.30 — mean ≈ 0.33 with
  // the target, std ≈ 0.21, so the target's z ≈ 3+ clears resurrectZ 2.5.
  const distractors = Array.from({ length: 9 }, (_, i) =>
    turnRecord(`d${i}`, 0.22 + i * 0.01, "active", "2026-05-30T00:00:00.000Z"));

  it("an outlier consolidated record resurrects, marked stale", async () => {
    const target = turnRecord("old-target", 1.0, "consolidated", "2024-06-01T00:00:00.000Z");
    const { retriever } = buildRetriever([...distractors, target]);
    const out = await retriever.rank("anything", 5, NOW);
    const hit = out.find((i) => i.record.id === "old-target");
    expect(hit).toBeDefined();
    expect(hit!.stale).toBe(true);
    expect(out[0].record.id).toBe("old-target"); // spread-normalized vector wins
  });

  it("a mid-pool consolidated record stays excluded", async () => {
    const middling = turnRecord("old-mid", 0.3, "consolidated", "2024-06-01T00:00:00.000Z");
    const { retriever } = buildRetriever([...distractors, middling]);
    const out = await retriever.rank("anything", 5, NOW);
    expect(out.some((i) => i.record.id === "old-mid")).toBe(false);
  });

  it("a zero-variance pool never resurrects", async () => {
    const flat = Array.from({ length: 9 }, (_, i) =>
      turnRecord(`f${i}`, 0.25, "active", "2026-05-30T00:00:00.000Z"));
    const sameOld = turnRecord("old-flat", 0.25, "consolidated", "2024-06-01T00:00:00.000Z");
    const { retriever } = buildRetriever([...flat, sameOld]);
    const out = await retriever.rank("anything", 5, NOW);
    expect(out.some((i) => i.record.id === "old-flat")).toBe(false);
  });

  it("active records never carry stale", async () => {
    const { retriever } = buildRetriever(distractors);
    const out = await retriever.rank("anything", 5, NOW);
    expect(out.every((i) => i.stale === undefined)).toBe(true);
  });

  it("explain-style includeConsolidated still returns everything ungated", async () => {
    const middling = turnRecord("old-mid", 0.3, "consolidated", "2024-06-01T00:00:00.000Z");
    const { retriever } = buildRetriever([...distractors, middling]);
    const out = await retriever.rank("anything", 20, NOW, true);
    expect(out.some((i) => i.record.id === "old-mid")).toBe(true);
  });
});
```

(Check `EpisodicStore.open`/`upsertMany` signatures and the exact `EpisodicRecord` required fields against `src/episodic/store.ts` / `src/types.ts`; add missing required fields rather than changing the test's intent. Verify the z math after writing: compute mean/std of the 10 clamped cosines and confirm target z ≥ 2.5 and middling z < 2.5.)

- [ ] **Step 2: Run to verify failure** — `npx vitest --run test/retrieval.test.ts -t "resurrection"`. Expected: FAIL (consolidated never in results).

- [ ] **Step 3: Implement.** In `src/retrieval/retriever.ts`:

`admit()` becomes:

```ts
  /** Add/refresh a record in the live indexes (or drop it if not active). */
  admit(record: EpisodicRecord): void {
    if (record.state === "active" && record.text) {
      if (record.embedding) this.vectors.set(record.id, record.embedding);
      this.lexical.add(record.id, record.text);
    } else if (record.state === "consolidated" && record.text && record.embedding) {
      // Consolidated records stay vector-searchable so a strong semantic
      // match can resurrect them (strong-cue recall). Lexical stays
      // excluded: verbatim-term queries already reach the summaries.
      this.vectors.set(record.id, record.embedding);
      this.lexical.remove(record.id);
    } else {
      this.vectors.delete(record.id);
      this.lexical.remove(record.id);
    }
  }
```

In `rank()`, after the `meanVector` computation add the std and a raw-cosine map:

```ts
    const stdVector = Math.sqrt(
      rawCosines.reduce((s, x) => s + (x - meanVector) ** 2, 0) / Math.max(1, rawCosines.length),
    );
    const rawCosineById = new Map(vectorHits.map((h) => [h.id, Math.max(0, h.score)]));
```

In the scoring loop, replace `if (record.state === "consolidated" && !includeConsolidated) continue;` with:

```ts
      let stale = false;
      if (record.state === "consolidated" && !includeConsolidated) {
        // Resurrection gate: only a clear semantic outlier over the pool
        // reaches past consolidation. Zero-variance pools never resurrect.
        const raw = rawCosineById.get(id);
        if (raw === undefined || stdVector < 1e-6) continue;
        if ((raw - meanVector) / stdVector < config.resurrectZ) continue;
        stale = true;
      }
```

And the push becomes:

```ts
      scored.push({ record, score: breakdown.total, breakdown, ...(stale ? { stale: true } : {}) });
```

(`RankedMemory extends RetrievedMemory` already admits `stale?: boolean` from Task 1.)

- [ ] **Step 4: Verify** — `npx vitest --run test/retrieval.test.ts && npm run check && npm test 2>&1 | tail -3`. Eval-threshold failures are deferred to Task 9; any other failure gets investigated now.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/retriever.ts test/retrieval.test.ts
git commit -m "retrieval: z-score outliers resurrect consolidated records as stale [RECALL 7]"
```

---

### Task 8: Stale in trace + CLI explain

**Files:**
- Modify: `src/api/memory-system.ts:242` (trace line)
- Modify: `src/cli/main.ts` (explain case, ~line 99 — read the existing table rendering first)
- Test: `test/cli.test.ts` (only if it already covers explain output; otherwise rely on the trace assertion below in `test/retrieval.test.ts`)

- [ ] **Step 1: Implement trace.** In `trace()`, the returned map gains stale:

```ts
          returned: items.map((i) => ({ id: i.record.id, score: i.score, stale: i.stale, breakdown: i.breakdown })),
```

- [ ] **Step 2: Implement CLI marker.** Note: `MemorySystem.explain()` calls `rank(query, k, now, true)` — with `includeConsolidated=true` the resurrection gate never fires, so `item.stale` is never set on explain results. The useful marker there is the record's state. In the `explain` case of `src/cli/main.ts` (~line 108), the row print becomes:

```ts
          out(
            `${String(i + 1).padStart(4)}  ${f(b.total)}  ${f(b.vector)}  ${f(b.lexical)}  ${f(b.recency)}  ${f(b.salience)}  ${f(b.graph)}  ${f(b.retention)}  ${item.record.id}${
              item.stale
                ? " [stale]"
                : "state" in item.record && item.record.state === "consolidated"
                  ? " [consolidated]"
                  : ""
            }`,
          );
```

(`"state" in item.record` is required: the record union admits `PromotedFact`, which deliberately has no `state` field.)

- [ ] **Step 3: Test.** Append to the RECALL 5 describe in `test/retrieval.test.ts`:

```ts
  it("the retrieval trace records stale", async () => {
    const work = tmpDir();
    const truth = generateFixtures({ outDir: path.join(work, "sessions"), sessions: 24, turnsPerSession: 12, intervalDays: 30, seed: 7 });
    const tracePath = path.join(work, "trace.jsonl");
    const mem = MemorySystem.open({ storeDir: path.join(work, "store"), now: () => truth.horizonEnd, retrievalLog: tracePath });
    await mem.ingestSessionDir(path.join(work, "sessions"));
    await mem.retrieve("Tell me about my sibling.");
    const line = JSON.parse(fs.readFileSync(tracePath, "utf8").trim().split("\n").at(-1)!);
    expect(line.returned.some((r: { stale?: boolean }) => r.stale === true)).toBe(true);
    mem.close();
  });
```

- [ ] **Step 4: Verify** — `npx vitest --run test/retrieval.test.ts test/cli.test.ts && npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/memory-system.ts src/cli/main.ts test
git commit -m "observability: stale flag in retrieval trace and ltm explain [RECALL 8]"
```

---

### Task 9: Calibrate resurrectZ + re-baseline all thresholds

This task is measurement-driven; it edits `src/eval/harness.ts` BANDS thresholds, possibly `DEFAULT_CONFIG.resurrectZ`, and possibly restores a real-embedder threshold raise in `src/eval/run.ts`. The discipline: thresholds are measured minus 5pp; the 20-seed sweep gate (95% per-band pass) must hold; nothing aspirational.

**Files:**
- Modify: `src/eval/harness.ts` (BANDS thresholds + band doc comments)
- Maybe modify: `src/types.ts` (resurrectZ default), `src/eval/run.ts` (ollama-mode threshold raise)

- [ ] **Step 1: Measure hash mode.** Run:

```bash
npm run eval 2>&1 | tail -8
for s in 1 2 3 4 5; do node src/eval/run.ts --band medium --seed $s --workdir .eval-cal 2>/dev/null | grep -E "paraphrase recall|recall@5"; done; rm -rf .eval-cal
```

Expected direction: medium/long paraphrase r@5 rises from 0% to ~50-75% (5/8 probes are slot-recoverable; exact number is what it is). Plain recall and MRR may shift from the normalization change — record everything.

- [ ] **Step 2: Calibrate resurrectZ.** For each candidate in {2.0, 2.5, 3.0}: run `node src/eval/run.ts --ollama --workdir .eval-cal-z` with `resurrectZ` temporarily patched in `DEFAULT_CONFIG`, and compare medium/long paraphrase r@5 (resurrection should recover guitar/marathon/project-name with nomic) AND short-band stability (false resurrections would show as stability/recall regressions). Pick the smallest z with no regression; set it in `DEFAULT_CONFIG` with a comment naming the measurement. Spot-check seeds 1-5 on medium with the chosen z.

- [ ] **Step 3: Re-baseline BANDS.** Edit `src/eval/harness.ts` thresholds to measured-minus-5pp using the **minimum across the default seed and seeds 1-5** for each metric that moved (paraphraseRecallAt5 up on medium/long; verify recallAt5/mrr/stability unchanged or re-baseline likewise). Update the band doc comments: medium/long paraphrase is no longer "0% — decay-bound"; it's "slot-recoverable via strong-cue recall (measured X%); the episodic-only remainder needs a real embedder (see eval:ollama)". The identity/directive/preference/stability comments stay — those metrics must measure identical values to before this feature (verify; if they moved, something leaked into the profile path — stop and investigate).

- [ ] **Step 4: Sweep gate.** Run: `npm run eval:sweep` (20 seeds × 3 bands). Must pass ≥95% per band. If a band dips: thresholds too tight → widen to sweep-min minus 5pp and re-run.

- [ ] **Step 5: Ollama raise.** Run `npm run eval:ollama` plus seeds 1-5 on medium/long. If nomic's seed-minimum paraphrase r@5 on medium/long exceeds the new hash-based threshold by >5pp, restore a raise in `src/eval/run.ts` (the helper pattern that PLAN-OLLAMA removed — keyed on `ollama || semantic`, raising medium/long `paraphraseRecallAt5` to nomic seed-min minus 5pp) and document the measured basis in a comment. If the gap doesn't hold across seeds, don't raise — say so in the commit body.

- [ ] **Step 6: Full gate + bench.** `npm test && npm run check && npm run eval && npm run eval:ollama && npm run bench`. Bench must hold its thresholds (the vector index now retains consolidated records — expect a modest retrieval-latency increase at 10k; if p99 blows the 50ms threshold, stop and report rather than loosening).

- [ ] **Step 7: Commit** (include the measured table in the body):

```bash
git add -A src
git commit -m "eval: re-baseline for strong-cue recall; calibrate resurrectZ [RECALL 9]"
```

---

### Task 10: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update.**
1. Eval tables (hash + Ollama): replace with the Task 9 measured numbers.
2. Replace the "decay-bound, no embedder buys them back" paragraph (added by PLAN-OLLAMA) with the strong-cue recall story: direct slot questions recall dormant facts (stale-marked, rehearsal-refreshed); strong semantic outliers resurrect consolidated turns; decay still governs unprompted surfacing (identity/directive/preference metrics unchanged).
3. A short "Strong-cue recall" paragraph under the retrieval/Embedders discussion: the `stale` flag, `(last mentioned …)` rendering, `resurrectZ` config knob, rehearsal semantics.
4. Maturity table: update the retrieval row ("medium/long paraphrase is decay-bound by design" is no longer true).
5. "When NOT to use this": unchanged.

- [ ] **Step 2: Verify** — `npm test 2>&1 | tail -3 && npm run check` (docs-only, sanity).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: strong-cue recall — measured eval lift, stale semantics, resurrectZ [RECALL 10]"
```

---

## Execution notes

- Tasks 1→5 (slot path) and 6→7 (vector path) are independent of each other but both must precede Task 9. Execute in numbered order for simplicity.
- The eval thresholds WILL fail between Tasks 6 and 9 (normalization + recall change measured numbers before re-baselining). That's expected; `npm test` runs eval-threshold tests, so judge intermediate `npm test` failures accordingly — only non-eval failures block.
- If "I work at Initech." doesn't extract `works_at` (Task 2), or fixture option names differ (Task 5), adapt the helper to the actual extractor/fixture API — assertions stay as written.
- Spec deviation to honor knowingly: the spec sketched `promoteFacts(query, profile, { dormant })`; the implementation puts `dormant` ON the profile (ProfileSummary.dormant), which keeps floors applied in exactly one place (`SemanticStore.profile`). Same intent, cleaner seam.
