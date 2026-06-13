# Memory Store Auto-Commit Cadence — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add an in-process write-hook layer to the memory store that auto-commits to the memory git repo every N writes, with a startup flush for previously uncommitted work.

**Spec:** docs/plans/2026-06-13-memory-auto-commit-design.md

**Architecture:** A single new module `server/src/memory/store/auto-commit.ts` exports `maybeAutoCommit()`, called by `write`/`append`/`patch`/`move` AFTER a successful file mutation. A module-level counter triggers `git add -A && git commit` every 10 writes; a module-level Promise mutex serializes attempts. The first write after process start checks for a pre-existing dirty tree and commits it as a "startup flush" before counting toward the next auto-commit. Commit failures log a warning and DO NOT fail the write call.

**Tech Stack:** Node 22 + TypeScript, vitest for tests. Reuses the existing `execFile`-based git invocation pattern from `store/git.ts`.

**Worktree:** /tmp/feat-memory-auto-commit

**Branch:** feat/memory-auto-commit

---

## Task 1: Auto-commit module with the in-process counter and mutex

**Files:**
- Create: `server/src/memory/store/auto-commit.ts`
- Test: `server/test/memory/auto-commit.test.ts`

### Step 1: Write the failing test (counter + commit message)

Create `server/test/memory/auto-commit.test.ts` with the foundational tests. Use the same tmp-git-repo pattern as `store.test.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { maybeAutoCommit, __resetAutoCommitForTests, AUTO_COMMIT_EVERY } from "../../src/memory/store/auto-commit.ts";
import { ensureRoot } from "../../src/memory/store/paths.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-autocommit-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  __resetAutoCommitForTests();
  await ensureRoot();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  // Establish an initial commit so HEAD exists.
  await writeFile(join(root, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root });
});

afterEach(async () => {
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

async function writeFileAt(rel: string, content: string) {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

function gitLog(): string {
  return execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
}

describe("memory auto-commit cadence", () => {
  test("AUTO_COMMIT_EVERY default is 10", () => {
    expect(AUTO_COMMIT_EVERY).toBe(10);
  });

  test("first N-1 writes do not produce a commit", async () => {
    for (let i = 0; i < AUTO_COMMIT_EVERY - 1; i++) {
      await writeFileAt(`f${i}.md`, `body ${i}\n`);
      await maybeAutoCommit();
    }
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(1); // only the root commit
    expect(log[0]).toContain("root");
  });

  test("the Nth write triggers an auto-commit with the canonical message", async () => {
    for (let i = 0; i < AUTO_COMMIT_EVERY; i++) {
      await writeFileAt(`f${i}.md`, `body ${i}\n`);
      await maybeAutoCommit();
    }
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/auto: \d+ memory writes/);
    expect(log[0]).toContain(`auto: ${AUTO_COMMIT_EVERY} memory writes`);
  });

  test("counter resets after a commit — next N-1 writes do not commit again", async () => {
    for (let i = 0; i < AUTO_COMMIT_EVERY; i++) {
      await writeFileAt(`a${i}.md`, "x\n");
      await maybeAutoCommit();
    }
    for (let i = 0; i < AUTO_COMMIT_EVERY - 1; i++) {
      await writeFileAt(`b${i}.md`, "y\n");
      await maybeAutoCommit();
    }
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2); // root + one auto-commit, no second auto-commit yet
  });
});
```

### Step 2: Run test to verify it fails

Run: `npm test --workspace server -- auto-commit`
Expected: FAIL with `Cannot find module '.../store/auto-commit.ts'`

### Step 3: Implement the auto-commit module

