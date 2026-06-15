# Cog Decision Kind Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add `decision` as a first-class cog memory kind — domain-local `decisions.md` file with structured entries, in-conversation trigger (B1) + ship-skill workflow trigger (B2), loaded into routing context by domain skills, glacier-rotated by housekeeping.

**Spec:** [docs/plans/2026-06-15-cog-decision-kind-design.md](2026-06-15-cog-decision-kind-design.md)

**Architecture:** Single PR touching three skill-source files (`server/skills/cog.md`, `server/skills/housekeeping.md`, `contrib/skills/ship/SKILL.md`), one production code file (`server/src/agent/system-prompt.ts` or the rules table builder), and one migration script (`scripts/migrate-decisions.ts`). No new server modules, no new tests beyond migration-script unit tests. Cog memory edits (`cog-meta/patterns.md` + the migrated `projects/ytsejam/decisions.md`) happen via documented post-merge steps; they live outside the repo.

**Tech Stack:** TypeScript, Node, the existing cog memory in-process module (`server/src/memory/`), Vitest for tests.

**Worktree:** /tmp/cog-decision-kind

**Branch:** feature/cog-decision-kind

---

## Task 0: Locate the memory-rules table in the system prompt

**Files:**
- Read: `server/src/agent/system-prompt.ts` (or wherever the rules table is built — discover first)
- Read: `server/src/agent/` directory structure

### Step 1: Find the rules table

Run: `grep -rn "observations.md is append-only" server/src/ | head -5`

Expected: one or more files contain the existing memory-rules table. Identify the canonical source.

### Step 2: Read the file fully

Read the identified file. Confirm the rules table is a string array, JSX-style template, or markdown-in-code that lists the 6 existing kinds.

### Step 3: Record findings in the plan

Update this plan file (Task 1 step 1) with the exact file path and the existing kinds-table format. Commit if needed.

```bash
git add docs/plans/
git commit -m "docs: record memory-rules table location in plan"
```

(If the file path was already obvious — skip the commit; this step is investigation-only.)

---

## Task 1: Add `decision` kind to the system-prompt memory rules

**Files:**
- Modify: `server/src/agent/system-prompt.ts` (or path identified in Task 0)
- Test: `server/test/system-prompt.test.ts` (if exists) or create

### Step 1: Write the failing test

Add a test asserting the rules table includes `decisions.md` with the expected entry-pattern description (append new entry; on supersedes, stamp the cited entry with paired `<!-- superseded-by: -->` comment).

```ts
// Pseudocode — adjust to existing test shape
import { describe, it, expect } from "vitest";
import { buildMemoryRules } from "../src/agent/system-prompt";

describe("memory rules table", () => {
  it("includes decisions.md as a first-class kind", () => {
    const rules = buildMemoryRules();
    expect(rules).toContain("decisions.md");
    expect(rules).toMatch(/decision.*supersedes/i);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/system-prompt.test.ts`

Expected: FAIL — "decisions.md" not found in rules table.

### Step 3: Add the kind to the rules table

In the rules table, append after the entities.md row:

```
decisions.md: append new entry `- YYYY-MM-DD [d-<slug>]: <one-line decision>. <!-- origin: <pr-or-commit>, supersedes: <d-prior or omit> -->`; on supersedes, also append `<!-- superseded-by: d-<new> -->` to the cited entry.
```

Match the formatting of the existing rows (table cells, prose paragraph, whatever the file uses).

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run test/system-prompt.test.ts`

Expected: PASS.

### Step 5: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED, 0 regressions vs baseline (162 server / 158 web tests pass).

### Step 6: Commit

```bash
git add server/src/agent/system-prompt.ts server/test/system-prompt.test.ts
git commit -m "feat(memory): add decisions.md as first-class kind in system-prompt rules"
```

---

## Task 2: Update `server/skills/cog.md` to scaffold `decisions.md` for new domains

**Files:**
- Modify: `server/skills/cog.md`

### Step 1: Read the current cog skill

Read: `server/skills/cog.md` — locate the starter-file generation section that lists `observations.md`, `action-items.md`, `entities.md`, `hot-memory.md`.

### Step 2: Add decisions.md to the starter-file list

In the same section, add `decisions.md` with content body `<!-- L0: decisions for <domain> -->\n\n# <Domain> Decisions\n\n` (a single L0 line and an H1; entries start being appended on first decision).

Match the formatting style of the existing starter-file definitions.

### Step 3: Add `## Recent Decisions` to the generated domain-skill template

