# Cog-LTM Bridge 1 Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Mirror every cog observation into LTM as `kind: "observation"` via a first-class `recordObservation()` API, with a 5-min in-process reconciler catching drift and a CLI escape hatch for manual replay.

**Spec:** `docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md`

**Architecture:** New first-class `recordObservation()` method on the memory module (replaces `cog_append observations.md` calls). Inline best-effort mirror to LTM via `bridge/ltm-observer.ts`. Periodic reconciler (in-process timer, mtime-bounded scan) catches misses. CLI subcommands `npx ytsejam ltm replay [--force]` and `ltm health` for manual control. Server stderr WARNING + `memory.health()` accessor for failure surface; web UI surfacing deferred to issue #92.

**Tech Stack:** TypeScript, Node 22, vitest, ytsejam's existing memory module, `packages/ltm` workspace.

**Worktree:** `/tmp/cog-ltm-bridge-1`

**Branch:** `feat/cog-ltm-bridge-1-observer`

---

## Task ordering

Bottom-up, each task ships a green gate:

1. **Task 1** — `ltm-observer.ts` parser + origin (pure functions, no I/O, easiest to test)
2. **Task 2** — `hasObservation()` in LTM (~5 LOC LTM addition + test)
3. **Task 3** — `ltm-observer.ts` mirror function (composes 1+2)
4. **Task 4** — `recordObservation()` method on memory module + `attachLtm()` plumbing
5. **Task 5** — Migrate call sites from `cog_append observations.md` to `recordObservation()`
6. **Task 6** — `LtmReconciler` class (timer, reconcile loop, mtime cache, health)
7. **Task 7** — Lifecycle wiring on server boot
8. **Task 8** — CLI subcommands (`ltm replay`, `ltm health`)
9. **Task 9** — Documentation + manual smoke + PR open

Each task is a single commit (or a small commit-pair if test-then-code separates cleanly). The PR holds 9-12 commits at the end.

---

## Task 1: parser + origin in `bridge/ltm-observer.ts`

**Files:**
- Create: `server/src/memory/bridge/ltm-observer.ts`
- Test: `server/test/memory/bridge/ltm-observer.test.ts`

### Step 1: Write the failing tests

```ts
// server/test/memory/bridge/ltm-observer.test.ts
import { describe, expect, it } from "vitest";
import {
  parseObservationLine,
  computeOrigin,
} from "../../../src/memory/bridge/ltm-observer.js";

describe("parseObservationLine", () => {
  it("parses a tagged single-line observation", () => {
    const r = parseObservationLine("- 2026-06-13 [ltm,bridge]: shipped PR 1 today");
    expect(r).toEqual({
      text: "shipped PR 1 today",
      timestamp: "2026-06-13T00:00:00.000Z",
      tags: ["ltm", "bridge"],
    });
  });

  it("trims whitespace and tag entries", () => {
    const r = parseObservationLine("- 2026-06-13 [  ltm , bridge  ]:   spaced out  ");
    expect(r).toEqual({
      text: "spaced out",
      timestamp: "2026-06-13T00:00:00.000Z",
      tags: ["ltm", "bridge"],
    });
  });

  it("returns null on malformed date", () => {
    expect(parseObservationLine("- 26-6-13 [x]: bad date")).toBeNull();
  });

  it("returns null on missing dash prefix", () => {
    expect(parseObservationLine("2026-06-13 [x]: no dash")).toBeNull();
  });

  it("returns null on missing colon", () => {
    expect(parseObservationLine("- 2026-06-13 [x] no colon")).toBeNull();
  });

  it("returns null on empty text body", () => {
    expect(parseObservationLine("- 2026-06-13 [x]: ")).toBeNull();
  });

  it("handles multi-tag without spaces", () => {
    const r = parseObservationLine("- 2026-06-13 [a,b,c,d]: many tags");
    expect(r?.tags).toEqual(["a", "b", "c", "d"]);
  });

  it("returns null on untagged observation (tags required per cog SSOT)", () => {
    expect(parseObservationLine("- 2026-06-13: missing tags")).toBeNull();
  });

  it("returns null on empty tag block [  ]", () => {
    expect(parseObservationLine("- 2026-06-13 [  ]: tags spaces-only")).toBeNull();
  });

  it("returns null on empty tag block []", () => {
    expect(parseObservationLine("- 2026-06-13 []: no tags")).toBeNull();
  });

  it("returns null on whitespace-only tag entries [, ,]", () => {
    // split yields ["", " ", ""], all trimmed to "" and filtered -> tags.length === 0
    expect(parseObservationLine("- 2026-06-13 [, ,]: no real tags")).toBeNull();
  });

  it("returns null on structurally-valid but invalid date (2026-13-99)", () => {
    expect(parseObservationLine("- 2026-13-99 [x]: bad month and day")).toBeNull();
  });

  it("returns null on Feb 30", () => {
    expect(parseObservationLine("- 2026-02-30 [x]: not a real day")).toBeNull();
  });

  it("returns null on embedded newline in body (regex stops at \n)", () => {
    expect(parseObservationLine("- 2026-06-13 [x]: line one\nline two")).toBeNull();
  });
});

describe("computeOrigin", () => {
  it("produces a stable cog:<path>/<file>#<hash> shape", () => {
    const o = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    expect(o).toMatch(/^cog:personal\/observations\.md#[0-9a-f]{12}$/);
  });

  it("distinguishes same line in two different files", () => {
    const a = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    const b = computeOrigin("projects/ytsejam", "observations.md", "- 2026-06-13 [x]: foo");
    expect(a).not.toBe(b);
  });

  it("distinguishes two lines in the same file", () => {
    const a = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    const b = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: bar");
    expect(a).not.toBe(b);
  });

  it("is deterministic across calls", () => {
    const a = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    const b = computeOrigin("personal", "observations.md", "- 2026-06-13 [x]: foo");
    expect(a).toBe(b);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `env -u NODE_ENV npm test --workspace server -- ltm-observer`
Expected: FAIL — module not found / functions undefined.

### Step 3: Implement the parser + origin

```ts
// server/src/memory/bridge/ltm-observer.ts
import { createHash } from "node:crypto";

export type ParsedObservation = {
  text: string;
  timestamp: string;
  tags: string[];
};