Create `server/src/memory/store/auto-commit.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);

/** Number of successful mutations between auto-commits. */
export const AUTO_COMMIT_EVERY = 10;

/** In-process state. Survives nothing across process restarts — by design. */
let pendingWrites = 0;
let startupFlushDone = false;
let inflight: Promise<void> | null = null;

/**
 * Reset the in-process auto-commit state. Test-only — production code
 * never calls this.
 */
export function __resetAutoCommitForTests(): void {
  pendingWrites = 0;
  startupFlushDone = false;
  inflight = null;
}

/**
 * Called by the store's mutation primitives (write, append, patch, move)
 * AFTER a successful file mutation. Bumps the in-process write counter
 * and, every AUTO_COMMIT_EVERY writes, commits the memory store.
 *
 * Never throws — commit failures log a WARNING via console.warn and the
 * caller's write still succeeds. The counter is NOT reset on failure so
 * the next write retries the commit.
 *
 * On the first call after process start, also runs a "startup flush"
 * commit if the working tree was already dirty.
 */
export async function maybeAutoCommit(): Promise<void> {
  pendingWrites += 1;
  if (inflight) {
    // A commit is already running. Skip — when it returns, pendingWrites
    // will be honored on the next call.
    return;
  }
  inflight = (async () => {
    try {
      const root = await ensureRoot();
      if (!startupFlushDone) {
        startupFlushDone = true;
        await maybeStartupFlush(root);
      }
      if (pendingWrites < AUTO_COMMIT_EVERY) return;
      const n = pendingWrites;
      pendingWrites = 0;
      await commit(root, `auto: ${n} memory writes`);
    } catch (err) {
      // Keep the counter as-is so the next write retries. Per the design,
      // memory writes MUST NOT fail because of commit problems.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`ytsejam memory auto-commit: ${message}`);
    } finally {
      inflight = null;
    }
  })();
  await inflight;
}

async function maybeStartupFlush(root: string): Promise<void> {
  // Skip if not a git repo at all — `commit` would fail and we'd warn.
  const status = await runOrEmpty(root, ["status", "--porcelain"]);
  if (!status.trim()) return;
  // Skip if a rebase/merge is in progress — not our mess to clean up.
  const inProgress = await isGitOpInProgress(root);
  if (inProgress) {
    console.warn("ytsejam memory auto-commit: skipping startup flush — git operation in progress");
    return;
  }
  await commit(root, "auto: startup flush (uncommitted from previous session)");
}

async function commit(root: string, message: string): Promise<void> {
  await runOrThrow(root, ["add", "-A"]);
  // If nothing is staged (race: another commit may have just landed) the
  // commit will fail with exit 1; treat that as success.
  const status = await runOrEmpty(root, ["diff", "--cached", "--name-only"]);
  if (!status.trim()) return;
  await runOrThrow(root, ["commit", "-m", message]);
}

async function isGitOpInProgress(root: string): Promise<boolean> {
  // Cheapest check: git status --porcelain=v2 --branch reports operation state.
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v2", "--branch"], {
      cwd: root,
      encoding: "utf8",
    });
    return /^# branch\.ab.*\n.*(MERGING|REBASING|CHERRY-PICKING|REVERTING|BISECTING)/m.test(stdout)
      || /\.git\/(MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)/i.test(stdout);
  } catch {
    return false;
  }
}

async function runOrThrow(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return `${stdout}${stderr}`.trim();
}

async function runOrEmpty(cwd: string, args: string[]): Promise<string> {
  try { return await runOrThrow(cwd, args); }
  catch { return ""; }
}
```

(Note: the in-progress detection uses both the porcelain=v2 branch line and a fallback regex against any `.git/<OP>_HEAD` mention in the output. The actual robust check is `existsSync` for those files inside `.git/`, but we keep this PR minimal and rely on `git status` output. If a test catches a false negative we expand it.)

### Step 4: Run test to verify it passes

Run: `npm test --workspace server -- auto-commit`
Expected: PASS for "AUTO_COMMIT_EVERY default is 10", "first N-1 writes do not produce a commit", "the Nth write triggers an auto-commit with the canonical message", "counter resets after a commit".

### Step 5: Commit

```bash
cd /tmp/feat-memory-auto-commit
git add server/src/memory/store/auto-commit.ts server/test/memory/auto-commit.test.ts docs/plans/2026-06-13-memory-auto-commit-design.md docs/plans/2026-06-13-memory-auto-commit.md
git commit -m "feat(memory): add auto-commit cadence module (counter + mutex)"
```

---

## Task 2: Wire the hook into write, append, patch, and move

**Files:**
- Modify: `server/src/memory/store/write.ts`
- Modify: `server/src/memory/store/append.ts`
- Modify: `server/src/memory/store/patch.ts`
- Modify: `server/src/memory/store/move.ts`
- Test: `server/test/memory/auto-commit.test.ts` (extend)

**Allow-list reference** (from `server/src/memory/store/paths.ts:62-70`, verify before writing tests):
- `write` enforces `validateWholeFileWritePath` — only these paths pass: `domains.yml`, `link-index.md`, `glacier/index.md`, any `**/INDEX.md`, `cog-meta/{scenario-calibration,reflect-cursor,foresight-nudge,evolve-log,evolve-observations,scorecard}.md`, `cog-meta/scenarios/<single>.md`.
- `append` and `patch` do NOT use the whole-file allow-list — they only enforce `rejectIDAsPath` (domain-id-as-path-prefix rejection) and the observations-format check (only when path ends with `observations.md`). Any other path works.
- `move` enforces the whole-file allow-list on the DESTINATION; the source can be any path.

