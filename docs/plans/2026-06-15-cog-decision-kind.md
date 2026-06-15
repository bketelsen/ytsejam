# Cog Decision Kind Implementation Plan (v2 — HEAD-validated)

> Execute with the `develop` skill, task-by-task.

**Goal:** Add `decision` as a first-class cog memory kind — domain-local `decisions.md` files, structured entries with origin/supersedes metadata, in-conversation trigger (B1) + ship-skill workflow trigger (B2), loaded into routing context by domain skills, threshold-rotated by housekeeping.

**Spec:** [docs/plans/2026-06-15-cog-decision-kind-design.md](2026-06-15-cog-decision-kind-design.md)

**Architecture:** Production code in three subsystems (cog conventions string, init-canonical-file types/templates, housekeeping scan + Controller enumerator). Skill markdown updates in two skills (`server/skills/cog.md`, `server/skills/housekeeping.md`, `contrib/skills/ship/SKILL.md`). One migration script. No new server modules. Cog memory edits (`cog-meta/patterns.md`, the migrated `projects/ytsejam/decisions.md`, domains.yml regen) ship via a post-merge runbook documented in the design doc.

**Tech Stack:** TypeScript, Node, the existing in-process memory module (`server/src/memory/`), Vitest.

**Worktree:** /home/bjk/projects/.worktrees/cog-decision-kind

**Branch:** feature/cog-decision-kind

**Baseline:** commit `8cabd5c`, gate green (162 server tests + 158 web tests).

**HEAD validation (done in research pass — confirmed):**
- The "memory rules" table lives in `server/src/cog/brief.ts` as `COG_CONVENTIONS` (a const template string starting line 11, NOT a function). Tests in `server/test/cog-brief.test.ts`.
- `init_canonical_file` has a typed `FileType` union in `server/src/memory/consolidated/init-canonical-file.ts:11` and `server/src/memory/types.ts:501`. Adding `decisions` needs both.
- `Controller` in `server/src/memory/domain/controller.ts` has `actionItems()`, `observations()`, `entities()` enumerators that read `Domain.files`. Adding `decisions()` parallels these.
- Housekeeping scan in `server/src/memory/consolidated/housekeeping.ts` reads from `c.observations()`, `c.actionItems()` — adding a decisions scan needs the new Controller method.
- `validateWrite` exists but is uncalled — writes succeed without manifest registration. The `files:` list matters for enumeration (housekeeping) and for `resolveFile()` shorthand, not for raw append.
- L0 index just walks files on disk reading the first line — no manifest dependency.
- Vitest include glob: `test/**/*.test.ts` (confirmed in `server/vitest.config.ts`).

---

## Reviewer briefing notes (apply to every task)

These tasks are largely **grep-verifiable structural changes** (file presence, type unions, function signatures, regex matches). When dispatching spec/quality reviewers:

- Wall-time budget: **8 minutes per review pass**.
- Reviewer checklist hint: use `git diff BASE..HEAD --stat` + `git show HEAD:<file>` + `grep -nE` instead of running full vitest empirically; only run `bash scripts/gate.sh` for confirmation, not exploration.
- Pre-flag any planned deviations as ACCEPTED in the review brief to avoid spurious flags.

This guards against the **Reviewer Time-Budget Protocol For Grep-Verifiable Tasks** lesson (`docs/agents/planning.md` 2026-06-13 — Opus-class reviewers burning 4.9h on grep-verifiable work).

---

## Task 1: Add `decisions` to FileType + init-canonical-file template

**Files:**
- Modify: `server/src/memory/types.ts` (lines ~499-504: `InitCanonicalFileParams.file_type` union)
- Modify: `server/src/memory/consolidated/init-canonical-file.ts` (line 11: `FileType` union, line 13: `TEMPLATES` map)
- Test: `server/test/init-canonical-file.test.ts` (create or extend if exists)

### Step 1: Check for existing test file

Run: `ls server/test/init-canonical-file* server/test/*canonical* 2>&1`

If a test file exists, extend it. If not, create `server/test/init-canonical-file.test.ts` from scratch matching the conventions of nearby tests (e.g. `server/test/observation.test.ts`).

### Step 2: Write the failing tests

Add these test cases:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initCanonicalFile } from "../src/memory/consolidated/init-canonical-file.ts";
// + any test harness setup needed to register a temp memory root + domain manifest

