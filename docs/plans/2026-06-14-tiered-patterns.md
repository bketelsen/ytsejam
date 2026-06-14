# Tiered Patterns Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Split `cog-meta/patterns.md` (current single global tier, 7683B / 65 lines, band-aid cap 8000B) into a global tier (`cog-meta/patterns.md`, 6000B cap) plus per-domain tier (`{domain-path}/patterns.md`, 3500B cap each loaded on domain skill activation). Bound CONCURRENT context (global + active domain), not a combined sum.

**Spec:** `docs/plans/2026-06-14-tiered-patterns-design.md`

**Architecture:** Content migration (Harness Discipline + Subagent Execution sections leave `cog-meta/patterns.md` for new `projects/ytsejam/patterns.md`); `housekeeping.ts` cap split + recursive per-domain scan; generated domain skills add `cog_read("{path}/patterns.md")` to activation block; `/reflect` Gate 3 LLM-classifies tier (global vs domain) before write.

**Tech Stack:** TypeScript (Node 22+), vitest (server), node:test (web), markdown skill playbooks. Worktree pre-built; gate green at baseline.

**Worktree:** `/home/bjk/projects/.worktrees/tiered-patterns` (NOT `/tmp/` — long-lived worktrees go to `~/projects/.worktrees/` per the Parallel Task Safety patterns rule about systemd-tmpfiles sweep)

**Branch:** `feat/tiered-patterns`

**Baseline gate:** PASSED 2026-06-14 23:33 UTC (server 491 + web 124, post `npx patch-package` to apply `@earendil-works/pi-ai` patch — `--ignore-scripts` skipped postinstall in my original npm install).

---

## Task ordering

Tasks are ordered so each one leaves the gate green. Commits land as the design-approved 4-commit structure:

| Commit | Tasks |
|---|---|
| 1: content split | Task 1 |
| 2: code (caps + scan) | Tasks 2-5 |
| 3: skill template | Task 6 |
| 4: reflect Gate 3 | Task 7 |

---

### Task 1: Content split — migrate Harness Discipline + Subagent Execution to ytsejam tier

**Files:**
- Modify: `/home/bjk/.ytsejam/data/memory/cog-meta/patterns.md` (remove 2 sections)
- Create: `/home/bjk/.ytsejam/data/memory/projects/ytsejam/patterns.md` (receives 2 sections + L0)

**Important context:** This file lives in the LIVE memory store, not the repo. The repo has `data/` gitignored; this is the running agent's data. The commit happens via the cog memory auto-commit cadence + reconcile, NOT via `git add` in the ytsejam repo. The change must:
1. Use `cog_patch` to remove the 2 sections from `cog-meta/patterns.md`
2. Use shell write (cog_write rejects whole-file canonical patterns.md writes) to create `projects/ytsejam/patterns.md`
3. Trigger reconcile so the LTM mirror catches up
4. Verify byte counts before/after balance: `before-bytes ≈ after-global-bytes + after-ytsejam-bytes + ~150B header overhead` (the new L0 summary + section heading)

#### Step 1: Capture starting state
Run:
```bash
wc -c /home/bjk/.ytsejam/data/memory/cog-meta/patterns.md
# Record this number — call it BEFORE_BYTES
```
Expected: ~7683 bytes (file may have drifted slightly — record the actual number).

#### Step 2: Remove Harness Discipline section from cog-meta/patterns.md
Use `cog_patch` with `old_text` = the entire "## Harness Discipline" section including all its bullets, and `new_text` = empty string (drop one trailing blank line too).

The exact section to remove:
```
## Harness Discipline

- ytsejam is a harness for using tools well, not a re-implementation. Skills (markdown) cheap; server-side TS expensive + sticky. Bias: skill > helper-heavy skill > server code. Plans crossing `server/src/` earn a Justify-server-change gate. Substrate-swap urges fail by default.
- Don't describe ytsejam (or any system Brian owns) as having a feature without grepping for it. Default assumption for any control/gate/policy/approval/audit/quota surface: doesn't exist unless verified.
- Infrastructure over instructions: prefer hooks, CI gates, branch protection over prompt-only prohibitions.
- Don't fight a framework that owns the process: when adding CLI/lifecycle behavior to a 3rd-party harness binary, intercept in the arg layer you own BEFORE serve/run and exit — never patch the read-only dep.
- A dev/test launcher SETs every isolation-critical env var explicitly (port, data dir, socket, web-dist, clear NODE_ENV), never inherits — sourced-prod shell leaks prod paths into dev.

```