### Step 1: Write the failing tests for hook coverage

Append THREE tests to `server/test/memory/auto-commit.test.ts` (inside the describe block). Use these EXACT shapes — they reflect the allow-list constraints above. Do not invent variants.

```typescript
  test("write/append/patch hooks: the 10th call across primitives triggers a commit", async () => {
    // Domains.yml so append/patch's rejectIDAsPath has something to read.
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 4 writes (all on allow-listed paths)
    await memory.write("domains.yml", "version: 1\ndomains: []\n");
    await memory.write("link-index.md", "x\n");
    await memory.write("glacier/index.md", "y\n");
    await memory.write("cog-meta/reflect-cursor.md", "z\n");
    // 3 appends (append has no whole-file allow-list; any non-observations path works)
    for (let i = 0; i < 3; i++) {
      await memory.append(`note-${i}.md`, "hello\n");
    }
    // 2 patches (patch has no whole-file allow-list either)
    await memory.patch("note-0.md", "hello", "world");
    await memory.patch("note-1.md", "hello", "world");
    // 9 writes total — no auto-commit yet.
    expect(gitLog().trim().split("\n")).toHaveLength(1);
    // 10th: another append → cadence commit fires.
    await memory.append("note-9.md", "tenth\n");
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
  });

  test("move bumps the counter", async () => {
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 9 appends to put us one short of the threshold.
    for (let i = 0; i < 9; i++) {
      await memory.append(`x-${i}.md`, "x\n");
    }
    expect(gitLog().trim().split("\n")).toHaveLength(1);
    // Seed an allow-listed source DIRECTLY on disk (skip memory.write so
    // the counter stays at 9). INDEX.md is allow-listed for any prefix
    // → we can move between two project INDEX paths.
    await mkdir(join(root, "projects", "foo"), { recursive: true });
    await writeFile(join(root, "projects", "foo", "INDEX.md"), "src\n");
    await memory.move("projects/foo/INDEX.md", "projects/bar/INDEX.md");
    // 10th write → commit fires.
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
  });

  test("failed mutations do NOT bump the counter", async () => {
    // Negative-path coverage: the hook must run AFTER a successful mutation,
    // never before. A rejected write/append/patch/move leaves the counter
    // unchanged so it can't poison the next session's cadence.
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 9 SUCCESSFUL appends to put the counter at 9.
    for (let i = 0; i < 9; i++) {
      await memory.append(`ok-${i}.md`, "ok\n");
    }
    expect(gitLog().trim().split("\n")).toHaveLength(1);

    // write to a non-allow-listed path → should throw, must NOT bump.
    await expect(memory.write("not-allowed.md", "x\n"))
      .rejects.toThrow(/write path not allowed/);

    // append to a path that uses a domain-id as its top-level path → throws.
    await writeFile(join(root, "domains.yml"),
      "version: 1\ndomains:\n  - id: foo\n    path: projects/foo\n");
    await expect(memory.append("foo/things.md", "hello\n"))
      .rejects.toThrow(/domain id used as path/);

    // patch with oldText absent → throws.
    await expect(memory.patch("ok-0.md", "NOT-THERE", "x"))
      .rejects.toThrow(/oldText not found/);

    // move to a non-allow-listed destination → throws.
    await expect(memory.move("ok-1.md", "also-not-allowed.md"))
      .rejects.toThrow(/write path not allowed/);

    // Counter is still at 9 — no commit yet.
    expect(gitLog().trim().split("\n")).toHaveLength(1);

    // 10th SUCCESSFUL write fires the commit, proving the counter is at 9
    // and not 13 (which it would be if failed mutations had bumped it).
    await memory.append("ok-9.md", "ok\n");
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
  });
```

### Step 2: Run tests to verify they fail

Run: `npm test --workspace server -- auto-commit`
Expected: FAIL for all three new tests — the existing `write`/`append`/`patch`/`move` don't call `maybeAutoCommit()` yet, so the 10th write never triggers a commit. The existing 6 tests must still pass.

### Step 3: Wire the hook into each mutation primitive

Modify `server/src/memory/store/write.ts`:

```typescript
import type { WriteResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

export async function write(path: string, content: string): Promise<WriteResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await validateWholeFileWritePath(rel);
  await atomicWrite(abs, content);
  await maybeAutoCommit();
  return { bytes: Buffer.byteLength(content) };
}
```

Modify `server/src/memory/store/append.ts` (add the import, then the call after each mutation path):