// Mirrors the cog SSOT validator in server/src/memory/store/append.ts:7.
// Tags are MANDATORY (non-empty bracket block); body is mandatory and non-empty.
const OBSERVATION_LINE_RE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s*:\s*(.+?)\s*$/;

export function parseObservationLine(line: string): ParsedObservation | null {
  const m = OBSERVATION_LINE_RE.exec(line);
  if (!m) return null;
  const [, date, tagBlock, text] = m;
  if (!text || !text.trim()) return null;
  // Date validity: 2026-13-99 etc. would pass the shape regex but produce
  // an Invalid Date downstream. Mirrors observations-parser.ts:11-12.
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    return null;
  }
  const tags = tagBlock
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tags.length === 0) return null; // [   ] or [, ,] yields zero tags -> invalid per cog SSOT
  return {
    text: text.trim(),
    timestamp: `${date}T00:00:00.000Z`,
    tags,
  };
}

export function computeOrigin(
  domainPath: string,
  filename: string,
  rawLine: string,
): string {
  const basis = `${domainPath}/${filename}\u0000${rawLine}`;
  const hash = createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 12);
  return `cog:${domainPath}/${filename}#${hash}`;
}
```

### Step 4: Run tests to verify they pass

Run: `env -u NODE_ENV npm test --workspace server -- ltm-observer`
Expected: PASS (12/12).

### Step 5: Run full gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add server/src/memory/bridge/ltm-observer.ts \
        server/test/memory/bridge/ltm-observer.test.ts
git commit -m "feat(memory): parse + origin helpers for cog->LTM observer bridge

Pure functions, no I/O. parseObservationLine requires tagged observations,
handles whitespace-noisy variants, validates calendar dates, and returns null
on malformed input.
computeOrigin produces cog:<domainPath>/<filename>#<sha256-12> with a
null byte separator so path and line text can't collide.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 1)."
```

---

## Task 2: `hasObservation()` in LTM

**Files:**
- Modify: `packages/ltm/src/api/memory-system.ts` (add method)
- Test: `packages/ltm/test/observation.test.ts` (extend existing file)

### Step 1: Write the failing test

Append to `packages/ltm/test/observation.test.ts`:

```ts
describe("MemorySystem.hasObservation", () => {
  it("returns false before record, true after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-has-"));
    const mem = await MemorySystem.open({ storeDir: dir });
    try {
      const origin = "cog:personal/observations.md#abc123def456";
      expect(mem.hasObservation(origin)).toBe(false);
      await mem.recordObservation({
        text: "hello",
        timestamp: "2026-06-13T00:00:00.000Z",
        origin,
      });
      expect(mem.hasObservation(origin)).toBe(true);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns false for origins from other records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-has-"));
    const mem = await MemorySystem.open({ storeDir: dir });
    try {
      await mem.recordObservation({
        text: "hello",
        timestamp: "2026-06-13T00:00:00.000Z",
        origin: "cog:personal/observations.md#aaa",
      });
      expect(mem.hasObservation("cog:personal/observations.md#bbb")).toBe(false);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("survives a close/reopen cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-has-"));
    const origin = "cog:projects/ytsejam/observations.md#deadbeef1234";
    let mem = await MemorySystem.open({ storeDir: dir });
    try {
      await mem.recordObservation({
        text: "persisted",
        timestamp: "2026-06-13T00:00:00.000Z",
        origin,
      });
    } finally {
      mem.close();
    }
    mem = await MemorySystem.open({ storeDir: dir });
    try {
      expect(mem.hasObservation(origin)).toBe(true);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

### Step 2: Run test to verify it fails

Run: `env -u NODE_ENV npm test --workspace ltm -- observation`
Expected: FAIL — `mem.hasObservation is not a function`.

### Step 3: Implement `hasObservation`

In `packages/ltm/src/api/memory-system.ts`, add to the `MemorySystem` class (group with other read-side methods):

```ts
/**
 * Returns true if any episodic record exists with the given origin
 * string. Synchronous; backed by the in-memory episodic index.
 * Used by the cog-LTM bridge to skip already-mirrored observations.
 */
hasObservation(origin: string): boolean {
  return this.episodic.records.some((r) => r.origin === origin);
}
```

Implementer note: if `this.episodic.records` is not the right accessor name (interface drifted since the design memo was written), use whatever the canonical "all episodic records" iterator is. Find via `grep -rE "kind:\s*['\"]observation['\"]" packages/ltm/src/` and follow the read path.

### Step 4: Run test to verify it passes

Run: `env -u NODE_ENV npm test --workspace ltm -- observation`
Expected: PASS (existing observation tests + 3 new).

### Step 5: Run full gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add packages/ltm/src/api/memory-system.ts \
        packages/ltm/test/observation.test.ts
git commit -m "feat(ltm): hasObservation(origin) lookup for bridge dedup

Synchronous lookup over the episodic index for the cog->LTM bridge to
skip records it already mirrored. SEAM 5b makes re-record idempotent
anyway; this saves the parse+record work for already-present lines.

Refs ytsejam docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md
(Task 2)."
```

---

## Task 3: `mirrorToLtm()` in `bridge/ltm-observer.ts`

**Files:**
- Modify: `server/src/memory/bridge/ltm-observer.ts` (add function)
- Test: `server/test/memory/bridge/ltm-observer.test.ts` (extend)

### Step 1: Write the failing tests

Append to `server/test/memory/bridge/ltm-observer.test.ts`:

```ts
import { MemorySystem } from "ltm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorToLtm } from "../../../src/memory/bridge/ltm-observer.js";

describe("mirrorToLtm", () => {
  it("records the observation in LTM and returns ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ltm-mirror-"));
    const mem = await MemorySystem.open({ storeDir: dir });
    try {
      const origin = "cog:personal/observations.md#aaa111bbb222";
      const r = await mirrorToLtm(
        mem,
        {
          text: "shipped Bridge 1",
          timestamp: "2026-06-13T00:00:00.000Z",
          tags: ["ltm", "bridge"],
        },
        origin,
      );
      expect(r).toEqual({ ok: true });
      expect(mem.hasObservation(origin)).toBe(true);
    } finally {
      mem.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns {ok:false,error} on LTM throw, NEVER throws", async () => {
    const fakeLtm = {
      recordObservation: async () => {
        throw new Error("disk full");
      },
    } as unknown as MemorySystem;
    const r = await mirrorToLtm(
      fakeLtm,
      { text: "x", timestamp: "2026-06-13T00:00:00.000Z", tags: ["bug"] },
      "cog:x/observations.md#deadbeef",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message).toBe("disk full");
    }
  });
});
```

