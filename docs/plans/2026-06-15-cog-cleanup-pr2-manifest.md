# PR-2: manifest validate-on-write + routing-RPC error surface

> Execute with the `develop` skill, task-by-task.

**Goal:** Prevent invalid `domains.yml` content from landing on disk, and surface manifest-load failures through routing RPCs so the agent sees the root cause instead of a derived `unknown id` symptom.

**Spec:** `docs/plans/2026-06-15-cog-cleanup-design.md` (sections "Hardening 1: Validate `domains.yml` on write" and "Hardening 2: Surface manifest load errors through routing RPCs")

**Architecture:** Two narrow daemon changes.

1. Factor `loadManifest`'s parse+normalize body into a new exported `validateManifestContent(content: string, sourceLabel?: string): Domain[]` that works on in-memory strings; `loadManifest` becomes the file-reading wrapper. Then in `store/write.ts`, when writing `domains.yml`, run `validateManifestContent` on the proposed content before `atomicWrite`. Same error string the next load would have produced, surfaced inline.

2. `Controller.get(id)` already records `lastError` on hot-reload parse failures (in `maybeReload`). When `get(id)` throws `unknown id`, include the cached `lastError.message` in the thrown error when one is present. Same behavior for clean-load case (no clutter); enriched message only when there's an active manifest problem.

Both changes are independent (different files, different test files) but cohere as one PR thematically.

**Tech Stack:** Node 20, TypeScript, vitest.

**Worktree:** `/tmp/cog-cleanup-manifest`

**Branch:** `feat/cog-cleanup-manifest`

**Closure:** Closes #202 (validate-on-write), #203 (controller surfaces last manifest load error).

---

## Baseline

Recorded before any task: `bash scripts/gate.sh` PASSES (server tests 158/158, web tests 158/158, lint + typecheck clean). Recorded from this worktree at 2026-06-15 against base commit `bd8e8c3` (`docs: add PR-1 implementation plan for cog cleanup (RPCs)`).

Every task ends with a gate re-run; "no regressions" means against this baseline.

---

## Task 1: Factor `validateManifestContent` out of `loadManifest`

**Files:**
- Modify: `server/src/memory/domain/manifest.ts` (extract parse+normalize into new exported function; `loadManifest` becomes a thin file-reading wrapper)
- Modify: `server/src/memory/index.ts` (re-export `validateManifestContent`)

This task is pure refactor. No behavior change. Existing `domain.test.ts` regressions guard it.

### Step 1: Read the current manifest.ts in full

```bash
cat server/src/memory/domain/manifest.ts
```

Note the existing structure: `loadManifest(rootDir)` does file existence check → read → `parse` → object/array shape checks → `normalizeDomain` traversal. The factoring keeps `loadManifest`'s file-IO outer layer (existence, read, the path-wrapping error labels) and pulls the post-parse content validation into `validateManifestContent(content, sourceLabel?)`.

### Step 2: Replace `manifest.ts` with the refactored version

Replace the file contents with:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Domain } from "../types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown, field: string, id: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`domain ${JSON.stringify(id)}: ${field} must be a string array`);
  }
  return value;
};