#### Step 3: Remove Subagent Execution section from cog-meta/patterns.md
Use `cog_patch` to remove the entire "## Subagent Execution" section. Capture the exact section text from the live file with `cog_read("cog-meta/patterns.md", section="Subagent Execution")` first to get the current bullets verbatim.

#### Step 4: Create projects/ytsejam/patterns.md with the 2 sections
The cog allow-list rejects `cog_write` on patterns.md files. Use shell write directly to the data dir:

```bash
cat > /home/bjk/.ytsejam/data/memory/projects/ytsejam/patterns.md <<'EOF'
<!-- L0: ytsejam-specific harness discipline and subagent execution rules -->

# ytsejam — Domain Patterns

<!-- Edit in place. ≤40 lines / 3KB. Loaded by the ytsejam domain skill on activation. -->

## Harness Discipline

- ytsejam is a harness for using tools well, not a re-implementation. Skills (markdown) cheap; server-side TS expensive + sticky. Bias: skill > helper-heavy skill > server code. Plans crossing `server/src/` earn a Justify-server-change gate. Substrate-swap urges fail by default.
- Don't describe ytsejam (or any system Brian owns) as having a feature without grepping for it. Default assumption for any control/gate/policy/approval/audit/quota surface: doesn't exist unless verified.
- Infrastructure over instructions: prefer hooks, CI gates, branch protection over prompt-only prohibitions.
- Don't fight a framework that owns the process: when adding CLI/lifecycle behavior to a 3rd-party harness binary, intercept in the arg layer you own BEFORE serve/run and exit — never patch the read-only dep.
- A dev/test launcher SETs every isolation-critical env var explicitly (port, data dir, socket, web-dist, clear NODE_ENV), never inherits — sourced-prod shell leaks prod paths into dev.

## Subagent Execution

<!-- copy the verbatim bullets captured in Step 3 here -->
EOF
```

Then trigger `cog_rpc("reconcile_now")` to register the file with the store.

#### Step 5: Verify byte arithmetic
Run:
```bash
B=$(wc -c < /home/bjk/.ytsejam/data/memory/cog-meta/patterns.md)
Y=$(wc -c < /home/bjk/.ytsejam/data/memory/projects/ytsejam/patterns.md)
echo "global=$B  ytsejam=$Y  combined=$((B+Y))  BEFORE_BYTES=<from Step 1>"
```
Expected:
- `global` (B) ≤ 6000 (well under the new global cap)
- `ytsejam` (Y) ≤ 3500 (under the per-domain cap)
- `combined` ≈ `BEFORE_BYTES` + ~200 bytes overhead (new L0 + heading)
- If `global` > 6000 or `ytsejam` > 3500: STOP — the split sizing is wrong, re-examine which sections went where.

#### Step 6: Verify ytsejam patterns.md has L0 header (linter requirement)
Run:
```bash
head -1 /home/bjk/.ytsejam/data/memory/projects/ytsejam/patterns.md | grep -E '<!-- L0:'
```
Expected: matches.

#### Step 7: Commit (commit 1 of 4)
Per the design, commit 1 is content-only. **BUT** the content lives in the LIVE memory store at `~/.ytsejam/data/memory/`, which is `cog-memory-data` — not in the ytsejam repo's working tree at all. The cog memory store has its own git repo under `~/.ytsejam/data/memory/.git`. So this "commit" lands in the **cog memory git history**, NOT in the ytsejam branch.

Run from the cog memory data dir:
```bash
cd /home/bjk/.ytsejam/data/memory
git add cog-meta/patterns.md projects/ytsejam/patterns.md
GIT_EDITOR=true git commit -m "chore(memory): tier patterns split — Harness Discipline + Subagent Execution move to projects/ytsejam/patterns.md

Atomic content migration for ytsejam tiered-patterns split (PR landing in
ytsejam repo). cog-meta/patterns.md now holds 5 cross-project sections;
projects/ytsejam/patterns.md is new and holds the 2 ytsejam-specific
sections.

Byte balance: cog-meta/patterns.md <BEFORE_BYTES_FROM_STEP_1>B → <B from Step 5>B;
projects/ytsejam/patterns.md new at <Y from Step 5>B.

Loaded by the ytsejam domain skill on activation (added in ytsejam PR)."
```

No gate runs against memory-data; the verification IS Steps 5+6. After this commit, the ytsejam repo branch hasn't moved yet — that's correct, the next commits go to the ytsejam repo.