### Step 2: Run tests to verify they fail

Run: `env -u NODE_ENV npm test --workspace server -- ltm-observer`
Expected: FAIL — `mirrorToLtm` not exported.

### Step 3: Implement `mirrorToLtm`

Add to `server/src/memory/bridge/ltm-observer.ts`:

```ts
import type { MemorySystem } from "ltm";

const SALIENCE_COG_OBSERVATION = 0.85;

export async function mirrorToLtm(
  ltm: MemorySystem,
  parsed: ParsedObservation,
  origin: string,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  try {
    await ltm.recordObservation({
      text: parsed.text,
      timestamp: parsed.timestamp,
      tags: parsed.tags,
      origin,
      salience: SALIENCE_COG_OBSERVATION,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
```

### Step 4: Run tests to verify they pass

Run: `env -u NODE_ENV npm test --workspace server -- ltm-observer`
Expected: PASS (14/14).

### Step 5: Run full gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add server/src/memory/bridge/ltm-observer.ts \
        server/test/memory/bridge/ltm-observer.test.ts
git commit -m "feat(memory): mirrorToLtm best-effort write, never throws

Wraps LTM.recordObservation with hardcoded salience 0.85 for cog
observations (deliberate writes get the high bucket). Returns
{ok:true} on success, {ok:false,error} on any throw. Never propagates
the error so the cog write path stays safe.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 3)."
```

---

## Task 4: `recordObservation()` + `attachLtm()` on the memory namespace

**Files:**
- Modify: `server/src/memory/index.ts` (add 2 module-level exports + state)
- Test: `server/test/memory/record-observation.test.ts` (new)

### Step 1: Write the failing tests

Tests use the existing namespace-style memory module directly. Test setup configures the memory root via `process.env.YTSEJAM_MEMORY_DIR` (matching `server/test/memory/auto-commit.test.ts`) and initializes git so the store's auto-commit path is safe. There is no `openMemory { dataDir }` factory or instance to close; `attachLtm(null)` is the detach/reset pattern for module-level bridge state.

```ts
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySystem } from "ltm";
import {
  attachLtm,
  recordObservation,
} from "../../src/memory/index.ts";

let memRoot = "";
let ltmDir = "";

async function setupMemRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ytsejam-recobs-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  // git init so auto-commit doesn't crash
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "root"], { cwd: root });
  return root;
}

beforeEach(async () => {
  memRoot = await setupMemRoot();
  ltmDir = await mkdtemp(join(tmpdir(), "ltm-recobs-"));
});

afterEach(async () => {
  attachLtm(null);
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (memRoot) await rm(memRoot, { recursive: true, force: true });
  if (ltmDir) await rm(ltmDir, { recursive: true, force: true });
});