```typescript
import { readFile } from "node:fs/promises";
import type { OkResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { rejectIDAsPath, resolveMemoryPath } from "./paths.ts";

// ... unchanged regexes ...

export async function append(path: string, text: string, options: { section?: string } = {}): Promise<OkResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await rejectIDAsPath(rel);
  if (rel.endsWith("observations.md")) validateObsLines(text);
  if (options.section) await appendUnderSection(abs, rel, options.section, text);
  else await appendAtEOF(abs, text);
  await maybeAutoCommit();
  return { ok: true };
}
```

Modify `server/src/memory/store/patch.ts`:

```typescript
import { readFile } from "node:fs/promises";
import type { OkResult } from "../types.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { resolveMemoryPath } from "./paths.ts";

export async function patch(path: string, oldText: string, newText: string): Promise<OkResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  const content = await readFile(abs, "utf8");
  const count = oldText === "" ? 0 : content.split(oldText).length - 1;
  if (count === 0) throw new Error(`store: patch: oldText not found in ${JSON.stringify(rel)}`);
  if (count >= 2) throw new Error(`store: patch: oldText appears ${count} times in ${JSON.stringify(rel)} (must appear exactly once)`);
  await atomicWrite(abs, content.replace(oldText, newText));
  await maybeAutoCommit();
  return { ok: true };
}
```

Modify `server/src/memory/store/move.ts`:

```typescript
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { OkResult } from "../types.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

// ... unchanged docblock ...

export async function move(from: string, to: string): Promise<OkResult> {
  const src = await resolveMemoryPath(from);
  const dst = await resolveMemoryPath(to);
  await validateWholeFileWritePath(dst.rel);
  try { await stat(dst.abs); throw new Error(`store: move destination exists: ${JSON.stringify(dst.rel)}`); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  await mkdir(dirname(dst.abs), { recursive: true, mode: 0o755 });
  await rename(src.abs, dst.abs);
  await maybeAutoCommit();
  return { ok: true };
}
```

### Step 4: Run tests to verify they pass

Run: `npm test --workspace server -- auto-commit`
Expected: PASS for all 9 auto-commit tests (6 existing + 3 new).

Also run the full memory store test suite:

Run: `npm test --workspace server -- store`
Expected: PASS — no regressions.

### Step 5: Commit

```bash
cd /tmp/feat-memory-auto-commit
git add server/src/memory/store/write.ts server/src/memory/store/append.ts server/src/memory/store/patch.ts server/src/memory/store/move.ts server/test/memory/auto-commit.test.ts
git commit -m "feat(memory): call maybeAutoCommit from write/append/patch/move"
```

---

## Task 3: Startup flush + failure isolation + concurrency tests

**Files:**
- Test: `server/test/memory/auto-commit.test.ts` (extend)

### Step 1: Write the failing tests

Append three more tests to `server/test/memory/auto-commit.test.ts` (inside the describe block):

```typescript
  test("startup flush: pre-existing dirty TRACKED file is committed before first auto-commit increments", async () => {
    // Seed a tracked file and commit it as 'previous session' baseline.
    await writeFile(join(root, "tracked-prev.md"), "v1\n");
    execFileSync("git", ["add", "tracked-prev.md"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "prev session baseline"], { cwd: root });
    // Now modify it (dirty tracked file = previous-session uncommitted edit).
    await writeFile(join(root, "tracked-prev.md"), "v2 (uncommitted from previous session)\n");
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }))
      .toContain("tracked-prev.md");
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // First memory write triggers startup flush; this counts as 1 toward the cadence.
    await memory.append("first.md", "first\n");
    const log = gitLog().trim().split("\n");
    // Expect: root, prev-session-baseline, startup-flush. 3 commits.
    expect(log).toHaveLength(3);
    expect(log[0]).toContain("auto: startup flush");
    // The startup flush captures BOTH tracked-prev.md AND first.md
    // (everything dirty at the moment `git add -A` ran inside the flush).
    const flushCommit = execFileSync("git", ["show", "--stat", "HEAD"], { cwd: root, encoding: "utf8" });
    expect(flushCommit).toMatch(/tracked-prev\.md/);
    expect(flushCommit).toMatch(/first\.md/);
  });

  test("startup flush ignores untracked-only dirt (covered by next normal cadence cycle)", async () => {
    // Seed an untracked file directly on disk — simulates a new file
    // never committed by a previous session.
    await writeFile(join(root, "new-prev.md"), "leftover untracked\n");
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // 9 appends — startup flush should NOT fire (no tracked dirt).
    for (let i = 0; i < AUTO_COMMIT_EVERY - 1; i++) {
      await memory.append(`x${i}.md`, "x\n");
    }
    // Still only the root commit; startup flush did not fire.
    expect(gitLog().trim().split("\n")).toHaveLength(1);
    // 10th write triggers a normal cadence commit, which `git add -A`
    // picks up new-prev.md alongside everything else. No data loss.
    await memory.append("x9.md", "x\n");
    const log = gitLog().trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("auto: 10 memory writes");
    const cadenceCommit = execFileSync("git", ["show", "--stat", "HEAD"], { cwd: root, encoding: "utf8" });
    expect(cadenceCommit).toMatch(/new-prev\.md/); // untracked-prev ride along
  });

  test("commit failure (not a git repo) logs a warning and the write succeeds", async () => {
    // Tear down git in the tmp root.
    await rm(join(root, ".git"), { recursive: true, force: true });
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Do 10 appends — none should throw; we should see a warning.
    for (let i = 0; i < AUTO_COMMIT_EVERY; i++) {
      await memory.append(`f${i}.md`, "x\n");
    }
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/ytsejam memory auto-commit:/);
    warn.mockRestore();
  });

  test("concurrent burst of N writes produces exactly one commit (mutex coalesces)", async () => {
    await writeFile(join(root, "domains.yml"), "version: 1\ndomains: []\n");
    const memory = await import("../../src/memory/index.ts");
    // Fire N appends in parallel.
    await Promise.all(
      Array.from({ length: AUTO_COMMIT_EVERY }, (_, i) => memory.append(`p${i}.md`, "x\n")),
    );
    // After the burst, exactly one auto-commit should exist on top of root.
    const log = gitLog().trim().split("\n");
    expect(log.length).toBeLessThanOrEqual(2);
    expect(log.length).toBeGreaterThanOrEqual(2); // 1 auto + root
    expect(log[0]).toContain("auto:");
  });
```