function normalizeDomain(value: unknown, seen: Set<string>): Domain {
  if (!isRecord(value)) throw new Error("domain entry must be an object");
  const id = typeof value.id === "string" ? value.id : "";
  const path = typeof value.path === "string" ? value.path : "";
  if (!id) throw new Error("domain has empty id");
  if (seen.has(id)) throw new Error(`duplicate domain id ${JSON.stringify(id)}`);
  seen.add(id);
  if (!path) throw new Error(`domain ${JSON.stringify(id)}: empty path`);
  if (path.startsWith("/")) throw new Error(`domain ${JSON.stringify(id)}: path must be relative, got ${JSON.stringify(path)}`);
  if (path.includes("..")) throw new Error(`domain ${JSON.stringify(id)}: path may not contain '..'`);

  const files = stringArray(value.files, "files", id);
  for (const file of files ?? []) {
    if (!file || file.includes("/") || file.includes("\\")) {
      throw new Error(`domain ${JSON.stringify(id)}: invalid file basename ${JSON.stringify(file)}`);
    }
    if (file.endsWith(".md")) {
      throw new Error(`domain ${JSON.stringify(id)}: file ${JSON.stringify(file)} should be declared without .md suffix`);
    }
  }

  const triggers = stringArray(value.triggers, "triggers", id);
  let subdomains: Domain[] | undefined;
  if (value.subdomains !== undefined) {
    if (!Array.isArray(value.subdomains)) throw new Error(`domain ${JSON.stringify(id)}: subdomains must be an array`);
    subdomains = value.subdomains.map((d) => normalizeDomain(d, seen));
  }

  return {
    id,
    path,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(triggers ? { triggers } : {}),
    ...(files ? { files } : {}),
    ...(subdomains ? { subdomains } : {}),
  };
}

/**
 * Validate an in-memory manifest body and return the normalized Domain list.
 * Used at write-time (by `store/write.ts`) to catch invalid manifests before
 * they reach disk, and as the post-parse half of `loadManifest`.
 *
 * `sourceLabel` is woven into the error message; pass the on-disk path when
 * validating a file read, or omit for raw write-time validation.
 */
export function validateManifestContent(content: string, sourceLabel?: string): Domain[] {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: parse${where}: ${(err as Error).message}`);
  }
  if (raw == null) return [];
  if (!isRecord(raw)) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: validate${where}: manifest must be an object`);
  }
  if (raw.domains == null) return [];
  if (!Array.isArray(raw.domains)) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: validate${where}: domains must be an array`);
  }

  try {
    const seen = new Set<string>();
    return raw.domains.map((d) => normalizeDomain(d, seen));
  } catch (err) {
    const where = sourceLabel ? ` ${JSON.stringify(sourceLabel)}` : "";
    throw new Error(`domain: validate${where}: ${(err as Error).message}`);
  }
}

export function loadManifest(rootDir: string): Domain[] {
  const manifestPath = join(rootDir, "domains.yml");
  if (!existsSync(manifestPath)) return [];
  // TOCTOU between stat and read: a mid-edit partial read parses to an
  // error → caught → stale-but-served via the error path. Matches Go.
  return validateManifestContent(readFileSync(manifestPath, "utf8"), manifestPath);
}
```

### Step 3: Re-export from the memory index

Modify `server/src/memory/index.ts`. Find the existing `loadManifest` re-export and add `validateManifestContent` alongside it.

### Step 4: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests 158/158 unchanged (refactor is behavior-preserving). The error message format is preserved because the path label is now built from `JSON.stringify(manifestPath)` exactly as before.

### Step 5: Commit

```bash
cd /tmp/cog-cleanup-manifest
git add server/src/memory/domain/manifest.ts server/src/memory/index.ts
git commit -m "refactor(memory): factor validateManifestContent out of loadManifest"
```

---

## Task 2: Validate `domains.yml` on write

**Files:**
- Modify: `server/src/memory/store/write.ts` (validate `domains.yml` content before atomic write)
- Create: `server/test/memory/store-validate-domains.test.ts` (new test file dedicated to the write-time validation behavior)

### Step 1: Write the failing test

Create `server/test/memory/store-validate-domains.test.ts`:

```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { write } from "../../src/memory/index.ts";

let root = "";
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-validate-domains-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  warnSpy?.mockRestore();
  warnSpy = null;
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

const validManifest = `version: 1
domains:
  - id: demo
    path: projects/demo
    label: demo
    files: [hot-memory]