describe("memory.recordObservation", () => {
  it("appends the formatted line to <domain>/observations.md and mirrors to LTM", async () => {
    const ltm = MemorySystem.open({ storeDir: ltmDir });
    attachLtm(ltm);
    try {
      const r = await recordObservation({
        domainPath: "personal",
        text: "feeling great",
        tags: ["mood"],
        timestamp: new Date("2026-06-13T12:00:00Z"),
      });
      expect(r.cog).toEqual({ ok: true, line: "- 2026-06-13 [mood]: feeling great" });
      expect(r.ltm).toEqual({ ok: true });
      const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
      expect(file).toContain("- 2026-06-13 [mood]: feeling great");
    } finally {
      ltm.close();
    }
  });

  it("rejects untagged observations (tags mandatory per cog SSOT)", async () => {
    await expect(
      recordObservation({ domainPath: "personal", text: "needs tags" } as unknown as Parameters<typeof recordObservation>[0]),
    ).rejects.toThrow(/tags are mandatory/);
  });

  it("rejects empty tags array (tags mandatory per cog SSOT)", async () => {
    await expect(
      recordObservation({ domainPath: "personal", text: "needs tags", tags: [] }),
    ).rejects.toThrow(/tags are mandatory/);
  });

  it("defaults timestamp to now when omitted", async () => {
    const ltm = MemorySystem.open({ storeDir: ltmDir });
    attachLtm(ltm);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await recordObservation({
        domainPath: "personal",
        text: "now-ish",
        tags: ["time"],
      });
      const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
      expect(file).toContain(`- ${today} [time]: now-ish`);
    } finally {
      ltm.close();
    }
  });

  it("cog write succeeds even when LTM throws", async () => {
    const fakeLtm = {
      recordObservation: async () => {
        throw new Error("ltm exploded");
      },
    } as unknown as MemorySystem;
    attachLtm(fakeLtm);
    const r = await recordObservation({
      domainPath: "personal",
      text: "still gets written",
      tags: ["resilience"],
    });
    expect(r.cog.ok).toBe(true);
    expect(r.ltm.ok).toBe(false);
    if (!r.ltm.ok) {
      expect(r.ltm.error).toBeInstanceOf(Error);
      expect(r.ltm.error.message).toBe("ltm exploded");
    }
    const file = await readFile(join(memRoot, "personal", "observations.md"), "utf8");
    expect(file).toContain("still gets written");
  });

  it("works without attachLtm (cog-only mode)", async () => {
    const r = await recordObservation({
      domainPath: "personal",
      text: "cog only",
      tags: ["cog"],
    });
    expect(r.cog.ok).toBe(true);
    expect(r.ltm).toEqual({ ok: true, skipped: "ltm-not-attached" });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `env -u NODE_ENV npm test --workspace server -- record-observation`
Expected: FAIL — `attachLtm` / `recordObservation` not exported from `index.ts`.

### Step 3: Implement on the memory namespace

In `server/src/memory/index.ts`, add imports near the top with the other imports, then add the module-level bridge state and exports after the existing `append()` function. `tags` is required at the TypeScript type level; the runtime throw is defensive for untyped callers and mirrors the cog SSOT validator/parser invariant. The implementation calls `store.append(...)` directly to write `<domainPath>/observations.md`.

```ts
import type { MemorySystem } from "ltm";
import {
  parseObservationLine,
  computeOrigin,
  mirrorToLtm,
} from "./bridge/ltm-observer.ts";

// -- ltm bridge -----------------------------------------------------------

let attachedLtm: MemorySystem | null = null;

/**
 * Attach (or detach via null) an LTM MemorySystem to receive mirrored
 * observation writes. Module-level state is intentional: the memory
 * namespace itself is process-global (paths.ts configures via
 * YTSEJAM_MEMORY_DIR env), and attachLtm follows that pattern.
 */
export function attachLtm(ltm: MemorySystem | null): void {
  attachedLtm = ltm;
}

/**
 * First-class observation recording: formats the canonical line,
 * appends to <domainPath>/observations.md (SSOT), then best-effort
 * mirrors to attached LTM. Cog write succeeds even when LTM throws
 * or is not attached.
 */
export async function recordObservation(args: {
  domainPath: string;
  text: string;
  tags: string[];
  timestamp?: Date;
}): Promise<{
  cog: { ok: true; line: string };
  ltm:
    | { ok: true }
    | { ok: true; skipped: "ltm-not-attached" }
    | { ok: false; error: Error };
}> {
  if (!args.tags || args.tags.length === 0) {
    throw new Error(
      "recordObservation: tags are mandatory (cog SSOT validator requires [...]). Pass at least one tag.",
    );
  }
  const ts = args.timestamp ?? new Date();
  const date = ts.toISOString().slice(0, 10);
  const line = `- ${date} [${args.tags.join(",")}]: ${args.text}`;

  const path = `${args.domainPath}/observations.md`;
  await store.append(path, line + "\n");
  const cog = { ok: true as const, line };

  if (!attachedLtm) {
    return { cog, ltm: { ok: true, skipped: "ltm-not-attached" } };
  }
  const parsed = parseObservationLine(line);
  if (!parsed) {
    // Should be unreachable since we just formatted it ourselves,
    // but defend rather than crash.
    return {
      cog,
      ltm: {
        ok: false,
        error: new Error(
          `internal: failed to re-parse own formatted line: ${line}`,
        ),
      },
    };
  }
  const origin = computeOrigin(args.domainPath, "observations.md", line);
  const ltmResult = await mirrorToLtm(attachedLtm, parsed, origin);
  if (!ltmResult.ok) {
    console.warn(
      `[memory] ltm bridge: recordObservation mirror failed for ${origin}: ${ltmResult.error.message}`,
    );
  }
  return { cog, ltm: ltmResult };
}
```

Implementer notes:
- `server/src/memory/index.ts` is namespace-style, not class/instance-based; do not introduce `openMemory { dataDir }` or `memory.close()`.
- Module-level `attachedLtm` is intentional and consistent with the rest of the memory namespace, which is process-global and configured via `YTSEJAM_MEMORY_DIR` in `store/paths.ts`.
- Use `attachLtm(null)` to detach/reset LTM bridge state between tests or during shutdown.
- `tags: string[]` is required for typed callers. Keep the runtime guard anyway for JavaScript/untyped callers and casted tests.
- The `skipped` shape (when no LTM attached) lets the reconciler / tests distinguish "no LTM" from "LTM said yes" without an error.

### Step 4: Run tests to verify they pass

Run: `env -u NODE_ENV npm test --workspace server -- record-observation`
Expected: PASS (6/6).

### Step 5: Run full gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add server/src/memory/index.ts \
        server/test/memory/record-observation.test.ts
git commit -m "feat(memory): first-class recordObservation() + attachLtm() API

Module-level recordObservation formats the canonical line, appends to
<domainPath>/observations.md (cog SSOT), then best-effort mirrors to
attached LTM. Cog write succeeds even when LTM throws or is not
attached.

attachLtm(ltm) wires the bridge; attachLtm(null) detaches.
Module-level state matches the rest of the memory namespace, which is
itself process-global (configured via YTSEJAM_MEMORY_DIR env per
store/paths.ts).

Throws on empty tags at runtime to mirror Task 1's parser invariant
and the cog SSOT validator in store/append.ts:7.

Tests cover: real LTM mirror round-trip, untagged-rejects, empty-tags-
rejects, default-now timestamp, LTM-throws-cog-still-writes, no-LTM-
attached cog-only mode. 6 tests.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 4)."
```

---

## Task 5: Migrate call sites to `recordObservation()`

**Files:** discoverable via `grep -rE "observations\.md" server/src/` and `grep -rE "cog_append.*observations" server/src/`.

### Step 1: Audit

Run:

```bash
grep -rnE "observations\.md" server/src/
grep -rnE "cog_append.*observations" server/src/
```

Expected output: a small set (probably ~3-8 call sites). Document the list in the task scratch.

### Step 2: Migrate each call site

For each call site that writes a line to a `<domain>/observations.md`:

**Before:**
```ts
await memory.append("personal/observations.md", "- 2026-06-13 [tag]: text\n");
```

**After:**
```ts
await memory.recordObservation({
  domainPath: "personal",
  text: "text",
  tags: ["tag"],
});
```

If the existing call site composes the line dynamically from `date + tags + text`, extract those values and pass them as args. If the call site uses a different timestamp than now, pass `timestamp: new Date(...)`.

**Do NOT migrate:** any `append()` calls that write to files OTHER than `observations.md`. Those stay on `append()`.

### Step 3: Run tests + gate

Run: `scripts/gate.sh`
Expected: PASSED. All existing tests that previously asserted observations.md content via `append()` should still pass because the resulting line is byte-identical.

### Step 4: Commit per call site or as one migration commit (use judgment)

If 1-3 call sites: one commit. If more: one commit per file makes the PR diff easier to review.

```bash
git add <migrated files>
git commit -m "refactor(memory): migrate observations.md appends to recordObservation()

[list of files]

Mechanical migration; identical line format, no behavior change for the
cog half. Now gets the LTM bridge for free.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 5)."
```

---

## Task 6: `LtmReconciler` class

**Files:**
- Create: `server/src/memory/bridge/ltm-reconciler.ts` (~150 LOC)
- Test: `server/test/memory/bridge/ltm-reconciler.test.ts` (new)

### Step 1: Write the failing tests

```ts
// server/test/memory/bridge/ltm-reconciler.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { MemorySystem } from "ltm";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LtmReconciler } from "../../../src/memory/bridge/ltm-reconciler.js";

describe("LtmReconciler", () => {
  let dataDir: string;
  let ltmDir: string;
  let ltm: MemorySystem;
  let reconciler: LtmReconciler;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "recon-data-"));
    ltmDir = await mkdtemp(join(tmpdir(), "recon-ltm-"));
    ltm = await MemorySystem.open({ storeDir: ltmDir });
  });
  afterEach(async () => {
    await reconciler?.stop();
    ltm.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(ltmDir, { recursive: true, force: true });
  });

  it("replays missed lines from observations.md on reconcile()", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n- 2026-06-11 [b]: line two\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(2);
    expect(stats.scannedLines).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it("skips already-mirrored lines on subsequent reconcile", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    await reconciler.reconcile();
    const second = await reconciler.reconcile({ force: true });
    expect(second.replayed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("skips unchanged files via mtime cache when not forced", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    await reconciler.reconcile();
    const cached = await reconciler.reconcile();
    expect(cached.scannedFiles).toBe(0);
    expect(cached.scannedLines).toBe(0);
  });

  it("--force re-walks even unchanged files", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    await reconciler.reconcile();
    const forced = await reconciler.reconcile({ force: true });
    expect(forced.scannedFiles).toBe(1);
    expect(forced.skipped).toBe(1);
  });

  it("isolates per-line errors (malformed line doesn't stop the rest)", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: good\nMALFORMED\n- 2026-06-11 [b]: also good\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    const stats = await reconciler.reconcile();
    expect(stats.replayed).toBe(2);
    expect(stats.errors).toBe(1);
  });

  it("start() registers the timer and is idempotent", () => {
    reconciler = new LtmReconciler({ ltm, dataDir, intervalMs: 1000 });
    reconciler.start();
    reconciler.start(); // should not stack
    // no public observable for "interval count" — assertion is "no throw"
    expect(reconciler.health().reachable).toBe(true);
  });

  it("stop() clears the timer and awaits in-flight tick", async () => {
    reconciler = new LtmReconciler({ ltm, dataDir, intervalMs: 1000 });
    reconciler.start();
    await reconciler.stop();
    // no observable but: stop() must not throw, and subsequent reconcile is callable
    const stats = await reconciler.reconcile();
    expect(stats.scannedFiles).toBeGreaterThanOrEqual(0);
  });

  it("health: transient failure does not climb consecutiveFailures past recovery", async () => {
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: line one\n",
    );
    reconciler = new LtmReconciler({ ltm, dataDir });
    // inject a thrown tick via spying on a private method? simpler: use a fake LTM
    const fakeLtm = {
      hasObservation: () => false,
      recordObservation: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined),
    } as unknown as MemorySystem;
    await reconciler.stop();
    reconciler = new LtmReconciler({ ltm: fakeLtm, dataDir });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBe(1);
    expect(reconciler.health().consecutiveFailures).toBe(0); // per-line, not per-tick
    expect(reconciler.health().recentFailureCount).toBe(1);
    const r2 = await reconciler.reconcile({ force: true });
    expect(r2.errors).toBe(0);
    expect(reconciler.health().recentFailureCount).toBe(0);
  });

  it("health: tick-level throw increments consecutiveFailures", async () => {
    // Use a dataDir that doesn't exist to force a tick-level error
    reconciler = new LtmReconciler({ ltm, dataDir: "/nonexistent-path-xyz-12345" });
    const r1 = await reconciler.reconcile();
    expect(r1.errors).toBeGreaterThanOrEqual(1);
    expect(reconciler.health().consecutiveFailures).toBe(1);
    const r2 = await reconciler.reconcile();
    expect(reconciler.health().consecutiveFailures).toBe(2);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `env -u NODE_ENV npm test --workspace server -- ltm-reconciler`
Expected: FAIL — module not found.

### Step 3: Implement `LtmReconciler`

```ts
// server/src/memory/bridge/ltm-reconciler.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemorySystem } from "ltm";
import {
  parseObservationLine,
  computeOrigin,
  mirrorToLtm,
} from "./ltm-observer.js";

type Logger = (level: "warn" | "info", msg: string, meta?: object) => void;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export type ReconcileStats = {
  scannedFiles: number;
  scannedLines: number;
  replayed: number;
  skipped: number;
  errors: number;
};

export type Health = {
  reachable: boolean;
  lastError?: { message: string; at: string };
  consecutiveFailures: number;
  recentFailureCount: number;
  lastTickAt?: string;
  lastTickStats?: ReconcileStats;
};

export class LtmReconciler {
  private readonly ltm: MemorySystem;
  private readonly dataDir: string;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly mtimeCache = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private health_: Health = {
    reachable: true,
    consecutiveFailures: 0,
    recentFailureCount: 0,
  };

  constructor(opts: {
    ltm: MemorySystem;
    dataDir: string;
    intervalMs?: number;
    logger?: Logger;
  }) {
    this.ltm = opts.ltm;
    this.dataDir = opts.dataDir;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger =
      opts.logger ??
      ((level, msg, meta) => {
        if (level === "warn") console.warn(`[ltm-reconciler] ${msg}`, meta ?? "");
        else console.info(`[ltm-reconciler] ${msg}`, meta ?? "");
      });
  }

  start(): void {
    if (this.timer) return; // idempotent
    this.timer = setInterval(() => {
      void this.tickSafe();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
  }

  health(): Health {
    return { ...this.health_ };
  }

  private async tickSafe(): Promise<void> {
    if (this.inFlight) return; // skip if previous tick still running
    this.inFlight = this.reconcile()
      .then(() => undefined)
      .catch((err) => {
        this.logger("warn", `tick threw out-of-band: ${(err as Error).message}`);
      })
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
  }

  async reconcile(opts?: { force?: boolean }): Promise<ReconcileStats> {
    const force = opts?.force ?? false;
    const stats: ReconcileStats = {
      scannedFiles: 0,
      scannedLines: 0,
      replayed: 0,
      skipped: 0,
      errors: 0,
    };

    let files: string[];
    try {
      files = await this.findObservationFiles();
    } catch (err) {
      this.bumpTickError(err as Error, stats);
      return stats;
    }

    for (const file of files) {
      try {
        const st = await stat(file);
        if (!force) {
          const cached = this.mtimeCache.get(file);
          if (cached !== undefined && st.mtimeMs <= cached) continue;
        }
        stats.scannedFiles++;
        const content = await readFile(file, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        for (let i = 0; i < lines.length; i++) {
          stats.scannedLines++;
          await this.processLine(file, lines[i], i, stats);
        }
        this.mtimeCache.set(file, st.mtimeMs);
      } catch (err) {
        this.bumpTickError(err as Error, stats);
      }
    }

    this.recordTick(stats);
    return stats;
  }

  private async processLine(
    file: string,
    line: string,
    lineNum: number,
    stats: ReconcileStats,
  ): Promise<void> {
    const { domainPath, filename } = this.splitFilePath(file);
    const parsed = parseObservationLine(line);
    if (!parsed) {
      stats.errors++;
      this.logger("warn", `malformed line skipped`, {
        file: `${domainPath}/${filename}`,
        line: lineNum + 1,
      });
      return;
    }
    const origin = computeOrigin(domainPath, filename, line);
    if (this.ltm.hasObservation(origin)) {
      stats.skipped++;
      return;
    }
    const result = await mirrorToLtm(this.ltm, parsed, origin);
    if (result.ok) {
      stats.replayed++;
    } else {
      stats.errors++;
      this.logger("warn", `mirror failed`, {
        origin,
        error: result.error.message,
      });
    }
  }

  private async findObservationFiles(): Promise<string[]> {
    // Walk dataDir for any */observations.md or */**/observations.md
    const results: string[] = [];
    const walk = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name === "observations.md") results.push(full);
      }
    };
    await walk(this.dataDir);
    return results;
  }

  private splitFilePath(file: string): { domainPath: string; filename: string } {
    const rel = file.startsWith(this.dataDir + "/")
      ? file.slice(this.dataDir.length + 1)
      : file;
    const lastSlash = rel.lastIndexOf("/");
    return {
      domainPath: rel.slice(0, lastSlash),
      filename: rel.slice(lastSlash + 1),
    };
  }

  private bumpTickError(err: Error, stats: ReconcileStats): void {
    stats.errors++;
    this.health_.consecutiveFailures++;
    this.health_.recentFailureCount++;
    this.health_.lastError = {
      message: err.message,
      at: new Date().toISOString(),
    };
    this.health_.reachable = false;
    this.logger("warn", `tick error: ${err.message}`);
  }

  private recordTick(stats: ReconcileStats): void {
    this.health_.lastTickAt = new Date().toISOString();
    this.health_.lastTickStats = stats;
    if (stats.errors === 0) {
      this.health_.consecutiveFailures = 0;
      this.health_.recentFailureCount = 0;
      this.health_.reachable = true;
    }
  }
}
```

### Step 4: Run tests to verify they pass

Run: `env -u NODE_ENV npm test --workspace server -- ltm-reconciler`
Expected: PASS (9/9).

### Step 5: Run full gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 6: Commit

```bash
git add server/src/memory/bridge/ltm-reconciler.ts \
        server/test/memory/bridge/ltm-reconciler.test.ts
git commit -m "feat(memory): LtmReconciler — 5min timer + mtime-bounded scan + health

In-process timer drives reconcile() ticks. Each tick walks
<dataDir>/**/observations.md, respects an mtime cache (skips unchanged
files), and uses ltm.hasObservation() to dedup. Per-line errors are
isolated; tick-level errors bump health.consecutiveFailures and
log WARNING. CLI use force:true to ignore mtime cache.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 6)."
```

---

## Task 7: Lifecycle wiring on server boot

**Files:**
- Modify: `server/src/index.ts` (or whichever file is the server entrypoint — discover via `grep -rE "memoryRoot|YTSEJAM_MEMORY_DIR|attachLtm" server/src/`)
- Modify: `server/src/memory/index.ts` (export `getReconciler()` for the health endpoint, optional)

### Step 1: Audit the boot path

Run:

```bash
grep -rnE "memoryRoot|YTSEJAM_MEMORY_DIR|attachLtm" server/src/
grep -rnE "createServer|listen\(" server/src/
```

Identify: (a) where the memory namespace/dataDir is configured, (b) where the server starts listening, (c) where shutdown handlers register.

### Step 2: Add LTM open + reconciler construction + attach

In the boot file, after the memory namespace/dataDir is configured:

```ts
import { MemorySystem } from "ltm";
import { LtmReconciler } from "./memory/bridge/ltm-reconciler.js";

const ltmStoreDir =
  process.env.LTM_STORE_DIR ?? join(dataDir, "ltm");
const ltm = await MemorySystem.open({ storeDir: ltmStoreDir });
const reconciler = new LtmReconciler({
  ltm,
  dataDir,
  intervalMs:
    Number(process.env.LTM_RECONCILE_INTERVAL_MS) || undefined,
});
memory.attachLtm(ltm);
reconciler.start();
console.info(
  `[memory] LTM bridge attached, store=${ltmStoreDir}, reconcile interval=${reconciler["intervalMs"] ?? "default"}ms`,
);
```

### Step 3: Wire shutdown

Wherever existing `SIGTERM` / `SIGINT` handlers live, add (in order — reconciler first so it doesn't fire after LTM closes):

```ts
await reconciler.stop();
memory.attachLtm(null);
ltm.close();
```

If there's no existing handler, register one:

```ts
const shutdown = async (signal: string) => {
  console.info(`[server] ${signal} received, shutting down`);
  await reconciler.stop();
  memory.attachLtm(null);
  ltm.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

### Step 4: Add health access

Export from the memory module (or directly from the boot) a way for the rest of the server to reach `reconciler.health()`. Smallest shape:

```ts
// server/src/memory/index.ts (add)
let attachedReconciler: { health: () => unknown } | null = null;
export function attachReconciler(r: { health: () => unknown }): void {
  attachedReconciler = r;
}
export function health(): { ltm: unknown } {
  return {
    ltm: attachedReconciler ? attachedReconciler.health() : { reachable: false, reason: "not-attached" },
  };
}
```

And in boot: `memory.attachReconciler(reconciler);` after `reconciler.start()`.

### Step 5: Test the wiring path

```ts
// server/test/memory/lifecycle.test.ts (new)
import { describe, expect, it, afterEach } from "vitest";
import { MemorySystem } from "ltm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LtmReconciler } from "../../src/memory/bridge/ltm-reconciler.js";
import * as memory from "../../src/memory/index.js";

describe("server-style memory + reconciler lifecycle", () => {
  let dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });

  it("attach + start + stop without throwing; health surfaces reconciler state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "lc-data-"));
    const ltmDir = await mkdtemp(join(tmpdir(), "lc-ltm-"));
    dirs.push(dataDir, ltmDir);

    process.env.YTSEJAM_MEMORY_DIR = dataDir;
    const ltm = await MemorySystem.open({ storeDir: ltmDir });
    const reconciler = new LtmReconciler({
      ltm,
      dataDir,
      intervalMs: 60_000,
    });
    memory.attachLtm(ltm);
    memory.attachReconciler(reconciler);
    reconciler.start();

    const h = memory.health();
    expect(h.ltm).toMatchObject({ reachable: true });

    await reconciler.stop();
    memory.attachLtm(null);
    ltm.close();
    delete process.env.YTSEJAM_MEMORY_DIR;
  });
});
```

### Step 6: Run tests + gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 7: Commit

```bash
git add server/src/index.ts \
        server/src/memory/index.ts \
        server/test/memory/lifecycle.test.ts