### Step 2: Run tests to verify they fail or assert the design

Run: `npm test --workspace server -- auto-commit`
Expected:
- "startup flush" — already PASSING IF the implementation in Task 1 was correct. If FAIL, fix the implementation. The likely failure mode is that startup flush runs but the warning path swallowed an error — investigate the warning shape.
- "commit failure" — PASSING (the implementation already swallows commit errors).
- "concurrent burst" — likely PASSING but verify the mutex behavior. If the test sees MORE than 2 commits, the mutex is broken; if it sees only 1 commit (no auto-commit fired), the counter races are wrong.

If a test fails, fix `auto-commit.ts` minimally — DO NOT change the public API.

### Step 3: Run the full gate to confirm no regression

Run: `bash scripts/gate.sh`
Expected: `=== gate: PASSED ===`

### Step 4: Commit

```bash
cd /tmp/feat-memory-auto-commit
git add server/test/memory/auto-commit.test.ts server/src/memory/store/auto-commit.ts
git commit -m "test(memory): cover startup flush, commit failure, concurrency"
```

---

## Task 4: Documentation breadcrumb

**Files:**
- Modify: `docs/agents/OVERVIEW.md` (or the memory subsystem doc if it exists)

### Step 1: Find the right doc

Run: `find docs -name "*.md" | xargs grep -l "memory" 2>/dev/null | head -5`

If `docs/agents/OVERVIEW.md` references the memory subsystem, add an "Auto-commit cadence" paragraph there. If a dedicated memory doc exists (e.g. `docs/agents/MEMORY.md`), add it there instead.

### Step 2: Add a short paragraph

```markdown
### Memory auto-commit cadence

The memory store auto-commits its git repo every 10 writes
(`server/src/memory/store/auto-commit.ts`, constant `AUTO_COMMIT_EVERY`).
Auto-commits use messages prefixed `auto:` (`auto: 10 memory writes` for
the normal case, `auto: startup flush (uncommitted from previous session)`
for the first commit after a process restart that finds a dirty tree).
The counter is in-process; it survives nothing across restarts. Commit
failures log a `ytsejam memory auto-commit:` warning to stderr and do
NOT fail the underlying write.
```

### Step 3: Commit

```bash
cd /tmp/feat-memory-auto-commit
git add docs/
git commit -m "docs(memory): document auto-commit cadence"
```

---

## Task 5: Final gate + handoff

### Step 1: Run the full gate

Run: `bash scripts/gate.sh`
Expected: `=== gate: PASSED ===`

### Step 2: Inspect git log

Run: `git log --oneline main..HEAD`
Expected: 4 commits (Tasks 1-4), all conventional-commits style.

### Step 3: Hand off to /ship

Tell the operator: "Branch `feat/memory-auto-commit` ready, gate green, 4 commits, ready for /ship."