`;

describe("write(domains.yml) — validate on write", () => {
  test("accepts a valid manifest", async () => {
    const result = await write("domains.yml", validManifest);
    expect(result.bytes).toBeGreaterThan(0);
    const persisted = await readFile(join(root, "domains.yml"), "utf8");
    expect(persisted).toBe(validManifest);
  });

  test("rejects a manifest with duplicate ids — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: dup
    path: projects/dup-a
    files: [hot-memory]
  - id: dup
    path: projects/dup-b
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/duplicate domain id "dup"/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("rejects manifest with empty id — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: ""
    path: projects/x
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/empty id/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("rejects manifest with absolute path — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: x
    path: /absolute/bad
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/path must be relative/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("rejects unparseable YAML — bytes not written", async () => {
    const bad = `version: 1
domains:
  - id: x
    path: bad
   indented_wrong: yes
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/parse|validate/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("does not validate non-manifest writes (regression guard)", async () => {
    // link-index.md is in the canonical allowlist and is NOT a manifest;
    // its writer must pass through unaffected.
    const result = await write("link-index.md", "# Link index\n\n- foo → bar\n");
    expect(result.bytes).toBeGreaterThan(0);
  });

  test("subsequent valid write overwrites prior valid manifest", async () => {
    await write("domains.yml", validManifest);
    const updated = validManifest + `  - id: demo2
    path: projects/demo2
    files: [hot-memory]
`;
    const result = await write("domains.yml", updated);
    expect(result.bytes).toBeGreaterThan(0);
    const persisted = await readFile(join(root, "domains.yml"), "utf8");
    expect(persisted).toBe(updated);
  });

  test("after a rejected write, a clean retry succeeds", async () => {
    const bad = `version: 1
domains:
  - id: dup
    path: projects/dup-a
    files: [hot-memory]
  - id: dup
    path: projects/dup-b
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/duplicate/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);

    const result = await write("domains.yml", validManifest);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(join(root, "domains.yml"))).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/memory/store-validate-domains.test.ts`
Expected: FAIL — the "rejects duplicate ids" and similar negative tests fail because the current `write()` accepts any content for `domains.yml`.

### Step 3: Wire the validation into write.ts

Modify `server/src/memory/store/write.ts` to:

```ts
import type { WriteResult } from "../types.ts";
import { validateManifestContent } from "../domain/manifest.ts";
import { atomicWrite } from "./fs.ts";
import { maybeAutoCommit } from "./auto-commit.ts";
import { resolveMemoryPath, validateWholeFileWritePath } from "./paths.ts";

export async function write(path: string, content: string): Promise<WriteResult> {
  const { abs, rel } = await resolveMemoryPath(path);
  await validateWholeFileWritePath(rel);
  // Manifest writes get content-validated before they ever reach disk:
  // a bad manifest landing silently would surface as an "unknown id" error
  // on the next routing RPC — too far from cause.
  if (rel === "domains.yml") {
    validateManifestContent(content);
  }
  await atomicWrite(abs, content);
  await maybeAutoCommit();
  return { bytes: Buffer.byteLength(content) };
}
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run test/memory/store-validate-domains.test.ts`
Expected: PASS — 7 tests green.

### Step 5: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests 165 (158 baseline + 7 new). The existing `store.test.ts` covers the happy `domains.yml` path; verify it still passes — the only behavior change is that previously-undetected bad content now rejects.

### Step 6: Commit

```bash
cd /tmp/cog-cleanup-manifest
git add server/src/memory/store/write.ts server/test/memory/store-validate-domains.test.ts
git commit -m "feat(memory): validate domains.yml content on write (closes #202)"
```

---

## Task 3: Surface manifest load errors through `Controller.get()`

**Files:**
- Modify: `server/src/memory/domain/controller.ts` (enrich `get()` error message when `lastError` is set)
- Modify: `server/test/memory/domain.test.ts` (add tests for the enriched error message)

The seam is `Controller.get(id)` itself — every routing RPC that does `c.get(params.domain)` (`recent-observations.ts`, `open-actions.ts`, `domain-summary.ts`) goes through this method, and `tools/cog.ts`'s `domains.get` dispatcher does too. Wrapping at the controller boundary is one edit; wrapping at each call site would be three.

### Step 1: Write the failing test

Append to `server/test/memory/domain.test.ts` (inside the existing `describe("memory domain controller", ...)` block):

```ts
test("get() includes cached load error when one is present", () => {
  const dir = tempRoot(goodManifest);
  const c = new Controller(dir);
  // Confirm clean baseline: get() works for known id, plain message for unknown id.
  expect(c.get("personal").id).toBe("personal");
  expect(() => c.get("nope")).toThrow(/^domain: unknown id "nope"$/);

  // Corrupt the manifest in-place to trigger a hot-reload failure.
  bumpManifest(dir, `version: 1
domains:
  - id: dup
    path: a
    files: [hot-memory]
  - id: dup
    path: b
    files: [hot-memory]
`);

  // Next get() call triggers maybeReload(), which fails and records lastError.
  // Known id from prior good load is still served (stale-but-served).
  expect(c.get("personal").id).toBe("personal");
  expect(c.lastError).not.toBeNull();
  expect(c.lastError!.message).toMatch(/duplicate domain id "dup"/);

  // Unknown id error is enriched with the cached load error.
  let caught: Error | null = null;
  try { c.get("nope"); } catch (err) { caught = err as Error; }
  expect(caught).not.toBeNull();
  expect(caught!.message).toMatch(/unknown id "nope"/);
  expect(caught!.message).toMatch(/last manifest load failed:/);
  expect(caught!.message).toMatch(/duplicate domain id "dup"/);
});

test("get() error stays bare when no load error is cached", () => {
  const dir = tempRoot(goodManifest);
  const c = new Controller(dir);
  expect(() => c.get("nope")).toThrow(/^domain: unknown id "nope"$/);
  expect(c.lastError).toBeNull();
});
```

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/memory/domain.test.ts -t "includes cached load error"`
Expected: FAIL — the enrichment test fails because the current `get()` throws `domain: unknown id "nope"` regardless of `lastError`.

### Step 3: Enrich the error in `Controller.get()`

In `server/src/memory/domain/controller.ts`, modify the `get` method:

```ts
get(id: string): Domain {
  this.maybeReload();
  const domain = this.flat.get(id);
  if (!domain) {
    const base = `domain: unknown id ${JSON.stringify(id)}`;
    if (this.lastError) {
      throw new Error(`${base} (last manifest load failed: ${this.lastError.message})`);
    }
    throw new Error(base);
  }
  return structuredClone(domain);
}
```

### Step 4: Run test to verify it passes

Run: `cd server && npx vitest run test/memory/domain.test.ts`
Expected: PASS — all existing tests + 2 new ones green.

### Step 5: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests 167 (165 from prior task + 2 new). No regressions because the clean-case message is unchanged.

### Step 6: Commit

```bash
cd /tmp/cog-cleanup-manifest
git add server/src/memory/domain/controller.ts server/test/memory/domain.test.ts
git commit -m "feat(memory): Controller.get() surfaces cached manifest load error (closes #203)"
```

---

## Task 4: End-to-end integration test — bad write → routing RPC sees enriched error

**Files:**
- Create: `server/test/memory/manifest-error-surface.test.ts`

This task verifies the two changes compose end-to-end: an invalid manifest *written through `cog_write`* is rejected before disk (Task 2), AND if a bad manifest somehow lands (e.g. via an out-of-process edit), a subsequent routing RPC surfaces the cached error (Task 3).

### Step 1: Write the integration test

Create `server/test/memory/manifest-error-surface.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Controller, write } from "../../src/memory/index.ts";

let root = "";
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-manifest-surface-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  warnSpy?.mockRestore();
  warnSpy = null;
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

const goodManifest = `version: 1
domains:
  - id: demo
    path: projects/demo
    label: demo
    files: [hot-memory]
`;

describe("manifest error surface — end-to-end", () => {
  test("bad cog_write to domains.yml never reaches disk", async () => {
    const bad = `version: 1
domains:
  - id: x
    path: ""
    files: [hot-memory]
`;
    await expect(write("domains.yml", bad)).rejects.toThrow(/empty path/);
    expect(existsSync(join(root, "domains.yml"))).toBe(false);
  });

  test("an out-of-process bad manifest is observable via Controller.get()", async () => {
    // Simulate the path where cog_write's guard was bypassed (e.g. an external
    // editor wrote the file). The controller hot-reloads on mtime change and
    // records the error; subsequent get() surfaces it.
    await write("domains.yml", goodManifest);
    const c = new Controller(root);
    expect(c.get("demo").id).toBe("demo");

    // Out-of-process bad write (mimics an external editor or older tool).
    await writeFile(join(root, "domains.yml"), `version: 1
domains:
  - id: dup
    path: a
    files: [hot-memory]
  - id: dup
    path: b
    files: [hot-memory]
`, "utf8");
    const t = new Date(Date.now() + 1000);
    utimesSync(join(root, "domains.yml"), t, t);

    // Routing-RPC-level call surfaces enriched error.
    let caught: Error | null = null;
    try { c.get("anything"); } catch (err) { caught = err as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/last manifest load failed:/);
    expect(caught!.message).toMatch(/duplicate domain id "dup"/);
  });
});
```

### Step 2: Run the test

Run: `cd server && npx vitest run test/memory/manifest-error-surface.test.ts`
Expected: PASS — 2 tests green. (No "verify it fails" step because both behaviors are now present from Tasks 2 + 3; this test is the integration guard.)

### Step 3: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests 169 (167 + 2 new).

### Step 4: Commit

```bash
cd /tmp/cog-cleanup-manifest
git add server/test/memory/manifest-error-surface.test.ts
git commit -m "test(memory): integration test — bad manifest surface end-to-end"
```

---

## Task 5: Pre-PR sweep

### Step 1: Confirm full gate green

Run: `bash scripts/gate.sh`
Expected: PASS — server tests 169 (baseline 158 + 11 new), web tests 158 (unchanged), lint + typecheck clean.

### Step 2: Confirm no scope creep

Run: `git diff --stat main..HEAD`
Expected: only the following files touched:
- `server/src/memory/domain/manifest.ts`
- `server/src/memory/domain/controller.ts`
- `server/src/memory/store/write.ts`
- `server/src/memory/index.ts`
- `server/test/memory/domain.test.ts`
- `server/test/memory/store-validate-domains.test.ts` (new)
- `server/test/memory/manifest-error-surface.test.ts` (new)

If any other file is in the diff, investigate before opening the PR.

### Step 3: Check rebase status against origin/main

Run: `git fetch origin main && git log origin/main..HEAD --oneline`
Expected: only the commits from Tasks 1-4. If `origin/main` has advanced, rebase and re-run the gate.

### Step 4: Verify PR-1 is NOT in the diff

PR-1 and PR-2 are independently reviewable; they must NOT cross-contaminate. Confirm `git log main..HEAD --oneline` shows only commits from this plan, with no `init_canonical_file` or `skill_write` references.

### Step 5: Hand back to `/ship`

The plan ends here. `/ship` handles push + PR open + merge.

PR body must say: "Closes #202, #203."

---

## Gate baseline reference

Recorded on this worktree at start: server tests 158 pass, web tests 158 pass, lint + typecheck clean. Final expected: server tests 169 pass (+11 new), web tests 158 pass (unchanged), lint + typecheck clean.

## Out of scope for this PR

- `init_canonical_file` + `skill_write` RPCs → PR-1
- `/cog` skill rewrite → PR-3
- #204 (`cog_rpc` id-vs-path param consistency) → standalone, deferred
- #205 (`cog_append` response shape) → standalone, deferred
- Self-heal logic for legacy duplicate-id manifests → handled by PR-3 skill-side dedupe