git commit -m "feat(server): wire LTM + reconciler on boot, attach to memory module

Opens LTM at LTM_STORE_DIR (default ~/.ytsejam/data/ltm), constructs
LtmReconciler with LTM_RECONCILE_INTERVAL_MS (default 5min), attaches
to memory module, starts the timer. Shutdown handler stops reconciler
first then closes both stores. memory.health() exposes
reconciler.health() for callers / future web UI / CLI.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 7)."
```

---

## Task 8: CLI subcommands

**Files:**
- Modify: `bin/ytsejam` (or whatever the CLI entrypoint is — discover via `cat package.json | jq '.bin'`)
- Create: `server/src/cli/ltm-commands.ts` (or extend existing CLI module)
- Test: `server/test/cli/ltm-commands.test.ts` (new)

### Step 1: Audit CLI surface

Run:

```bash
cat package.json | jq '.bin'
find server/src/cli -type f 2>/dev/null || echo "(no cli dir yet)"
```

Identify: (a) does the CLI entrypoint exist, (b) what arg-parser is in use (commander, yargs, hand-rolled?), (c) how existing subcommands are wired.

### Step 2: Implement `ltm replay` and `ltm health`

In whatever subcommand pattern exists:

```ts
// server/src/cli/ltm-commands.ts
import { MemorySystem } from "ltm";
import { join } from "node:path";
import { LtmReconciler } from "../memory/bridge/ltm-reconciler.js";