---

### Task 2: Type declarations for new threshold keys

**Files:**
- Modify: `server/src/memory/types.ts` (lines ~177-228)

#### Step 1: Write the failing test
Add to `server/test/memory/consolidated.test.ts` somewhere near the other patterns test (around line 230):
```ts
import type { HousekeepingCaps, HousekeepingThresholds } from "../../src/memory/types.ts";

test("HousekeepingCaps shape includes tiered patterns caps", () => {
  // Type-only assertion via const literal — fails tsc if shape is wrong.
  const _capsShape: Pick<HousekeepingCaps,
    "global_patterns_lines" | "global_patterns_bytes" |
    "domain_patterns_lines" | "domain_patterns_bytes"> = {
    global_patterns_lines: 70,
    global_patterns_bytes: 6000,
    domain_patterns_lines: 40,
    domain_patterns_bytes: 3500,
  };
  expect(_capsShape.global_patterns_bytes).toBe(6000);
});

test("HousekeepingThresholds shape includes domain_patterns_over_cap", () => {
  const _t: Pick<HousekeepingThresholds, "domain_patterns_over_cap"> = {
    domain_patterns_over_cap: [],
  };
  expect(_t.domain_patterns_over_cap).toEqual([]);
});
```

#### Step 2: Run tests to verify they fail
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns/server
npx tsc --noEmit 2>&1 | head -20
```
Expected: fails with errors about `global_patterns_lines`, `domain_patterns_over_cap` not existing on the types.

#### Step 3: Update `server/src/memory/types.ts`
Replace the existing `HousekeepingCaps` interface fields:
```ts
  patterns_lines: number;
  patterns_bytes: number;
```
With:
```ts
  global_patterns_lines: number;
  global_patterns_bytes: number;
  domain_patterns_lines: number;
  domain_patterns_bytes: number;
```

Add a new interface near `PatternsOverCap`:
```ts
export interface DomainPatternsOverCap {
  path: string;
  lines: number;
  size: number;
  lines_cap: number;
  size_cap: number;
}
```

Update `HousekeepingThresholds` to add the new key:
```ts
  domain_patterns_over_cap: DomainPatternsOverCap[];
