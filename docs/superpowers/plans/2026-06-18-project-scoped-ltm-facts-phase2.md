# Project-Scoped LTM Facts (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Facts carry an optional project scope. The extractor classifies each fact `global|project`; the system stamps the resolved project tag (from Phase 1's resolver) at ingest; recall/profile surface global facts always + active-project facts when their project is active. Additive, back-compatible.

**Architecture:** `FactCandidate.scope` (the classification) + `SemanticFact.projectTag` (the resolved tag). `factId` appends `@<tag>` only when a tag is present, so global facts keep identical ids (back-compat) and a global vs project fact with the same predicate/object are distinct and contradict independently. The active project tag flows from the session workdir (Phase 1's `projectTagForWorkdir`) through the ingest path to `assertFact`.

**Tech Stack:** TypeScript, vitest. Phase 1 (merged on this branch) provides `projectTagForWorkdir`, `loadManifest`, the `workingDir` domain attribute.

## Global Constraints

- `ltm` package stays network-free; scope CLASSIFICATION rides the server-side `CopilotFactExtractor`; the package gets the `scope` field + stamping mechanics only.
- Back-compat: existing untagged facts must load and behave as global; `factId` for a global (no projectTag) fact must be byte-identical to today (`fact-${kind}-${predicate}-${slug(objectNorm)}-${p|n}`).
- The model returns only `scope: "global" | "project"` — never a project id. The system supplies the resolved tag from Phase 1's resolver.
- `scope="project"` but no active project tag → store as GLOBAL (can't scope without a project).
- Do not change decay, the reinforcement formula, redaction, or episodic behavior.
- Tests: `cd packages/ltm && npx vitest run test/<f>` / `npm run check`; `cd server && ...`.

---

### Task 1: `scope` on `FactCandidate`, `projectTag` on `SemanticFact`, scoped `factId`

**Files:**
- Modify: `packages/ltm/src/semantic/extract.ts` (`FactCandidate`, `factId`)
- Modify: `packages/ltm/src/types.ts` (`SemanticFact`)
- Test: `packages/ltm/test/fact-scope-id.test.ts`

**Interfaces:**
- Produces: `FactCandidate.scope?: "global" | "project"` (default treated as global); `SemanticFact.projectTag?: string`; `factId(c, objectNorm, projectTag?)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ltm/test/fact-scope-id.test.ts
import { describe, it, expect } from "vitest";
import { factId } from "../src/semantic/extract.ts";

const c = { kind: "directive" as const, predicate: "uses", polarity: 1 as const };

describe("factId project scoping", () => {
  it("is byte-identical to the legacy form when no projectTag (back-compat)", () => {
    expect(factId(c, "gate.sh before commit")).toBe("fact-directive-uses-gate-sh-before-commit-p");
  });
  it("appends @<tag> when a projectTag is present", () => {
    expect(factId(c, "gate.sh before commit", "projects:ytsejam"))
      .toBe("fact-directive-uses-gate-sh-before-commit-p@projects-ytsejam");
  });
  it("distinguishes a global and a project fact with the same predicate/object", () => {
    expect(factId(c, "gate.sh")).not.toBe(factId(c, "gate.sh", "projects:ytsejam"));
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`factId` ignores the 3rd arg).

- [ ] **Step 3: Add the fields.** In `extract.ts`, add to `FactCandidate`: `scope?: "global" | "project";`. In `types.ts`, add to `SemanticFact`: `/** Resolved project tag (e.g. "projects:ytsejam"); absent = global. */ projectTag?: string;`.

- [ ] **Step 4: Update `factId`.**

```ts
export function factId(
  c: Pick<FactCandidate, "kind" | "predicate" | "polarity">,
  objectNorm: string,
  projectTag?: string,
): string {
  const base = `fact-${c.kind}-${c.predicate}-${slug(objectNorm)}-${c.polarity > 0 ? "p" : "n"}`;
  return projectTag ? `${base}@${slug(projectTag)}` : base;
}
```

- [ ] **Step 5: Run it — PASS.** Then `cd packages/ltm && npm run check`.

- [ ] **Step 6: Commit**

```bash
git add packages/ltm/src/semantic/extract.ts packages/ltm/src/types.ts packages/ltm/test/fact-scope-id.test.ts
git commit -m "feat(ltm): scope on FactCandidate, projectTag on SemanticFact, scoped factId"
```

---

### Task 2: `assertFact`/`ingestTurn` stamp the project tag (scope-aware)

**Files:**
- Modify: `packages/ltm/src/semantic/store.ts` (`ingestTurn`, `assertFact`)
- Test: `packages/ltm/test/semantic-scope-stamp.test.ts`

**Interfaces:**
- Consumes: `factId(c, objectNorm, projectTag)` (Task 1).
- Produces: `ingestTurn(turn, projectTag?: string)`; `assertFact(..., at, projectTag?: string)`. Stamping rule: a candidate with `scope === "project"` AND a non-empty `projectTag` → `fact.projectTag = projectTag` and the id is scoped; otherwise the fact is global (no tag).

- [ ] **Step 1: Write the failing test** (uses a temp `SemanticStore` + an injected fake extractor returning scoped candidates):

```ts
// packages/ltm/test/semantic-scope-stamp.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { SemanticStore } from "../src/semantic/store.ts";
import type { FactExtractor, FactCandidate } from "../src/semantic/fact-extractor.ts";
import type { Turn } from "../src/types.ts";

class Fake { constructor(private out: FactCandidate[]) {} async extract(): Promise<FactCandidate[]> { return this.out; } }
let dir: string; afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltm-scope-")));
const turn: Turn = { sessionId: "s", entryId: "e", role: "user", text: "x", timestamp: "2026-06-18T00:00:00Z" };

describe("scope stamping", () => {
  it("stamps projectTag when scope=project and a tag is active", async () => {
    const store = SemanticStore.open(tmp(), new Fake([{ kind: "directive", predicate: "uses", object: "gate.sh", polarity: 1, initialStrength: 0.8, scope: "project" }]) as unknown as FactExtractor);
    await store.ingestTurn(turn, "projects:ytsejam");
    const f = store.allFacts().find((x) => x.object === "gate.sh");
    expect(f?.projectTag).toBe("projects:ytsejam");
  });
  it("leaves global when scope=global", async () => {
    const store = SemanticStore.open(tmp(), new Fake([{ kind: "identity", predicate: "name", object: "Brian", polarity: 1, initialStrength: 0.9, scope: "global" }]) as unknown as FactExtractor);
    await store.ingestTurn(turn, "projects:ytsejam");
    expect(store.allFacts().find((x) => x.object === "Brian")?.projectTag).toBeUndefined();
  });
  it("stays global when scope=project but no active tag", async () => {
    const store = SemanticStore.open(tmp(), new Fake([{ kind: "directive", predicate: "uses", object: "gate.sh", polarity: 1, initialStrength: 0.8, scope: "project" }]) as unknown as FactExtractor);
    await store.ingestTurn(turn, undefined);
    expect(store.allFacts().find((x) => x.object === "gate.sh")?.projectTag).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`ingestTurn` takes 1 arg; no stamping).

- [ ] **Step 3: Thread + stamp.** In `store.ts`:
  - `ingestTurn(turn: Turn, projectTag?: string): Promise<void>` — when iterating candidates, compute the effective tag: `const tag = candidate.scope === "project" && projectTag ? projectTag : undefined;` and pass it: `this.assertFact(candidate.kind, candidate.predicate, candidate.object, candidate.polarity, candidate.initialStrength, source, turn.timestamp, tag);`
  - `assertFact(kind, predicate, object, polarity, initialStrength, source, at, projectTag?: string)`: compute `const id = factId({ kind, predicate, polarity }, objectNorm, projectTag);`. On the NEW-fact branch set `projectTag` on the created `SemanticFact` (only when defined — use a conditional spread to keep it absent for globals, preserving back-compat). The existing reinforcement branch keys off the scoped `id`, so a project fact reinforces/contradicts only its own scope automatically.

> Preserve the existing reinforcement/contradiction/decay logic exactly — only the `id` derivation and the new-fact `projectTag` field change.

- [ ] **Step 4: Run it — PASS.** Then `cd packages/ltm && npm run check` and `npx vitest run` (existing semantic/ingest tests must stay green — async `ingestTurn(turn, tag?)` is back-compatible since the 2nd arg is optional).

- [ ] **Step 5: Commit**

```bash
git add packages/ltm/src/semantic/store.ts packages/ltm/test/semantic-scope-stamp.test.ts
git commit -m "feat(ltm): stamp project tag on facts (scope-aware assertFact/ingestTurn)"
```

---

### Task 3: Thread `projectTag` through the ingest pipeline

**Files:**
- Modify: `packages/ltm/src/api/memory-system.ts` (`ingestSessionFile`/`ingestSessionDir`, the `recordObservation` ingest call)
- Modify: `packages/ltm/src/pipeline/ingest.ts` (pass tag to `ingestTurn`)
- Test: `packages/ltm/test/ingest-projecttag.test.ts`

**Interfaces:**
- Produces: `ingestSessionFile(filePath, opts?: { projectTag?: string })`; the pipeline forwards `opts.projectTag` to each `ingestTurn(turn, projectTag)`. Default (no opts) = unchanged (global).

- [ ] **Step 1: Write the failing test** — ingest a small session JSONL (one user turn) with `{ projectTag: "projects:ytsejam" }` through `MemorySystem.open({ storeDir, factExtractor: fake-returning-scope-project })`, assert the resulting fact carries `projectTag`. (Implementer: mirror existing ingest tests for session-file fixtures; if `ingestSessionFile` is heavier to fixture than `ingestTurn`, test the `IngestPipeline` directly with an injected semantic store spy.)

- [ ] **Step 2: Run it — FAIL.**

- [ ] **Step 3: Thread the option.** Add `opts?: { projectTag?: string }` to `ingestSessionFile` (and `ingestSessionDir` forwarding it). Pass `opts?.projectTag` into the `IngestPipeline` run and through to `this.deps.semantic.ingestTurn(turn, projectTag)` (`pipeline/ingest.ts:92`). For the `recordObservation` ingest call (`memory-system.ts:269`), observations are global (no session project) — pass no tag (keep global). Verify the `IngestPipeline` API for the cleanest way to pass per-run options.

- [ ] **Step 4: Run it — PASS.** `cd packages/ltm && npm run check && npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add packages/ltm/src/api/memory-system.ts packages/ltm/src/pipeline/ingest.ts packages/ltm/test/ingest-projecttag.test.ts
git commit -m "feat(ltm): thread projectTag through ingestSessionFile -> ingestTurn"
```

---

### Task 4: Extractors emit `scope`

**Files:**
- Modify: `packages/ltm/src/semantic/fact-extractor.ts` (`RegexFactExtractor` → `scope: "global"`)
- Modify: `server/src/memory/fact-extractor.ts` (`CopilotFactExtractor` schema/prompt + mapping)
- Test: `packages/ltm/test/fact-extractor.test.ts` (extend), `server/test/copilot-fact-extractor.test.ts` (extend)

**Interfaces:**
- Produces: every `FactCandidate` carries `scope`. Regex always `"global"`. Copilot maps the LLM's per-fact `scope` (`"global"|"project"`, default `"global"` when omitted/invalid).

- [ ] **Step 1: Write failing tests.** (ltm) `RegexFactExtractor.extract("my name is Brian")` → candidate has `scope: "global"`. (server) the `extract_user_facts` tool result `{...scope:"project"}` → returned candidate has `scope:"project"`; missing/invalid `scope` → `"global"`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - `RegexFactExtractor.extract`: map each `extractFacts` candidate to include `scope: "global"`.
  - `CopilotFactExtractor`: add `scope: { type: "string", enum: ["global","project"] }` to the tool schema's per-fact properties (NOT required — default global). Update `SYSTEM_PROMPT`: "Set scope=project for facts specific to the current codebase/repo/task (e.g. a build/test/deploy rule for this project); scope=global for identity and general preferences. Default to global." In `toCandidates`, read `scope` → `cand.scope = (raw.scope === "project") ? "project" : "global"`.

- [ ] **Step 4: Run — PASS.** Typecheck both packages.

- [ ] **Step 5: Commit**

```bash
git add packages/ltm/src/semantic/fact-extractor.ts server/src/memory/fact-extractor.ts packages/ltm/test/fact-extractor.test.ts server/test/copilot-fact-extractor.test.ts
git commit -m "feat(extract): classify fact scope (global|project)"
```

---

### Task 5: Server wires the active project tag at ingest

**Files:**
- Modify: `server/src/memory/ltm-ingest-sink.ts` (sink type allows the opts arg)
- Modify: `server/src/manager.ts` (resolve + pass the tag at the ingest call ~line 447)
- Modify: `server/src/index.ts` (provide an `activeProjectTag(sessionId)` resolver to the manager)
- Test: covered by typecheck + full server suite (integration wiring)

**Interfaces:**
- Consumes: `projectTagForWorkdir`, `loadManifest`, `resolveWorkdir` (Phase 1; `domainManifest` is already loaded at boot in `index.ts`).
- Produces: at `agent_end` ingest, `ingestSessionFile(path, { projectTag })` is called with the session's resolved project tag.

- [ ] **Step 1:** Update `LtmIngestSink` (`Pick<MemorySystem, "ingestSessionFile">` already carries the new optional opts arg from Task 3 — confirm the Pick still type-checks; widen if needed).

- [ ] **Step 2:** In `manager.ts`, add a manager option `activeProjectTag?: (sessionId: string) => string | null;`. At the `agent_end` ingest call (~line 447), resolve `const projectTag = this.opts.activeProjectTag?.(opened.id) ?? undefined;` and pass `ingestSessionFile(opened.metadata.path, projectTag ? { projectTag } : undefined)`. Keep it best-effort (the existing `void`/catch posture).

- [ ] **Step 3:** In `index.ts`, wire `activeProjectTag: (sessionId) => projectTagForWorkdir(domainManifest, resolveWorkdir(workdirs, sessionId, config.dataDir))` on the manager opts (reuse the boot-loaded `domainManifest`).

- [ ] **Step 4: Verify** `cd server && npm run check && npx vitest run` (full suite green).

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/ltm-ingest-sink.ts server/src/manager.ts server/src/index.ts
git commit -m "feat(server): stamp the active project tag at agent_end ingest"
```

---

### Task 6: Scope-aware profile + retrieval

**Files:**
- Modify: `packages/ltm/src/semantic/store.ts` (`profile(now, profileCfg, activeProjectTag?)`)
- Modify: fact-promotion in retrieval if it surfaces facts (`packages/ltm/src/retrieval/promote.ts` or wherever `profile`/facts feed retrieval)
- Test: `packages/ltm/test/profile-scope.test.ts`

**Interfaces:**
- Produces: `profile(now, profileCfg, activeProjectTag?: string)` returns global facts always + facts whose `projectTag === activeProjectTag`. With no active tag → globals only. Project facts of OTHER projects are excluded.

- [ ] **Step 1: Write the failing test** — seed a store with a global fact and two project facts (`projects:ytsejam`, `projects:other`); assert `profile(now, cfg, "projects:ytsejam")` includes the global + ytsejam facts and excludes `projects:other`; `profile(now, cfg)` (no tag) includes only the global.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add an optional `activeProjectTag` param to `profile()`; before grouping facts into identity/preferences/etc., filter: keep a fact when `!fact.projectTag` (global) OR `fact.projectTag === activeProjectTag`. Verify the real `profile` signature/body and the call sites (`memory-system.ts` calls `this.semantic.profile(now, this.config.profile)`); thread the active tag from those call sites (the server passes it; for the recall/profile read path the active tag comes from the same `projectTagForWorkdir` resolver — `MemorySystem.retrieve`/`profile` gains an optional `activeProjectTag` option, defaulting to undefined = globals only).

> Threading the active tag into the READ path mirrors Task 5's write path. If the read-path threading is larger than expected, scope this task to the `SemanticStore.profile` filter + its `MemorySystem` passthrough, and note any remaining call-site wiring for a follow-up — the core scoping (storage + write stamping) is the load-bearing part.

- [ ] **Step 4: Run — PASS.** `cd packages/ltm && npm run check && npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add packages/ltm/src/semantic/store.ts packages/ltm/src/retrieval/promote.ts packages/ltm/test/profile-scope.test.ts
git commit -m "feat(ltm): scope-aware profile (globals + active-project facts)"
```

---

### Task 7: Full-suite green

- [ ] `cd packages/ltm && npx vitest run && npm run check`
- [ ] `cd server && npx vitest run && npm run check`
- [ ] `cd web && npm run build && npm test`
- [ ] Commit any incidental fixes; else report clean.

---

## Self-Review

- **Spec coverage:** scope field + projectTag + scoped factId (T1) ✓; assert-time stamping incl. scope=project+no-tag→global (T2) ✓; ingest threading (T3) ✓; extractor scope classification, regex=global + copilot schema/prompt (T4) ✓; server active-tag wiring at ingest reusing Phase 1 resolver (T5) ✓; scope-aware profile/retrieval (T6) ✓; back-compat (T1 byte-identical global id; T2 optional arg; untagged facts load as global) ✓; out-of-scope cog removal honored (not touched).
- **Placeholders:** none — core ltm tasks (T1/T2/T4/T6) carry real code; T3/T5/T6 name exact files + verify-against-real-signature steps for the threading whose surrounding code isn't quoted.
- **Type consistency:** `factId(c, objectNorm, projectTag?)`, `FactCandidate.scope`, `SemanticFact.projectTag`, `ingestTurn(turn, projectTag?)`, `ingestSessionFile(path, {projectTag?})`, `activeProjectTag(sessionId)`, `profile(now, cfg, activeProjectTag?)` used consistently.