export async function ltmReplay(argv: { force?: boolean; dataDir?: string }): Promise<number> {
  const dataDir = argv.dataDir ?? process.env.YTSEJAM_DATA_DIR ?? `${process.env.HOME}/.ytsejam/data`;
  const ltmStoreDir = process.env.LTM_STORE_DIR ?? join(dataDir, "ltm");
  let ltm: MemorySystem;
  try {
    ltm = await MemorySystem.open({ storeDir: ltmStoreDir });
  } catch (err) {
    console.error(
      `[ltm replay] Could not open LTM at ${ltmStoreDir} — is the ytsejam server running (it holds the single-writer lock)?\n  ${(err as Error).message}`,
    );
    return 1;
  }
  try {
    const reconciler = new LtmReconciler({ ltm, dataDir });
    const stats = await reconciler.reconcile({ force: argv.force });
    console.log(JSON.stringify(stats, null, 2));
    return stats.errors > 0 ? 1 : 0;
  } finally {
    ltm.close();
  }
}

export async function ltmHealth(argv: { dataDir?: string }): Promise<number> {
  // The server's health is only meaningful while the server is running.
  // CLI version: open LTM, do a one-off reconcile, print stats.
  // For server-process health, callers should hit the server's health endpoint instead.
  console.warn("[ltm health] CLI prints last-tick stats; for live server health use the server endpoint.");
  return ltmReplay({ ...argv, force: false });
}
```

Wire into the existing CLI dispatch (whatever shape it has). Smallest viable:

```ts
// in the existing CLI entry
if (subcommand === "ltm" && action === "replay") {
  process.exit(await ltmReplay({ force: flags.force }));
}
if (subcommand === "ltm" && action === "health") {
  process.exit(await ltmHealth({}));
}
```

### Step 3: Tests

```ts
// server/test/cli/ltm-commands.test.ts
import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ltmReplay } from "../../src/cli/ltm-commands.js";