```

(Keep `patterns_over_cap: PatternsOverCap[]` — it's now the global tier only, semantically. Don't rename the key; the existing field name is fine for the global file.)

#### Step 4: Run tsc + tests
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
bash scripts/gate.sh 2>&1 | tail -10
```
Expected: type checks pass; the 2 new tests pass; everything else still passes (existing `patterns_over_cap` tests in `consolidated.test.ts` will fail because `housekeeping.ts` still references `caps.patterns_bytes` — that's expected, fixed in Task 3).

**STOP-on-bug-signal note:** if tsc fails on something OTHER than the renames being plumbed through (e.g., a third place references `patterns_bytes`), report it before continuing.

#### Step 5: Commit (start of commit 2 of 4)
Don't commit yet — Tasks 2-5 together form commit 2 (the code split). Stage but don't commit:
```bash
git add server/src/memory/types.ts server/test/memory/consolidated.test.ts
```

---

### Task 3: housekeeping.ts cap structure split

**Files:**
- Modify: `server/src/memory/consolidated/housekeeping.ts` (lines 8-22 caps object, line 82 scanPatterns)

#### Step 1: Update caps object
Replace the caps block:
```ts
const caps = {
  observations_entries: 50,
  completed_actions: 10,
  improvements_done: 10,
  hot_memory_lines: 50,
  patterns_lines: 70,
  // TODO(tiered-patterns): temporarily raised 5500→8000 (2026-06-14) to
  // accommodate calibrated multi-failure-mode rules accumulated since the
  // ytsejam supernova. Structural fix is the tiered-patterns split (global
  // <4KB + per-domain <2KB each loaded on activation) tracked as the top
  // wishlist item in cog-meta/improvements.md. Restore to 5500 (or a new
  // global-tier cap) when tiered patterns ships.
  patterns_bytes: 8000,
  dormant_domain_days: 28,
  stale_action_item_days: 14,
  changed_recently_fallback_days: 7,
};
```

With:
```ts
const caps = {
  observations_entries: 50,
  completed_actions: 10,
  improvements_done: 10,
  hot_memory_lines: 50,
  // Global tier: cross-project rules in cog-meta/patterns.md (always loaded
  // via session-brief). Tightened from the band-aid 8000B back to a real
  // cap now that ytsejam-specific rules have moved to per-domain tier.
  global_patterns_lines: 70,
  global_patterns_bytes: 6000,
  // Per-domain tier: project-specific rules in {domain-path}/patterns.md
  // (loaded only when the domain skill activates).
  domain_patterns_lines: 40,
  domain_patterns_bytes: 3500,
  dormant_domain_days: 28,
  stale_action_item_days: 14,
  changed_recently_fallback_days: 7,
};
```

#### Step 2: Rewrite scanPatterns to use global caps
Replace:
```ts
async function scanPatterns(path: string, result: HousekeepingScan): Promise<void> {
  const content = await readOptional(path);
  if (content == null) return;
  const lines = countLines(content);
  const size = Buffer.byteLength(content);
  if (lines > caps.patterns_lines || size > caps.patterns_bytes) {
    result.thresholds.patterns_over_cap.push({ path, lines, size, lines_cap: caps.patterns_lines, size_cap: caps.patterns_bytes });
  }
}
```

With:
```ts
async function scanGlobalPatterns(path: string, result: HousekeepingScan): Promise<void> {
  const content = await readOptional(path);
  if (content == null) return;
  const lines = countLines(content);
  const size = Buffer.byteLength(content);
  if (lines > caps.global_patterns_lines || size > caps.global_patterns_bytes) {
    result.thresholds.patterns_over_cap.push({
      path,
      lines,
      size,
      lines_cap: caps.global_patterns_lines,
      size_cap: caps.global_patterns_bytes,
    });
  }
}
```

#### Step 3: Update the call site
In `housekeepingScan()`, change:
```ts
  await scanPatterns("cog-meta/patterns.md", result);
```
To:
```ts
  await scanGlobalPatterns("cog-meta/patterns.md", result);
```

#### Step 4: Update emptyThresholds() to include the new key
```ts
function emptyThresholds(): HousekeepingThresholds {
  return {
    observations_over_cap: [],
    completed_actions_over_cap: [],
    improvements_implemented_over_cap: [],
    hot_memory_over_cap: [],
    patterns_over_cap: [],
    domain_patterns_over_cap: [],
  };
}
```

#### Step 5: Run tests
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
bash scripts/gate.sh 2>&1 | tail -20
```
Expected: existing test "housekeepingScan action completed cap, stale items, hot-memory, patterns, and improvements" (line ~232) FAILS because it seeds `"x".repeat(9000)` and asserts on `patterns_over_cap[0].size > size_cap`. With the new 6000B global cap, 9000 still trips it, so that assertion still passes — but check carefully: the test passes `"cog-meta/patterns.md"` so it should still flag. The actual failure (if any) will be size_cap value (now 6000 not 8000) — the test asserts `>` not exact, so it should pass.

If the test still passes: great, proceed. If it fails: examine and adjust the seeded payload.

Domain_patterns_over_cap should be present in the threshold response (empty for this test).

#### Step 6: Stage (still part of commit 2)
```bash
git add server/src/memory/consolidated/housekeeping.ts
```

---

### Task 4: Recursive per-domain patterns scan

**Files:**
- Modify: `server/src/memory/consolidated/housekeeping.ts` (add `scanDomainPatterns` + call site)
- Modify: `server/test/memory/consolidated.test.ts` (add tests)

#### Step 1: Write failing tests
Add to `server/test/memory/consolidated.test.ts` near the existing patterns test:
```ts
test("housekeepingScan flags per-domain patterns.md over byte cap", async () => {
  await seed("cog-meta/patterns.md", "ok\n");
  await seed("projects/ytsejam/patterns.md", "y".repeat(5000) + "\n");
  const r = await housekeepingScan();
  expect(r.thresholds.domain_patterns_over_cap).toHaveLength(1);
  expect(r.thresholds.domain_patterns_over_cap[0]).toMatchObject({
    path: "projects/ytsejam/patterns.md",
    size_cap: 3500,
  });
  expect(r.thresholds.domain_patterns_over_cap[0].size).toBeGreaterThan(3500);
});

test("housekeepingScan flags per-domain patterns.md over line cap", async () => {
  await seed("cog-meta/patterns.md", "ok\n");
  await seed("personal/patterns.md", "line\n".repeat(50));
  const r = await housekeepingScan();
  expect(r.thresholds.domain_patterns_over_cap).toHaveLength(1);
  expect(r.thresholds.domain_patterns_over_cap[0]).toMatchObject({
    path: "personal/patterns.md",
    lines_cap: 40,
  });
  expect(r.thresholds.domain_patterns_over_cap[0].lines).toBeGreaterThan(40);
});

test("housekeepingScan does NOT flag cog-meta/patterns.md or glacier/**/patterns.md as domain patterns", async () => {
  await seed("cog-meta/patterns.md", "x".repeat(100));
  await seed("glacier/projects/foo/patterns.md", "y".repeat(10000));  // over any cap, but should be skipped
  const r = await housekeepingScan();
  expect(r.thresholds.domain_patterns_over_cap).toEqual([]);
});

test("housekeepingScan returns empty domain_patterns_over_cap when no domain patterns files exist", async () => {
  await seed("cog-meta/patterns.md", "ok\n");
  const r = await housekeepingScan();
  expect(r.thresholds.domain_patterns_over_cap).toEqual([]);
});
```

#### Step 2: Run tests to verify they fail
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns/server
npx vitest run test/memory/consolidated.test.ts 2>&1 | tail -30
```
Expected: 4 new tests fail with `domain_patterns_over_cap is undefined` or `0 calls`.

#### Step 3: Add scanDomainPatterns helper
Add to `server/src/memory/consolidated/housekeeping.ts`:
```ts
async function scanDomainPatterns(result: HousekeepingScan, all: { per_file: { path: string; size: number }[] }): Promise<void> {
  // Per-domain patterns: any {path}/patterns.md anywhere under the memory
  // root EXCEPT cog-meta/ (the global tier, scanned separately) and
  // glacier/** (read-only archives). Hardcoded exclusions rather than
  // intersecting with domains.yml so orphaned files (e.g. patterns.md left
  // behind by a removed domain) are still surfaced.
  const candidates = all.per_file.filter((f) => {
    if (!f.path.endsWith("/patterns.md")) return false;
    if (f.path === "cog-meta/patterns.md") return false;
    if (f.path.startsWith("glacier/")) return false;
    return true;
  });
  for (const f of candidates) {
    const content = await readOptional(f.path);
    if (content == null) continue;
    const lines = countLines(content);
    const size = Buffer.byteLength(content);
    if (lines > caps.domain_patterns_lines || size > caps.domain_patterns_bytes) {
      result.thresholds.domain_patterns_over_cap.push({
        path: f.path,
        lines,
        size,
        lines_cap: caps.domain_patterns_lines,
        size_cap: caps.domain_patterns_bytes,
      });
    }
  }
  result.thresholds.domain_patterns_over_cap.sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
```

#### Step 4: Wire scanDomainPatterns into housekeepingScan
In `housekeepingScan()`, after the existing `await scanGlobalPatterns(...)` line, add:
```ts
  await scanDomainPatterns(result, all);
```

(`all` is the `await store.stats()` result computed earlier in the function — pass it through to avoid a second scan.)

#### Step 5: Run gate
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
bash scripts/gate.sh 2>&1 | tail -20
```
Expected: PASSED, all 4 new tests green.

#### Step 6: Stage
```bash
git add server/src/memory/consolidated/housekeeping.ts server/test/memory/consolidated.test.ts
```

---

### Task 5: Update existing seeded test fixture + commit code (commit 2)

**Files:**
- Modify: `server/test/memory/consolidated.test.ts` (the existing 9000-byte seed at line ~236)

#### Step 1: Sanity-check the existing patterns test still asserts correctly
Look at line 236: `await seed("cog-meta/patterns.md", "x".repeat(9000) + "\n");` and line 242: `expect(r.thresholds.patterns_over_cap[0].size).toBeGreaterThan(r.thresholds.patterns_over_cap[0].size_cap);`

With the new 6000 cap, 9000B still trips it, and the assertion is `>` not `>=`, so it should pass. But the test seeded 9000 specifically for the band-aid 8000 cap (per the previous PR #135). Now that we're back to a real cap, **drop the seeded size back to a more diagnostic value** — 7000B is clearly over 6000 but documents the new cap intent:

Replace:
```ts
    await seed("cog-meta/patterns.md", "x".repeat(9000) + "\n");
```
With:
```ts
    await seed("cog-meta/patterns.md", "x".repeat(7000) + "\n");
```

#### Step 2: Run gate
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
bash scripts/gate.sh 2>&1 | tail -10
```
Expected: PASSED.

#### Step 3: Commit (commit 2 of 4 — bundles Tasks 2-5)
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
git status --short  # verify exactly these files staged: types.ts, housekeeping.ts, consolidated.test.ts
GIT_EDITOR=true git commit -m "feat(memory): tiered patterns caps + recursive per-domain scan

Splits the single patterns_bytes cap into a global tier
(cog-meta/patterns.md, 6KB) and a per-domain tier
({domain-path}/patterns.md, 3.5KB each). Adds recursive per-domain scan
that finds all */patterns.md files under the memory root excluding
cog-meta/ and glacier/**.

Removes the band-aid TODO(tiered-patterns) comment from the prior 5500→8000
bump (ytsejam PR #135) — the structural fix is now in place.

Caps:
- global_patterns_lines: 70 (unchanged)
- global_patterns_bytes: 6000 (down from band-aid 8000; up from original 5500)
- domain_patterns_lines: 40 (new)
- domain_patterns_bytes: 3500 (new)

Threshold output gains domain_patterns_over_cap[] alongside existing
patterns_over_cap[] (which now means global tier only).

Per the design doc, per-domain patterns are loaded by the domain skill on
activation — that's a separate commit (skill template change)."
```

---

### Task 6: Skill template — generated domain skills read {path}/patterns.md on activation

**Files:**
- Modify: `server/skills/cog.md` (Phase 3d template, around line 160)

#### Step 1: Update the template
In `server/skills/cog.md`, find the block:
```markdown
## Memory Files

Always read on activation:
- cog_read("{path}/hot-memory.md")

Then load per the retrieval protocol based on the query:
```

Change to:
```markdown
## Memory Files

Always read on activation:
- cog_read("{path}/hot-memory.md")
- cog_read("{path}/patterns.md") — domain-specific patterns (loads silently if missing; created by /reflect Gate 3 when a project-specific rule is promoted)

Then load per the retrieval protocol based on the query:
```

#### Step 2: Verify the template still parses (no test, but sanity-check)
```bash
head -1 server/skills/cog.md  # should still be frontmatter
grep "patterns.md" server/skills/cog.md | head -5
```
Expected: the new line appears in the template.

#### Step 3: Commit (commit 3 of 4)
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
git add server/skills/cog.md
GIT_EDITOR=true git commit -m "feat(skills): generated domain skills read {path}/patterns.md on activation

Adds the per-domain patterns.md to the 'Always read on activation' block
of the generated domain skill template (server/skills/cog.md Phase 3d).
Per the tiered-patterns design, per-domain rules load only when the
domain activates, bounding concurrent context to global+active-domain.

Missing per-domain patterns.md is soft-miss (cog_read returns not-found,
skill continues). Existing runtime skills at ~/.ytsejam/data/skills/
need to be regenerated by re-running /cog setup after the next ytsejam
restart — a manual one-shot, NOT automatic on this PR merge."
```

---

### Task 7: /reflect Gate 3 — LLM split-test classification before pattern write

**Files:**
- Modify: `server/skills/reflect.md` (Gate 3 section around line 125)

#### Step 1: Update Gate 3 to add the classification step
In `server/skills/reflect.md`, find:
```markdown
**Gate 3: Synthesis & Write**

For each uncovered cluster:
- Distill into one actionable, timeless pattern line
- Style-match against existing patterns (same voice, same structure)
- Add `<!-- promoted:YYYY-MM-DD theme:tag -->` audit trail at the end of the line
- `cog_patch` it into `cog-meta/patterns.md` (universal) or `{domain-path}/patterns.md` (domain-specific) — edit the relevant section or add the new bullet
- If replacing an existing pattern, `cog_patch` the old line into the new one
```

Replace with:
```markdown
**Gate 3: Synthesis & Write**

For each uncovered cluster:
1. Distill into one actionable, timeless pattern line
2. Style-match against existing patterns (same voice, same structure)
3. Add `<!-- promoted:YYYY-MM-DD theme:tag -->` audit trail at the end of the line
4. **Classify tier (split test):** ask yourself this single question — *"Would this rule be true if {dominant_domain} did not exist?"* If yes → **global** (`cog-meta/patterns.md`). If no → **domain** (`{dominant_domain_path}/patterns.md`). When ambiguous, default to **global** (visible token cost is preferable to silent rule-invisibility when the domain isn't active).
5. Write:
   - **global** → `cog_patch` `cog-meta/patterns.md` (edit the relevant section or add the new bullet)
   - **domain** → `cog_patch` `{dominant_domain_path}/patterns.md`. If the file does not yet exist, **create it first** with shell write (`cog_write` rejects whole-file patterns.md writes); minimum template:
     ```
     <!-- L0: {domain} domain-specific patterns -->
     # {domain} — Domain Patterns
     <!-- Edit in place. ≤40 lines / 3KB. Loaded by the {domain} skill on activation. -->

     ## {Theme}
     - {the new bullet}
     ```
6. If replacing an existing pattern, `cog_patch` the old line into the new one (same tier).
```

Also update the "Pattern file caps:" block immediately below to reflect the new caps:

Find:
```markdown
**Pattern file caps:**
- Core `patterns.md`: hard limit 70 lines / 5.5KB — universal rules only
- Satellite files: soft cap 30 lines each
- `housekeeping_scan.thresholds.patterns_over_cap` flags files near the cap. If near cap: merge overlapping rules or replace weaker patterns (`cog_patch`). Never just truncate.
```

Replace with:
```markdown
**Pattern file caps:**
- Global tier `cog-meta/patterns.md`: hard limit 70 lines / 6KB — cross-project rules only
- Per-domain tier `{domain-path}/patterns.md`: hard limit 40 lines / 3.5KB each — project-specific rules
- `housekeeping_scan.thresholds.patterns_over_cap` flags the global file; `domain_patterns_over_cap` flags per-domain files. If near cap: merge overlapping rules or replace weaker patterns (`cog_patch`). Never just truncate.
- Mis-classification recovery: if a rule was placed in the wrong tier, the cap will trip first on the over-stuffed side. Move via `cog_patch` (delete from source tier) + append (to correct tier) at the next /reflect run.
```

#### Step 2: Sanity-check
```bash
grep -A 3 "split test" server/skills/reflect.md | head -10
grep -A 3 "Global tier" server/skills/reflect.md | head -5
```
Expected: the split-test prompt and the new cap lines both appear.

#### Step 3: Commit (commit 4 of 4)
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
git add server/skills/reflect.md
GIT_EDITOR=true git commit -m "feat(skills): /reflect Gate 3 classifies promotion tier via split test

Adds an explicit split-test classification step to /reflect Gate 3:
before writing a promoted pattern, ask 'would this rule be true if
{dominant_domain} did not exist?' — global if yes, domain if no.
Ambiguous defaults to global (visible token cost over silent failure).

Also updates the 'Pattern file caps' block to document the new
global (70 lines / 6KB) + per-domain (40 lines / 3KB) split, the new
domain_patterns_over_cap threshold key, and the mis-classification
recovery protocol (cap-trip drives re-routing at next /reflect run).

Includes the one-shot create-file-with-L0 fallback for the first
promotion into a domain that doesn't yet have a patterns.md."
```

---

### Task 8: Run full gate, push, open PR

#### Step 1: Final gate
```bash
cd /home/bjk/projects/.worktrees/tiered-patterns
bash scripts/gate.sh 2>&1 | tail -10
```
Expected: PASSED.

#### Step 2: Verify commit sequence
```bash
git log main..HEAD --oneline
```
Expected 4 commits (in this order, top-down newest):
1. `feat(skills): /reflect Gate 3 classifies promotion tier via split test`
2. `feat(skills): generated domain skills read {path}/patterns.md on activation`
3. `feat(memory): tiered patterns caps + recursive per-domain scan`
4. `docs: add design doc for tiered-patterns`

(Note: the cog memory git commit from Task 1 lives in `~/.ytsejam/data/memory/.git`, NOT here. That's correct — that commit doesn't belong in the ytsejam repo branch.)

#### Step 3: Push and open PR
```bash
git push -u origin feat/tiered-patterns 2>&1 | tail -5
gh pr create --title "feat(memory): tiered patterns (global + per-domain)" --body "$(cat <<'EOF'
## What
Splits the single-tier `cog-meta/patterns.md` (currently band-aid 8000B cap from PR #135) into two tiers:

- **Global tier** — `cog-meta/patterns.md`, cross-project rules, always loaded into session-brief, **6000B cap / 70 lines**
- **Per-domain tier** — `{domain-path}/patterns.md`, project-specific rules, loaded **only when the domain skill activates**, **3500B cap / 40 lines each**

Bounds CONCURRENT context (global + active domain), not a combined sum across all domains.

## Why
PR #135 raised the patterns cap 5500→8000 as a band-aid because compression alone could no longer fit the calibrated multi-failure-mode rules accumulated during the ytsejam supernova. This PR is the structural fix tracked in `cog-meta/improvements.md` as "Tiered patterns" (top priority since 2026-06-14). Cap-raise without structural fix is a known anti-pattern — the file keeps growing.

## Split test
"Would this rule be true if ytsejam didn't exist?" — yes → global, no → domain.

Applied to current 7 sections of `cog-meta/patterns.md`: 5 global (Tooling, Memory Consistency, User Context, Test Validation, Parallel Task Safety), 2 domain (Harness Discipline, Subagent Execution — both move to new `projects/ytsejam/patterns.md`).

## Components changed
- `server/src/memory/types.ts` — `patterns_bytes` field split into `global_patterns_{lines,bytes}` + `domain_patterns_{lines,bytes}`; new `DomainPatternsOverCap` + `HousekeepingThresholds.domain_patterns_over_cap`
- `server/src/memory/consolidated/housekeeping.ts` — caps split, `scanPatterns` renamed to `scanGlobalPatterns`, new `scanDomainPatterns` does recursive `{path}/patterns.md` scan excluding `cog-meta/` and `glacier/**`, band-aid TODO comment removed
- `server/test/memory/consolidated.test.ts` — fixture updated; 4 new tests for per-domain scan
- `server/skills/cog.md` — Phase 3d generated-domain-skill template adds `cog_read("{path}/patterns.md")` to activation read block
- `server/skills/reflect.md` — Gate 3 adds LLM split-test classification step + create-file fallback; pattern caps doc updated

Content migration (the actual `cog-meta/patterns.md` → `projects/ytsejam/patterns.md` rule moves) was committed atomically to the cog-memory data git repo (`~/.ytsejam/data/memory/.git`), NOT this ytsejam repo — that's where memory content lives.

## Gate
PASSED — `scripts/gate.sh`: server vitest + web node:test green.

## Self-modification posture
Server-side + skill-template change; activates on Brian's next deliberate ytsejam restart. **Manual one-shot after restart:** run `/cog` to regenerate runtime domain skills at `~/.ytsejam/data/skills/{domain}.md` so they pick up the new activation-block template. (Seed skills from `server/skills/cog.md` are the SOURCE; runtime skills are GENERATED — regeneration is a deliberate `/cog setup` step.)

## Rollback
PR-revert restores single-tier code; the content migration on the cog-memory data side stays (the 2 ytsejam-specific sections continue to live in `projects/ytsejam/patterns.md` even if the code reverts to expecting only the global file — they just become unreachable, NOT lost). If full rollback is needed, also revert the cog-memory commit referenced in this PR's design doc.

— Mentat
EOF
)" 2>&1 | tail -5
```

#### Step 4: Wait for CI green, then merge
```bash
PR_NUM=$(gh pr view feat/tiered-patterns --json number -q .number)
echo "Watching PR #$PR_NUM"
gh pr checks $PR_NUM --watch 2>&1 | tail -10
gh pr merge $PR_NUM --squash --delete-branch 2>&1 | tail -5
```

#### Step 5: Update local main
```bash
cd /home/bjk/projects/ytsejam
git checkout main
git pull --ff-only origin main
git log --oneline -3
```

#### Step 6: Worktree cleanup
```bash
git worktree remove /home/bjk/projects/.worktrees/tiered-patterns
```

---

## Notes for the implementer (autonomous mode)

- **No restart.** Brian explicitly said NO restart. The merged PR sits dormant in the ytsejam codebase; runtime skill regeneration via `/cog setup` is ALSO deferred to after the restart.
- **Cog memory commits are separate.** Task 1's content migration commits to `~/.ytsejam/data/memory/.git`, not the ytsejam repo. The two histories travel together by virtue of being shipped in the same hour, not by sharing a commit.
- **STOP-on-bug-signal applies.** If a failing test points at production code (e.g., the existing `patterns_over_cap` test fails for a reason OTHER than the seeded payload size), STOP and report — don't fix-bundle.
- **Patch-package gotcha for any subagent worktree.** If running fresh `npm install` in any future worktree, ALSO run `npx patch-package` because `--ignore-scripts` skips postinstall and the `@earendil-works/pi-ai` patch breaks the `pi-ai-stop-reason` test. (This worktree is already patched; only relevant if dispatch creates more worktrees.)
- **Cog skill template change vs runtime skills.** The PR ONLY touches the SEED template at `server/skills/cog.md`. Runtime skills at `~/.ytsejam/data/skills/*.md` are generated copies — they're stale until `/cog setup` regenerates them. Don't try to edit runtime files in this PR; that path leads to confusion.

— Mentat