describe("init_canonical_file decisions template", () => {
  // setup: temp root with one registered domain "foo" at path "foo"

  it("creates decisions.md with the decision template body", async () => {
    const result = await initCanonicalFile({
      path: "foo/decisions.md",
      file_type: "decisions",
      label: "Foo",
    });
    expect(result.created).toBe(true);
    const content = await readFile(/* abs path */, "utf8");
    expect(content).toMatch(/<!-- L0: Decisions for Foo -->/);
    expect(content).toMatch(/# Foo — Decisions/);
    expect(content).toMatch(/Append-only.*\[d-<slug>\]/);
  });

  it("preserves the existing union (regression: hot-memory still works)", async () => {
    const result = await initCanonicalFile({
      path: "foo/hot-memory.md",
      file_type: "hot-memory",
      label: "Foo",
    });
    expect(result.created).toBe(true);
  });
});
```

### Step 3: Run test to verify it fails

Run: `cd server && npx vitest run test/init-canonical-file.test.ts`

Expected: FAIL — TypeScript compilation error on `file_type: "decisions"` (not in union) OR template body assertions fail.

### Step 4: Extend the FileType union

In `server/src/memory/types.ts` line ~501:

```ts
file_type: "hot-memory" | "observations" | "action-items" | "dev-log" | "decisions" | "generic";
```

In `server/src/memory/consolidated/init-canonical-file.ts` line 11:

```ts
type FileType = "hot-memory" | "observations" | "action-items" | "dev-log" | "decisions" | "generic";
```

### Step 5: Add the `decisions` template

In `server/src/memory/consolidated/init-canonical-file.ts`, in the `TEMPLATES` const (line 13), add:

```ts
"decisions": (label) =>
  `<!-- L0: Decisions for ${label} -->
# ${label} — Decisions

<!-- Append-only. Format: - YYYY-MM-DD [d-<slug>]: One-line decision body. <!-- origin: <pr-or-commit>, supersedes: <d-prior or omit> -->
<!-- On supersedes, also append <!-- superseded-by: d-<new> --> to the cited entry. -->
`,
```

### Step 6: Run tests to verify pass

Run: `cd server && npx vitest run test/init-canonical-file.test.ts`

Expected: PASS, both tests.

### Step 7: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: gate PASSED, 0 regressions vs baseline. **CRITICAL:** before declaring done, grep the gate output to confirm the new test ran: `bash scripts/gate.sh 2>&1 | tee /tmp/gate.txt; grep "init_canonical_file decisions template" /tmp/gate.txt`. This guards against the **Confirm New Tests Actually Ran In The Gate** lesson.

### Step 8: Commit

```bash
git add server/src/memory/types.ts server/src/memory/consolidated/init-canonical-file.ts server/test/init-canonical-file.test.ts
git commit -m "feat(memory): add 'decisions' file_type with init-canonical-file template"
```

---

## Task 2: Add `Controller.decisions()` enumerator

**Files:**
- Modify: `server/src/memory/domain/controller.ts` (line ~83 — add `decisions()` after `entities()`)
- Modify: `server/test/memory-system.test.ts` (or equivalent — find via `grep -l "entities()" server/test/`)

### Step 1: Find the Controller test file

Run: `grep -rln "observations()\|actionItems()\|entities()" server/test/`

Identify which file tests Controller enumerators.

### Step 2: Write failing tests

In the Controller test file, add:

```ts
it("Controller.decisions() enumerates domains declaring 'decisions' in files", () => {
  // setup: manifest with domain {id: "foo", path: "foo", files: ["decisions", "hot-memory"]}
  const c = controllerFromManifest(manifest);
  expect(c.decisions()).toEqual([
    { domain: "foo", path: "foo/decisions.md", file: "decisions" },
  ]);
});

it("Controller.decisions() returns empty when no domain declares the file", () => {
  // setup: manifest with only files: ["hot-memory"]
  expect(c.decisions()).toEqual([]);
});

it("Controller.decisions(domainId) filters to one domain", () => {
  // ...
});
```

### Step 3: Run test to verify it fails

Run: `cd server && npx vitest run test/<controller-test-file>.test.ts`

Expected: FAIL — `c.decisions is not a function`.

### Step 4: Add the method

In `server/src/memory/domain/controller.ts`, after the `entities()` method (line ~82):

```ts
decisions(domain?: string): DomainFileRef[] {
  return this.enumerate("decisions", domain);
}
```

### Step 5: Run tests to verify pass

Run: `cd server && npx vitest run test/<controller-test-file>.test.ts`

Expected: PASS.

### Step 6: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED, 0 regressions.

### Step 7: Commit

```bash
git add server/src/memory/domain/controller.ts server/test/<controller-test-file>.test.ts
git commit -m "feat(memory): add Controller.decisions() enumerator"
```

---

## Task 3: Update `COG_CONVENTIONS` in brief.ts to teach the decision kind

**Files:**
- Modify: `server/src/cog/brief.ts` (`COG_CONVENTIONS` template string, starting line 11)
- Modify: `server/test/cog-brief.test.ts`

### Step 1: Read the test file structure

Read: `server/test/cog-brief.test.ts` — note existing test conventions for asserting against `COG_CONVENTIONS`.

### Step 2: Write failing tests

Add tests asserting `COG_CONVENTIONS` contains:
- A numbered rule for `decisions.md` (rule #9 — append after the 8 existing rules)
- A row in the "File edit patterns" table for `decisions.md` with the "Append new, optional supersedes-pair stamp on cited entry" pattern
- A line in the "Glacier thresholds" section for `decisions.md` (>100 entries OR head >6 months, live non-superseded never glacier)

```ts
import { COG_CONVENTIONS } from "../src/cog/brief.ts";

describe("COG_CONVENTIONS decisions kind", () => {
  it("includes a numbered rule for decisions.md", () => {
    expect(COG_CONVENTIONS).toMatch(/9\.\s+decisions\.md.*append.*\[d-<slug>\]/);
  });

  it("includes a file-edit-patterns table row for decisions.md", () => {
    // Match a markdown table row containing decisions.md and "supersedes"
    expect(COG_CONVENTIONS).toMatch(/\| decisions\.md \|.*[Ss]upersedes/);
  });

  it("includes the decisions glacier threshold", () => {
    expect(COG_CONVENTIONS).toMatch(/decisions\.md.*100 entries.*6 months/);
  });
});
```

### Step 3: Run tests to verify failure

Run: `cd server && npx vitest run test/cog-brief.test.ts`

Expected: FAIL — all three assertions miss.

### Step 4: Update COG_CONVENTIONS

In `server/src/cog/brief.ts`, edit the `COG_CONVENTIONS` template string in three places:

**Place 1 — numbered rule list (after rule 8):**

Add rule 9:
```
9. decisions.md: append new entry \`- YYYY-MM-DD [d-<slug>]: <one-line decision>. <!-- origin: <pr-or-commit>, supersedes: <d-prior or omit> -->\`; on supersedes, also append \`<!-- superseded-by: d-<new> -->\` to the cited entry.
```

**Place 2 — file-edit-patterns table (insert after entities.md row):**

```
| decisions.md | Append new, on supersedes also stamp `<!-- superseded-by: -->` on the cited entry |
```

**Place 3 — glacier thresholds (append after existing thresholds):**

```
- decisions.md >100 entries OR head entry >6 months → archive entries that are EITHER superseded OR older than the cutoff to \`glacier/{domain-path}/decisions-YYYY-MM.md\`. Live, non-superseded decisions never glacier regardless of age.
```

**CAUTION (from the "Trust File State Over Edit Success" lesson):** because these are three sequential edits to one file, run `git diff server/src/cog/brief.ts` immediately after to confirm all three landed. Do NOT run them as parallel `edit` calls — sequential only.

### Step 5: Run tests to verify pass

Run: `cd server && npx vitest run test/cog-brief.test.ts`

Expected: PASS.

### Step 6: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED, no regressions. Confirm the new tests ran: `grep "COG_CONVENTIONS decisions kind" /tmp/gate.txt`.

### Step 7: Commit

```bash
git add server/src/cog/brief.ts server/test/cog-brief.test.ts
git commit -m "feat(cog): teach decisions kind in COG_CONVENTIONS (rules, edit-patterns, thresholds)"
```

---

## Task 4: Add decisions threshold to housekeeping scan

**Files:**
- Modify: `server/src/memory/types.ts` (add `DecisionsOverCap` interface + add field to `HousekeepingThresholds`)
- Modify: `server/src/memory/consolidated/housekeeping.ts` (caps, emptyThresholds, scan loop, sort)
- Modify/create: `server/test/housekeeping.test.ts` (find via `grep -l "housekeepingScan\|housekeeping_scan" server/test/`)

### Step 1: Find existing housekeeping tests

Run: `grep -rln "housekeepingScan\|housekeeping_scan" server/test/`

### Step 2: Write failing tests

```ts
describe("housekeepingScan decisions thresholds", () => {
  it("flags decisions.md with >100 entries as over-cap", async () => {
    // setup: temp memory root with a domain declaring 'decisions',
    // write a decisions.md with 101 entries (mix of live + superseded)
    const scan = await housekeepingScan();
    expect(scan.thresholds.decisions_over_cap).toContainEqual(
      expect.objectContaining({ path: "foo/decisions.md", entries: 101, cap: 100 })
    );
  });

  it("flags decisions.md when head entry is >6 months old", async () => {
    // setup: file with 5 entries, oldest from 2025-12-01 (more than 6 months ago from 2026-06-15)
    const scan = await housekeepingScan();
    expect(scan.thresholds.decisions_over_cap).toContainEqual(
      expect.objectContaining({ path: "foo/decisions.md", reason: "age" })
    );
  });

  it("does NOT flag a file under both thresholds", async () => {
    // setup: 50 recent entries
    const scan = await housekeepingScan();
    expect(scan.thresholds.decisions_over_cap).toEqual([]);
  });
});
```

### Step 3: Run tests to verify failure

Run: `cd server && npx vitest run test/housekeeping.test.ts`

Expected: FAIL — type errors on `decisions_over_cap` field + assertion failures.

### Step 4: Add the type

In `server/src/memory/types.ts`, before `HousekeepingThresholds`:

```ts
export interface DecisionsOverCap {
  path: string;
  entries: number;
  cap: number;
  /** "count" if entries > cap, "age" if head entry older than age cap */
  reason: "count" | "age";
}
```

Add field to `HousekeepingThresholds`:

```ts
decisions_over_cap: DecisionsOverCap[];
```

### Step 5: Implement scan logic in housekeeping.ts

In `server/src/memory/consolidated/housekeeping.ts`:

(a) Add caps:
```ts
decisions_entries: 100,
decisions_age_months: 6,
```

(b) Add to `emptyThresholds()`:
```ts
decisions_over_cap: [],
```

(c) Add scan call in `housekeepingScan()` after the existing scans (e.g. after `c.actionItems()` loop):
```ts
for (const t of c.decisions()) {
  const content = await readOptional(t.path);
  if (content == null) continue;
  scanDecisions(t.path, content, result, now);
}
```

(d) Add `scanDecisions` helper:
```ts
function scanDecisions(path: string, content: string, result: HousekeepingScan, now: Date): void {
  let entries = 0;
  let headDate = ""; // earliest = head of the file
  const entryRE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[d-[a-z0-9-]+\]:/;
  for (const line of splitLines(content)) {
    const m = line.trim().match(entryRE);
    if (!m) continue;
    entries++;
    if (headDate === "" || m[1] < headDate) headDate = m[1];
  }
  if (entries > caps.decisions_entries) {
    result.thresholds.decisions_over_cap.push({ path, entries, cap: caps.decisions_entries, reason: "count" });
    return;
  }
  if (headDate) {
    const headTime = new Date(`${headDate}T00:00:00Z`);
    const cutoff = new Date(now.getTime() - caps.decisions_age_months * 30 * 24 * 60 * 60 * 1000);
    if (headTime < cutoff) {
      result.thresholds.decisions_over_cap.push({ path, entries, cap: caps.decisions_entries, reason: "age" });
    }
  }
}
```

(e) Add sort at the end of `housekeepingScan`:
```ts
result.thresholds.decisions_over_cap.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
```

### Step 6: Run tests to verify pass

Run: `cd server && npx vitest run test/housekeeping.test.ts`

Expected: PASS.

### Step 7: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED, 0 regressions. Confirm new tests ran.

### Step 8: Commit

```bash
git add server/src/memory/types.ts server/src/memory/consolidated/housekeeping.ts server/test/housekeeping.test.ts
git commit -m "feat(memory): add decisions_over_cap threshold to housekeeping_scan (100 entries / 6 months)"
```

---

## Task 5: Update `server/skills/cog.md` to scaffold `decisions.md` for new domains

**Files:**
- Modify: `server/skills/cog.md`

### Step 1: Find the file_type mapping table

Read: `server/skills/cog.md` lines ~100-130. The mapping table maps `files` entries to `file_type` strings (currently `hot-memory`, `observations`, `action-items`, `dev-log`, and "anything else" → `generic`).

### Step 2: Update the mapping table

Add a row mapping `decisions` to `"decisions"` (since the new FileType from Task 1 supports it):

```
| `decisions` | `"decisions"` |
```

Position: after `dev-log`, before the catch-all "anything else" row.

### Step 3: Update the default `files:` lists in the manifest template

In the domain manifest example (line ~38-55), add `decisions` to the `files:` lists for project domains. Recommend: include `decisions` by default in all non-system domains. For the cog-meta system domain, do NOT add it (cog-meta decisions go in patterns.md).

Find the template section that suggests default `files:` per domain type. Update it.

### Step 4: Add `## Recent Decisions` to the per-domain skill template

In the **Body template** section (around line ~140-180), add a new section between `## Memory Files` and `## Behaviors`:

```markdown
## Recent Decisions

When the domain declares `decisions` in its files list, load on activation:
- cog_read("{path}/decisions.md") — most-recent-20 entries plus any entry referenced via `supersedes:` from one of the recent 20 (the chain stays followable). Long files fall through to L1 outline + L2 section read.
```

Add a behavior bullet to the `## Behaviors` list:

```markdown
- Append decisions to decisions.md: `- YYYY-MM-DD [d-<slug>]: <one-line>. <!-- origin: <pr-or-commit>, supersedes: <d-prior or omit> -->`; on supersedes, stamp the cited entry with `<!-- superseded-by: d-<new> -->`.
```

### Step 5: Verify edits landed

Run: `git diff server/skills/cog.md` — confirm all four edits applied (file_type table row, default files lists, ## Recent Decisions section, behavior bullet). Per the **Trust File State Over Edit Success** lesson.

### Step 6: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED. (Skill files don't have direct tests; gate is the typecheck + lint + existing tests.)

### Step 7: Commit

```bash
git add server/skills/cog.md
git commit -m "feat(skills/cog): scaffold decisions.md for new domains and load it in generated per-domain skills"
```

---

## Task 6: Update `server/skills/housekeeping.md` to consume the new threshold

**Files:**
- Modify: `server/skills/housekeeping.md`

### Step 1: Read the existing thresholds section

Read: `server/skills/housekeeping.md` lines ~25-45 (orientation envelope description) and lines ~55-80 (archival routing).

### Step 2: Add decisions to the envelope description

After the existing `thresholds.*` bullets (around line 38):

```markdown
- `thresholds.decisions_over_cap[]` — decisions files >100 entries OR head entry >6 months, each with a `reason: "count" | "age"` field
```

### Step 3: Add archival routing

In the **Archival routing** section (around line 65-75), add:

```markdown
**Decisions — archive superseded + old:**
- For each file in `thresholds.decisions_over_cap[]`, move entries that are EITHER:
  - explicitly marked `<!-- superseded-by: ... -->`, OR
  - older than 6 months (read each entry's date prefix)
  to `glacier/{domain-path}/decisions-YYYY-MM.md`. **Never glacier a live (non-superseded) decision** regardless of age — they remain the durable record. YAML frontmatter type: `decisions`.
```

### Step 4: Verify edit landed

Run: `git diff server/skills/housekeeping.md` — confirm both additions present.

### Step 5: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED.

### Step 6: Commit

```bash
git add server/skills/housekeeping.md
git commit -m "feat(skills/housekeeping): consume decisions_over_cap, archive superseded + old (never live)"
```

---

## Task 7: Retarget `contrib/skills/ship/SKILL.md` decisions hook

**Files:**
- Modify: `contrib/skills/ship/SKILL.md` (line 65 — change `wiki/projects/<slug>/decisions.md` to `projects/<slug>/decisions.md`)

### Step 1: Find the references

Run: `grep -n "decisions" contrib/skills/ship/SKILL.md`

Expected: multiple matches; the path-bearing one is around line 65 (`wiki/projects/<slug>/decisions.md`).

### Step 2: Update the path string

Change `wiki/projects/<slug>/decisions.md` to `projects/<slug>/decisions.md`. Update surrounding prose so the new home is named correctly (e.g., "project-domain decisions file, sibling to observations.md" instead of "wiki decisions page").

If the entry format described nearby uses the old shape (`- YYYY-MM-DD: <decision>`), update it to the new shape (`- YYYY-MM-DD [d-<slug>]: <one-line>. <!-- origin: <pr-or-commit> -->`).

### Step 3: Verify only the intended changes

Run: `git diff contrib/skills/ship/SKILL.md`

Expected: only path string + immediately related prose + entry format changed; no structural skill rewrite.

### Step 4: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED.

### Step 5: Commit

```bash
git add contrib/skills/ship/SKILL.md
git commit -m "feat(skills/ship): retarget decisions hook to projects/<slug>/decisions.md with new entry shape"
```

---

## Task 8: Write migration script `scripts/migrate-decisions.ts`

**Files:**
- Create: `scripts/migrate-decisions.ts`
- Create: `server/test/migrate-decisions.test.ts` (tests live in server/test per the include glob)

### Step 1: Check scripts/ convention

Run: `ls scripts/*.ts scripts/*.mjs scripts/*.sh | head -10` — identify the conventional script format.

Run: `cat scripts/<existing-script>.ts` if a TS script exists, else write a new one matching the project's tsconfig settings (likely `.ts` with `node:` imports and `tsx` execution).

### Step 2: Write failing tests

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateDecisions } from "../../scripts/migrate-decisions.ts";

describe("migrate-decisions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "migrate-decisions-"));
  });

  it("converts wiki entries to projects/<slug>/decisions.md format", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "# foo decisions",
      "",
      "- 2026-06-12: **Use SQLite for cache** — fast, embedded, zero ops. Origin: PR #100.",
      "- 2026-06-13: **Switch cache to LMDB** — supersedes prior; SQLite too slow on writes. Origin: PR #110.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });

    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/^<!-- L0: Decisions for projects\/foo -->/);
    expect(out).toMatch(/- 2026-06-12 \[d-use-sqlite-for-cache\]:/);
    expect(out).toMatch(/- 2026-06-13 \[d-switch-cache-to-lmdb\]:/);
    expect(out).toMatch(/<!-- origin: PR #100 -->/);
    expect(out).toMatch(/<!-- origin: PR #110 -->/);
  });

  it("disambiguates colliding slugs with -2, -3 suffix", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **Use SQLite** — fast. Origin: PR #1.",
      "- 2026-06-13: **Use SQLite** — different decision, same title. Origin: PR #2.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });
    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    expect(out).toMatch(/\[d-use-sqlite\]:/);
    expect(out).toMatch(/\[d-use-sqlite-2\]:/);
  });

  it("is a no-op when source file doesn't exist", async () => {
    await expect(
      migrateDecisions({ root, domainPath: "projects/missing" })
    ).resolves.toBeUndefined();
  });

  it("preserves stop-words handling: drops a/an/the/of/for/and/or/to/in/on/with", async () => {
    mkdirSync(path.join(root, "wiki/projects/foo"), { recursive: true });
    mkdirSync(path.join(root, "projects/foo"), { recursive: true });
    writeFileSync(path.join(root, "wiki/projects/foo/decisions.md"), [
      "- 2026-06-12: **The use of a cache for the system** — fast. Origin: PR #1.",
      "",
    ].join("\n"));

    await migrateDecisions({ root, domainPath: "projects/foo" });
    const out = await readFile(path.join(root, "projects/foo/decisions.md"), "utf8");
    // first 5 significant words after dropping stop-words: "use cache system fast"
    expect(out).toMatch(/\[d-use-cache-system-fast\]:/);
  });
});
```

### Step 3: Run tests to verify failure

Run: `cd server && npx vitest run test/migrate-decisions.test.ts`

Expected: FAIL — module not found.

### Step 4: Implement `scripts/migrate-decisions.ts`

Create the script:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "with"]);
const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2}):\s+\*\*([^*]+)\*\*\s*(?:—|--|-)\s*(.+?)(?:\s+Origin:\s+(.+?))?\.?\s*$/;

function slugify(title: string, seen: Map<string, number>): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 5);
  const base = `d-${words.join("-")}` || "d-decision";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

export interface MigrateDecisionsOptions {
  root: string;
  domainPath: string; // e.g. "projects/ytsejam"
}

export async function migrateDecisions(opts: MigrateDecisionsOptions): Promise<void> {
  const srcPath = path.join(opts.root, "wiki", opts.domainPath, "decisions.md");
  const destPath = path.join(opts.root, opts.domainPath, "decisions.md");

  if (!existsSync(srcPath)) return;

  const src = await readFile(srcPath, "utf8");
  const seen = new Map<string, number>();
  const outLines: string[] = [
    `<!-- L0: Decisions for ${opts.domainPath} -->`,
    `# ${opts.domainPath} — Decisions`,
    "",
    "<!-- Migrated from wiki/" + opts.domainPath + "/decisions.md on " + new Date().toISOString().slice(0, 10) + " -->",
    "",
  ];

  for (const line of src.split(/\r?\n/)) {
    const m = line.trim().match(ENTRY_RE);
    if (!m) continue;
    const [, date, title, body, origin] = m;
    const slug = slugify(title, seen);
    const meta = origin ? `<!-- origin: ${origin.trim()} -->` : "";
    const bodyText = body.trim().replace(/\.\s*$/, "");
    outLines.push(`- ${date} [${slug}]: ${title.trim()} — ${bodyText}.${meta ? " " + meta : ""}`);
  }

  await writeFile(destPath, outLines.join("\n") + "\n", "utf8");
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith("migrate-decisions.ts")) {
  const args = process.argv.slice(2);
  const root = args[args.indexOf("--root") + 1];
  const domainPath = args[args.indexOf("--domain") + 1];
  if (!root || !domainPath) {
    console.error("Usage: tsx scripts/migrate-decisions.ts --root <memory-root> --domain <projects/foo>");
    process.exit(1);
  }
  migrateDecisions({ root, domainPath })
    .then(() => console.log(`migrated → ${path.join(root, domainPath, "decisions.md")}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

### Step 5: Run tests to verify pass

Run: `cd server && npx vitest run test/migrate-decisions.test.ts`

Expected: PASS, all four tests.

### Step 6: Run the full gate

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED. Confirm new tests ran.

### Step 7: Commit

```bash
git add scripts/migrate-decisions.ts server/test/migrate-decisions.test.ts
git commit -m "feat(scripts): migrate-decisions for wiki/<slug>/decisions.md → <slug>/decisions.md"
```

---

## Task 9: Document the post-merge runbook

**Files:**
- Modify: `docs/plans/2026-06-15-cog-decision-kind-design.md`

### Step 1: Append the runbook section

Add to the end of the design doc:

```markdown
## Post-merge runbook

After this PR merges and the new release deploys, the maintainer (Brian) runs these steps to land the kind in live memory:

1. **Update domains.yml** — Add `decisions` to the `files:` list of each non-system domain you want decision-tracking on. Edit `~/.ytsejam/data/memory/domains.yml` directly, OR re-run `/cog` which regenerates the manifest from the updated cog skill defaults. Minimum set: `projects/ytsejam`. Recommended: all `projects/*`, `infra`, plus `personal` if you want personal decisions tracked.

2. **Run migration on ytsejam:**
   ```
   cd ~/projects/ytsejam
   npx tsx scripts/migrate-decisions.ts --root ~/.ytsejam/data/memory --domain projects/ytsejam
   ```
   This reads `~/.ytsejam/data/memory/wiki/projects/ytsejam/decisions.md` and writes `~/.ytsejam/data/memory/projects/ytsejam/decisions.md` with the new format.

3. **Retire the wiki copy:**
   ```
   echo "Moved to [[projects/ytsejam/decisions]]." > ~/.ytsejam/data/memory/wiki/projects/ytsejam/decisions.md
   ```
   (Or delete it — the redirect form is nicer for any stale link.)

4. **(Optional) Migrate the chapterhouse decisions to glacier** (chapterhouse is already archived):
   ```
   npx tsx scripts/migrate-decisions.ts --root ~/.ytsejam/data/memory --domain glacier/projects/chapterhouse
   ```
   Then delete `~/.ytsejam/data/memory/wiki/projects/chapterhouse/decisions.md`.

5. **Create stub decisions.md files for other domains** (where step 1 added `decisions` to the manifest):
   ```
   for d in infra personal pkb work projects/truenas-mcp projects/intuneme; do
     [ -d ~/.ytsejam/data/memory/$d ] && [ ! -f ~/.ytsejam/data/memory/$d/decisions.md ] && \
       echo -e "<!-- L0: Decisions for $d -->\n# $d — Decisions\n" > ~/.ytsejam/data/memory/$d/decisions.md
   done
   ```
   (Or use the cog `init_canonical_file` RPC via the agent.)

6. **Append the trigger rule to `cog-meta/patterns.md`** — copy-paste this verbatim under a new `## Decisions` section:

   ```markdown
   ## Decisions

   - Decision-write triggers (OR'd, mechanical):
     - **B1 linguistic tell** in the *recommendation* of a turn: "chose X over Y", "supersedes", "going with X" (verdict, not exploration). When B1 fires, write the decision in the SAME TURN via cog_append to `<active-domain>/decisions.md` — not "remember later."
     - **B2 workflow tell**: ship skill processes a merge with an architectural decision in the body/commits.
   - Entry format: `- YYYY-MM-DD [d-<slug>]: One-line decision. <!-- origin: <pr-or-commit>, supersedes: <d-prior or omit> -->`. On supersedes, also append `<!-- superseded-by: d-<new> -->` to the cited entry.
   ```

7. **Verify L0 scan picks up the new files:**
   ```
   cog_rpc("l0index", {"domain": "ytsejam"})
   ```
   Should include `projects/ytsejam/decisions.md` in the list.

8. **Optional: regenerate the ytsejam domain skill** by re-running `/cog`. The updated skill template includes the `## Recent Decisions` section, so the next session's domain-skill activation will load decisions.md into context.
```

### Step 2: Commit

```bash
git add docs/plans/2026-06-15-cog-decision-kind-design.md
git commit -m "docs(plan): add post-merge runbook for landing decisions kind in live memory"
```

---

## Task 10: Final gate + full diff review

**Files:**
- None (verification + handoff to ship skill)

### Step 1: Run the full gate one final time

Run: `env -u NODE_ENV bash scripts/gate.sh`

Expected: PASSED, 0 regressions vs baseline.

### Step 2: Review the diff

Run: `git diff main --stat`

Expected: ~10-12 files changed:
- `server/src/memory/types.ts` (FileType union + DecisionsOverCap)
- `server/src/memory/consolidated/init-canonical-file.ts` (template)
- `server/src/memory/consolidated/housekeeping.ts` (scan + caps)
- `server/src/memory/domain/controller.ts` (decisions enumerator)
- `server/src/cog/brief.ts` (COG_CONVENTIONS three edits)
- `server/skills/cog.md` (manifest + skill template)
- `server/skills/housekeeping.md` (threshold consumption)
- `contrib/skills/ship/SKILL.md` (path retarget)
- `scripts/migrate-decisions.ts` (new)
- 3 new test files

Total: ~250-400 LOC additions, ~10-20 LOC modifications, ~0 deletions.

### Step 3: Run the cross-cutting checks

- Grep that no test got skipped: `bash scripts/gate.sh 2>&1 | tee /tmp/final-gate.txt; grep -E "(decisions|migrate-decisions|cog-brief)" /tmp/final-gate.txt`
- Confirm `git status` is clean (all changes committed).
- Confirm no stray `wiki/` files were modified (this PR should not touch cog memory directly — only the design doc and code).

### Step 4: Hand off to the ship skill

Do NOT push or open a PR yourself — that's the ship skill's job, with the merge/PR/keep/discard fork.

Report: "All 10 tasks done. Gate green. Diff is N files, M lines. Ready to ship."

---

## Out of scope for this PR (deferred to follow-ups)

- Question kind (deferred — needs felt-pain evidence first)
- Stale-decision marking via git-cursor (separate design thread; lifts the Sync staleness primitive)
- Explicit `/decision` skill (deferred — only if B1 under-fires after a week)
- R3 supersedes-check on write (deferred — only if `supersedes:` field stays under-used)
- Bulk content rewrites of the existing 60 ytsejam decisions (migration preserves them verbatim, reformatted only)
- Two-way auto-stamp of `<!-- superseded-by: -->` (the trigger rule says to do it; no automation in this PR — implement when the cog skill grows write-tools)