describe("ltmReplay CLI", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("replays observations into a fresh LTM store, exits 0", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cli-data-"));
    const ltmDir = await mkdtemp(join(tmpdir(), "cli-ltm-"));
    dirs.push(dataDir, ltmDir);
    await mkdir(join(dataDir, "personal"), { recursive: true });
    await writeFile(
      join(dataDir, "personal", "observations.md"),
      "- 2026-06-10 [a]: cli line\n",
    );
    const origEnv = process.env.LTM_STORE_DIR;
    process.env.LTM_STORE_DIR = ltmDir;
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const exitCode = await ltmReplay({ force: true, dataDir });
      expect(exitCode).toBe(0);
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    } finally {
      process.env.LTM_STORE_DIR = origEnv;
    }
  });

  it("exits 1 with a clear message when LTM is locked by another process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cli-data-"));
    const ltmDir = await mkdtemp(join(tmpdir(), "cli-ltm-"));
    dirs.push(dataDir, ltmDir);
    const { MemorySystem } = await import("ltm");
    const holder = await MemorySystem.open({ storeDir: ltmDir });
    try {
      const origEnv = process.env.LTM_STORE_DIR;
      process.env.LTM_STORE_DIR = ltmDir;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const exitCode = await ltmReplay({ dataDir });
        expect(exitCode).toBe(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining("single-writer lock"),
        );
      } finally {
        process.env.LTM_STORE_DIR = origEnv;
        errSpy.mockRestore();
      }
    } finally {
      holder.close();
    }
  });
});
```

### Step 4: Run tests + gate

Run: `scripts/gate.sh`
Expected: PASSED.

### Step 5: Commit

```bash
git add server/src/cli/ltm-commands.ts \
        server/test/cli/ltm-commands.test.ts \
        bin/ytsejam