Find the section of `cog.md` that defines the per-domain skill template (the one generated for each domain — what loads on the domain's trigger words). Add:

```markdown
## Recent Decisions

<!-- Read by the routing path. The skill loader populates this with the most recent 20 entries from {domain-path}/decisions.md, plus any entry referenced via `supersedes:` from the recent 20 (so the chain is followable). Falls through to L1 outline + L2 section read for full retrieval. -->
```

Place this section after `## Hot Memory` and before `## Action Items` (or whatever the existing ordering uses).

### Step 4: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED, no regressions.

### Step 5: Commit

```bash
git add server/skills/cog.md
git commit -m "feat(skills/cog): scaffold decisions.md for new domains and load it in generated skills"
```

---

## Task 3: Retarget `contrib/skills/ship/SKILL.md` decisions hook

**Files:**
- Modify: `contrib/skills/ship/SKILL.md`

### Step 1: Locate the decisions-routing language

Read: `contrib/skills/ship/SKILL.md` — search for `wiki/projects/<slug>/decisions.md` or equivalent language about decision routing (per the norma-port observation, this lives in Step 2 routing logic).

Run: `grep -n "decisions" contrib/skills/ship/SKILL.md`

### Step 2: Update the path

Change every occurrence of `wiki/projects/<slug>/decisions.md` to `projects/<slug>/decisions.md`. Update prose around the change to reflect the new home ("project-domain decisions file, sibling to observations.md").

### Step 3: Verify only the path text changed

Run: `git diff contrib/skills/ship/SKILL.md`

Expected: only the path strings and immediately-related prose changed. No structural skill changes.

### Step 4: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED.

### Step 5: Commit

```bash
git add contrib/skills/ship/SKILL.md
git commit -m "feat(skills/ship): retarget decisions hook to projects/<slug>/decisions.md"
```

---

## Task 4: Add decisions.md rotation to `server/skills/housekeeping.md`

**Files:**
- Modify: `server/skills/housekeeping.md`

### Step 1: Read housekeeping skill, find the rotation section

Read: `server/skills/housekeeping.md` — locate the section that defines glacier thresholds (e.g. "observations.md >50 entries", "action-items.md >10 completed").

### Step 2: Add the decisions.md threshold

Append to the threshold list:

```
- decisions.md >100 entries OR head entry older than 6 months → archive entries that are EITHER superseded OR older than the cutoff to `glacier/{domain-path}/decisions-YYYY-MM.md`. Live, non-superseded decisions NEVER glacier regardless of age.
```

Match the formatting style of the existing thresholds.

### Step 3: Add YAML frontmatter spec for the glacier file

In the section listing what frontmatter glacier files need, add `decisions` to the type list (or confirm it's already covered by a generic "type matches source kind" rule).

### Step 4: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED.

### Step 5: Commit

```bash
git add server/skills/housekeeping.md
git commit -m "feat(skills/housekeeping): rotate decisions.md at 100 entries / 6 months, preserve live"
```

---

## Task 5: Write migration script `scripts/migrate-decisions.ts`

**Files:**
- Create: `scripts/migrate-decisions.ts`
- Create: `scripts/test/migrate-decisions.test.ts` (if scripts/test exists, else colocate as `scripts/migrate-decisions.test.ts`)

### Step 1: Write the failing test

Create a test that:
- Sets up a fixture `wiki/projects/foo/decisions.md` with 3 entries in the existing wiki format (dash-prefix, date, bold-title, prose body).
- Runs the migration script against the fixture.
- Asserts a generated `projects/foo/decisions.md` exists with:
  - L0 line at top
  - Each entry in new format: `- YYYY-MM-DD [d-<slug>]: <body>. <!-- origin: ... -->`
  - Slugs auto-generated from first 5 significant words, kebab-cased
  - Slug collisions resolved by `-2`, `-3` suffix
  - Original dates and origin metadata preserved

```ts
// Pseudocode — match the existing scripts/ test conventions
import { describe, it, expect } from "vitest";
import { migrateDecisions } from "./migrate-decisions";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("migrate-decisions", () => {
  it("converts wiki entries to projects/<slug>/decisions.md format", async () => {
    const root = await mkdtemp(join(tmpdir(), "migrate-decisions-"));
    const wikiPath = join(root, "wiki/projects/foo/decisions.md");
    await mkdir(join(root, "wiki/projects/foo"), { recursive: true });
    await writeFile(wikiPath, [
      "# foo decisions",
      "",
      "- 2026-06-12: **Use SQLite for cache** — fast, embedded, zero ops. Origin: PR #100.",
      "- 2026-06-13: **Switch cache to LMDB** — supersedes prior; SQLite too slow on writes. Origin: PR #110.",
    ].join("\n"));

    await migrateDecisions(root, "foo");

    const out = await readFile(join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/<!-- L0: decisions for foo -->/);
    expect(out).toMatch(/- 2026-06-12 \[d-use-sqlite-for-cache-fast\]:/);
    expect(out).toMatch(/- 2026-06-13 \[d-switch-cache-to-lmdb-supersedes\]:/);
    expect(out).toMatch(/<!-- origin: PR #100 -->/);
  });

  it("disambiguates colliding slugs with -2, -3 suffix", async () => {
    // ... fixture with two entries producing the same slug
    // assert second gets -2 suffix
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd scripts && npx vitest run migrate-decisions.test.ts` (or wherever tests live)

Expected: FAIL — module not found.

### Step 3: Implement `migrate-decisions.ts`

Create the script with:
- `migrateDecisions(rootDir: string, domainPath: string): Promise<void>` async function
- Reads `${rootDir}/wiki/projects/${domainPath}/decisions.md` (handle absence gracefully)
- Parses each `- YYYY-MM-DD: **<title>** — <body>. Origin: <pr-or-commit>.` entry
- Generates slug from first 5 significant words (drop stop-words: a/an/the/of/for/and/or/to/in/on/with), kebab-case, lowercase
- Tracks seen slugs; appends `-2`, `-3`, ... on collision
- Writes `${rootDir}/projects/${domainPath}/decisions.md` with L0 line, H1 header, then each entry as `- YYYY-MM-DD [d-<slug>]: <body>. <!-- origin: <pr-or-commit> -->`
- Preserves entry order

Also expose a CLI entry: `if (require.main === module) { ... }` that accepts `--root` and `--domain` flags.

### Step 4: Run test to verify it passes

Run: `cd scripts && npx vitest run migrate-decisions.test.ts`

Expected: PASS, both tests.

### Step 5: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED.

### Step 6: Commit

```bash
git add scripts/migrate-decisions.ts scripts/migrate-decisions.test.ts
git commit -m "feat(scripts): add migrate-decisions for wiki→projects/<slug>/decisions.md"
```

---

## Task 6: Document post-merge migration steps

**Files:**
- Modify: `docs/plans/2026-06-15-cog-decision-kind-design.md` (this design doc — add a "Post-merge runbook" section)

### Step 1: Add post-merge runbook

Append to the design doc a "## Post-merge runbook" section listing the cog-memory edits the maintainer (Brian) runs after this PR merges:

1. Run migration on ytsejam: `npx tsx scripts/migrate-decisions.ts --root ~/.ytsejam/data/memory --domain projects/ytsejam`
2. Delete or redirect `~/.ytsejam/data/memory/wiki/projects/ytsejam/decisions.md` to point at the new home (1-line markdown redirect: `Moved to [[projects/ytsejam/decisions]].`)
3. Create stub `decisions.md` for other domains: `for d in infra personal pkb work projects/truenas-mcp projects/intuneme; do echo "<!-- L0: decisions for $d -->" > ~/.ytsejam/data/memory/$d/decisions.md; done`
4. Append the trigger rule to `~/.ytsejam/data/memory/cog-meta/patterns.md` under a new `## Decisions` section (rule text inlined below — copy verbatim).
5. Verify L0 scan picks up the new files: `cog_rpc("l0index", {"domain": "ytsejam"})` should return decisions.md.
6. (Optional) For chapterhouse (already archived), migrate to glacier directly: `npx tsx scripts/migrate-decisions.ts --root ~/.ytsejam/data/memory --domain glacier/projects/chapterhouse`.

Inline the exact text for the patterns.md `## Decisions` section so step 4 is copy-paste.

### Step 2: Commit

```bash
git add docs/plans/2026-06-15-cog-decision-kind-design.md
git commit -m "docs: add post-merge runbook for decisions-kind cog migration"
```

---

## Task 7: Final gate + PR prep

**Files:**
- None (verification + PR body)

### Step 1: Run the full gate one final time

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED, 0 regressions.

### Step 2: Check the diff

Run: `git diff main --stat`

Expected: ~6 files changed (system-prompt + test, cog.md, ship/SKILL.md, housekeeping.md, migrate-decisions.ts + test, design doc), small line counts each.

### Step 3: Self-review against the spec

Re-read `docs/plans/2026-06-15-cog-decision-kind-design.md` and confirm every "Implementation" step (1-8) is either done in this PR or in the post-merge runbook. The acceptance criteria checklist should be reviewable: most items will be runtime-verifiable only after the post-merge steps run.

### Step 4: Hand off to the ship skill

(Do not push or open a PR yourself — that's the ship skill's job, with the merge/PR/keep/discard fork.)

Report: "All 7 tasks done. Gate green. Diff is N files, M lines. Ready to ship."

---

## Out of scope for this PR

- Question kind (deferred)
- Stale-decision marking (separate design thread)
- `/decision` skill (deferred unless B1 under-fires)
- Bulk-rewriting the existing 60 ytsejam wiki entries' bodies (migration preserves them verbatim, just reformatted)
- R3 supersedes-check on write (deferred)
