# Design — `recall(query)` agent tool (PR 3 of cog-LTM bridge roadmap)

**Date:** 2026-06-13
**Topic:** recall-tool
**Branch:** `feat/recall-tool`
**Parent roadmap:** `docs/plans/2026-06-13-cog-ltm-bridge.md` (PR 3 section)
**Predecessor PR:** #96 (Bridge 1 — `recordObservation()` + reconciler), shipped 2026-06-13.

## Purpose

A single tool call, `recall(query)`, returns interleaved hits from both
memory substrates (cog full-text grep + LTM semantic retrieve), labeled by
source, deduped by origin. Makes Bridge 1's mirror visible and useful to
the agent without it having to call two different tools and merge results
in prose.

## Context

Bridge 1 (PR #96) wired cog observations to mirror into LTM as
`kind: "observation"` records with `origin: "cog:<path>/<file>#<sha256-12>"`.
Both substrates now hold a complete view of every observation, plus their
own unique content (cog: wiki pages, action items, dev-logs; LTM:
conversational turns, episodic snapshots, profile facts). The agent today
has `cog_search` (grep over cog only) but no way to query LTM. `recall`
fixes that asymmetry.

## Non-goals (deferred)

- **Filter parameter** (`filterTags`, `scopePaths`). Roadmap mentioned
  `recall(query, {filterTags})` but we deferred this in brainstorm. Reasons:
  (a) the two substrates use different coordinate systems (LTM tags vs cog
  paths) — conflating them in one param is a footgun; (b) Bridge 1 just
  shipped, we have zero usage data on whether agents will actually want
  scoped recall; (c) agents can compose `recall("infra ltm bridge")` for
  lexical scoping in the query itself. If filtering becomes necessary later,
  add separate `filterTags?` (LTM only) + `scopePaths?` (cog only) params —
  not a single conflated one.
- **Promotion / write-back**. LTM fact promotion into cog observations is
  PR 2's job, after we have real LTM data to tune gates against.
- **Ranking heuristics**. Cog hits get `score: 1.0` (informational only);
  LTM hits get their native retrieve score. Ordering is strict alternation,
  not score-based merge. A "real" cross-substrate ranking function would
  be its own design problem; YAGNI.

## Design

### Module layout

New file: `server/src/memory/recall.ts` (~80 LOC).
Exports:
- `recall(query: string): Promise<RecallResult>` — the function.
- `type RecallHit` — per-hit normalized shape.
- `type RecallResult` — outer envelope.

Tool registration in `server/src/tools/cog.ts` via `createCogTools()`,
alongside the existing `cog_search`.

Module dependencies (no reverse deps):
- `server/src/memory/index.ts` — uses `memory.search()` + `memory.getLtm()`.
- `server/src/memory/bridge/ltm-observer.ts` — uses `parseObservationLine`
  to extract tags from cog hits that are observation-shaped.

### Per-hit shape

```ts
export type RecallHit = {
  from: "cog" | "ltm";
  text: string;              // trimmed matched content
  where: string;
                             // cog: "<path>:<line>" (e.g. "cog-meta/observations.md:14")
                             // ltm: "ltm:<record.id>" (e.g. "ltm:obs-c3f2962779f0")
  score: number;             // cog=1.0 (informational), ltm=native score
  stale?: boolean;           // pass-through from LTM (dormant fact / resurrected); absent on cog
  tags?: string[];           // populated when cog hit parses as observation, OR when LTM record carries tags
};

export type RecallResult = {
  hits: RecallHit[];
  cogCount: number;          // total cog grep matches BEFORE truncating to 5
  ltmCount: number;          // LTM retrieve item count BEFORE dedupe
  dropped: number;           // LTM hits dropped by origin-based dedupe
};
```

### Algorithm

```ts
async function recall(query: string): Promise<RecallResult> {
  // 1. Fan out, swallowing per-substrate errors.
  const cogRaw = await memory.search(query).catch((err) => {
    console.warn("[recall] cog search failed:", err.message);
    return {results: [], count: 0};
  });
  const ltm = memory.getLtm();
  const ltmRaw = ltm
    ? await ltm.retrieve(query, {k: 5}).catch((err) => {
        console.warn("[recall] ltm retrieve failed:", err.message);
        return {items: [], profile: null};
      })
    : {items: [], profile: null};

  // 2. Normalize cog hits (top 5). Parse observation lines for tags.
  const cogHits: RecallHit[] = cogRaw.results.slice(0, 5).map((r) => {
    const parsed = parseObservationLine(r.text);
    return {
      from: "cog" as const,
      text: r.text.trim(),
      where: `${r.path}:${r.line}`,
      score: 1.0,
      ...(parsed ? {tags: parsed.tags} : {}),
    };
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
  for (const item of ltmRaw.items.slice(0, 5)) {
    const record = item.record;
    if (record.kind === "observation" && record.origin) {
      const prefix = record.origin.split("#")[0];
      if (cogOriginPrefixes.has(prefix)) {
        dropped++;
        continue;
      }
    }
    ltmHits.push({
      from: "ltm" as const,
      text: record.text.trim(),
      where: `ltm:${record.id}`,
      score: item.score,
      ...(item.stale ? {stale: true} : {}),
      ...(record.tags && record.tags.length ? {tags: record.tags} : {}),
    });
  }

  // 5. Interleave: cog[0], ltm[0], cog[1], ltm[1], ...
  const hits: RecallHit[] = [];
  const max = Math.max(cogHits.length, ltmHits.length);
  for (let i = 0; i < max; i++) {
    if (i < cogHits.length) hits.push(cogHits[i]);
    if (i < ltmHits.length) hits.push(ltmHits[i]);
  }

  return {hits, cogCount: cogRaw.count, ltmCount: ltmRaw.items.length, dropped};
}
```

### Design decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Dedupe strategy | Origin-based (cog wins on path match) | Precise, cheap; cog `path:line` is the better `where`. |
| Score / ordering | Strict alternation, score informational only | Roadmap intent. Cog has no native score; inventing one is a separate design problem. |
| Filter param | Deferred (none in PR 3) | Two coord systems; no usage data; YAGNI. Documented above. |
| LTM surface change | None — narrow `record.kind` at call site | Zero coupling beyond public types. |
| Tool name | `recall` (no prefix) | Spans substrates; `cog_*` no longer accurately bounds. |
| Cog hit tags | Parse via `parseObservationLine` when shape matches | Symmetry with LTM hits; avoids dedupe-loses-tags asymmetry. |

### Dedupe edge case (over-drop trade-off)

The dedupe key is the origin **prefix** `cog:<path>`, not the full origin
`cog:<path>#<sha256>`. Reasons: cog grep returns the line TEXT, which may
have leading/trailing whitespace variance vs the sha256-hashed line; path
matching is robust to that. Trade-off: when a cog hit AND a different-text
LTM observation both come from the same file, the LTM one is dropped. We
accept this — cog wins for that file's coverage anyway; the agent can
ask a different query if it needs broader scope. Test case 10 documents
this so behavior change is visible.

### Error handling

- Per-substrate errors swallowed; tool never throws.
- Substrate-level catch logs `console.warn("[recall] <substrate> failed:", err.message)` so failures are visible in journalctl without breaking the tool.
- `getLtm() === null` is normal (LTM may not be attached in some configs);
  cog-only path silently returns cog hits.
- Empty input on both sides yields `{hits: [], cogCount: 0, ltmCount: 0, dropped: 0}` — no NaN, no undefined-deref.

## Testing

`server/test/memory/recall.test.ts`, ~150 LOC, one `describe("recall")` block.

Setup per test: `process.env.YTSEJAM_MEMORY_DIR = tmpRoot`, fresh
`MemorySystem.open()` at `tmpRoot/ltm`, seed via `memory.recordObservation()`
to populate both substrates. Teardown: detach LTM, close, delete env,
rm tmpRoot.

### Cases

1. **Merge order alternates** — 3 cog observations + 3 LTM-only records; query matches all 6; assert strict `cog, ltm, cog, ltm, cog, ltm`.
2. **Dedupe by origin** — 1 observation via `memory.recordObservation()` (lands in both); query matches; assert `hits.length === 1`, `from === "cog"`, `dropped === 1`.
3. **Stale flag pass-through** — LTM record forced dormant; assert `hits.find(h => h.from === "ltm" && h.stale === true)` present.
4. **Empty cog side** — only LTM seeded; assert `cogCount === 0`, all hits `from === "ltm"`, no errors.
5. **Empty LTM side** — LTM closed / never attached; assert `ltmCount === 0`, all hits `from === "cog"`, no errors (`getLtm()===null` branch).
6. **Both empty** — query nothing matches; assert `{hits: [], cogCount: 0, ltmCount: 0, dropped: 0}`.
7. **Cog observation → tags present** — observation with `tags: ["smoke", "test"]`; assert cog hit's `tags === ["smoke", "test"]`.
8. **Cog non-observation → tags OMITTED** — wiki page hit (not observation-shaped); assert `"tags" in hit === false` (mutant-kill the explicit-undefined-set bug per lessons/testing.md).
9. **Substrate error swallowed** — mock `memory.search` to throw; assert recall still returns LTM hits + `cogCount === 0` + no throw. Mirror for LTM. Implementer must mutation-test by removing the `.catch` and confirming the test fails.
10. **Over-drop guard** — cog hit in `domain-A/observations.md` + LTM-only record with origin `cog:domain-A/observations.md#different-sha`; assert `dropped === 1`. Documents the path-prefix trade-off.

### Gate

`scripts/gate.sh` standard. Expected delta: +10 tests, gate green.

### Manual smoke (Brian, post-merge)

In a fresh ytsejam session: `recall("bridge1 substrate-validation smoke")`.
Expected:
- Cog hit at `cog-meta/observations.md:<line>` (the smoke entry written 2026-06-13 at 06:51).
- `dropped >= 1` (the LTM dup `obs-c3f2962779f0` dropped on path match).
- `cogCount >= 1`, `ltmCount >= 1` before dedupe; final `hits` shows cog winner.

## Open questions / risks

- **Risk**: LTM `retrieve()` returns `RetrievalResult` whose `record` union (`EpisodicRecord | PromotedFact`) is at `packages/ltm/src/types.ts`. If LTM ever adds a third record kind without `kind` discriminator, the narrowing on line 27 (`if (record.kind === "observation")`) silently skips it for dedupe. Mitigation: explicit `record.kind` check — anything other than `"observation"` is kept (correct fallback: dedupe is opt-in, default keep).
- **Risk**: `score: 1.0` for cog hits could mislead an agent that sorts by score. Mitigation: tool description names ordering explicitly ("interleaved cog+LTM, not score-ranked").
- **Open**: should the description teach agents WHEN to use `recall` vs `cog_search` vs raw LTM access? Decision: yes, in the tool description. Draft: "Use when you want to know what we know about something without caring which substrate it lives in. For grep-style search of cog notes only, use `cog_search`."

## Roadmap context

After PR 3 ships:
- **PR 2** (next): LTM fact promotion → cog observation. Larger (~2-3 days),
  needs Bridge 1 + recall live to surface candidates.
- **Future filter param** (deferred): revisit when there's usage data showing agents wanting scoped recall. Shape if added: `recall(query, {filterTags?: string[], scopePaths?: string[]})` — separate params, never conflated.