git commit -m "feat(cli): ltm replay [--force] and ltm health subcommands

CLI escape hatch for the bridge reconciler. ltm replay opens LTM (fails
clearly if the server holds the lock), runs one reconcile pass, prints
JSON stats. ltm health is a thin alias for now; live server health
should be queried via the server endpoint.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 8)."
```

---

## Task 9: Documentation + manual smoke + PR open

**Files:**
- Modify: `server/src/memory/README.md` (or create if absent)
- Modify: `README.md` (top-level, add LTM bridge mention)
- Modify: `docs/plans/2026-06-13-cog-ltm-bridge.md` (check off PR 1 tasks, mark "shipped at <sha>")

### Step 1: Document the API

Add to `server/src/memory/README.md`:

```markdown
## `recordObservation()` (preferred over `append()` for observations.md)

```ts
await memory.recordObservation({
  domainPath: "personal",         // or "projects/ytsejam", etc.
  text: "shipped Bridge 1",
  tags: ["ltm", "bridge"],         // optional
  timestamp: new Date(),           // optional, defaults to now
});
```

Two-stage write:
1. Append the formatted line to `<dataDir>/<domainPath>/observations.md` (cog SSOT, must succeed).
2. Best-effort mirror to LTM as a `kind: "observation"` record (decay-shaped retrieval).

The cog half always succeeds independently of LTM. Return value reflects both halves.

### LTM bridge

LTM lives at `~/.ytsejam/data/ltm/` by default; override with `LTM_STORE_DIR`. The bridge runs in-process; an `LtmReconciler` ticks every `LTM_RECONCILE_INTERVAL_MS` (default 5 min) to catch any inline-write failures and to seed LTM on first run. Failures surface as server stderr WARNINGs and on `memory.health().ltm`.

### CLI

- `npx ytsejam ltm replay` — one reconcile pass, mtime-respecting
- `npx ytsejam ltm replay --force` — full re-scan ignoring mtime cache
- `npx ytsejam ltm health` — print last-tick stats (CLI; for live server health use the server endpoint)

### Health surface

```ts
const h = memory.health();
// h.ltm = { reachable, consecutiveFailures, recentFailureCount, lastError?, lastTickAt?, lastTickStats? }
```

Issue #92 tracks surfacing this in the web UI.
```

### Step 2: Update the bridge roadmap doc

In `docs/plans/2026-06-13-cog-ltm-bridge.md`, mark the PR 1 task list items as done, and add a note: `**Shipped at <sha>** — see docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md`.

### Step 3: Manual smoke (documented in PR description, not automated)

In the PR description, include:

```
Manual smoke run by <reviewer> after merge:
1. Pull main, restart ytsejam-user service: `systemctl --user restart ytsejam`
2. Wait 30s for boot.
3. journalctl --user -u ytsejam -n 50 | grep -i ltm
   Expected: "[memory] LTM bridge attached, store=..., reconcile interval=..."
4. Write a new observation through any skill that uses recordObservation().
5. After ~5 min (or run `npx ytsejam ltm replay` immediately):
   npx ltm retrieve "what did Brian write today about <topic>"
   Expected: the observation in the result set.
6. journalctl --user -u ytsejam -n 50 | grep -i "ltm-reconciler"
   Expected: no WARNINGs.
```

### Step 4: Commit docs

```bash
git add server/src/memory/README.md \
        docs/plans/2026-06-13-cog-ltm-bridge.md
git commit -m "docs(memory): document recordObservation() API + LTM bridge

Top-level explanation of the new API, env vars, CLI subcommands, and
health surface. Updates the cog-LTM bridge roadmap to mark PR 1 tasks
shipped.

Refs docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md (Task 9)."
```

### Step 5: Push + PR

```bash
git push -u origin feat/cog-ltm-bridge-1-observer
cat > /tmp/pr-body-bridge-1.md << 'EOF'
Implements PR 1 of the cog-LTM bridge roadmap (docs/plans/2026-06-13-cog-ltm-bridge.md).

**Spec:** docs/plans/2026-06-13-cog-ltm-bridge-1-observer-design.md

## What ships

- First-class `memory.recordObservation()` API: appends to `<domain>/observations.md` (SSOT) and best-effort mirrors to LTM as `kind: "observation"`.
- `LtmReconciler` in-process 5-min timer; mtime-bounded scan; per-line error isolation; health accounting.
- CLI subcommands: `npx ytsejam ltm replay [--force]`, `npx ytsejam ltm health`.
- `memory.health()` accessor (reachable, consecutiveFailures, recentFailureCount, lastError, lastTickAt, lastTickStats).
- LTM-side: new `hasObservation(origin)` lookup (~5 LOC).
- Existing call sites migrated from `append("…/observations.md")` to `recordObservation()`.

## Failure surface

- Server stderr WARNING on every bridge failure (inline + per-tick).
- `memory.health().ltm` for programmatic inspection.
- Web UI surfacing deferred to issue #92.

## Configuration

- `LTM_STORE_DIR` — default `~/.ytsejam/data/ltm`
- `LTM_RECONCILE_INTERVAL_MS` — default 300_000 (5 min)

## Gate

- All tests green (server + ltm + web), tsc clean, build clean.

## Manual smoke

Documented above (Task 9 Step 3); please run after merge.

EOF

gh pr create \
  --base main \
  --head feat/cog-ltm-bridge-1-observer \
  --title "feat(memory): cog->LTM observer bridge (PR 1 of cog-LTM roadmap)" \
  --body-file /tmp/pr-body-bridge-1.md
```

### Step 6: Done

PR opened, gate green, design + plan committed alongside implementation. `ship` skill takes over from here.

---

## Done when (PR-level)

- One PR opened against ytsejam main, `scripts/gate.sh` green.
- `recordObservation()` documented in `server/src/memory/README.md`.
- All call sites that previously wrote to observations.md now use `recordObservation()`.
- Fresh server start with empty LTM: reconciler tick seeds LTM from existing observations; `npx ytsejam ltm health` (or live server health) shows reachable + zero failures.
- A new observation written via `recordObservation()` appears in `npx ltm retrieve` for a related query.
- Issue #92 linked from PR description.

## Estimate

~250-300 LOC + ~200 LOC tests across 9 tasks. ~1-2 days of develop-skill execution at one task per fresh implementer subagent with two-stage review.
