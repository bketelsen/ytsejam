# PR-1: `init_canonical_file` + `skill_write` RPCs

> Execute with the `develop` skill, task-by-task.

**Goal:** Add two new `cog_rpc` methods so the `/cog` skill can create canonical memory files and routing-skill files without going around the cog tool surface.

**Spec:** `docs/plans/2026-06-15-cog-cleanup-design.md` (sections "Primitive 1: `cog_rpc(\"init_canonical_file\", ...)`" and "Primitive 2: `cog_rpc(\"skill_write\", ...)`")

**Architecture:** Two pure-additive RPC methods. Neither changes existing behavior. `init_canonical_file` writes a typed canonical file (`hot-memory`/`observations`/`action-items`/`dev-log`/`generic`) under a registered domain path; `skill_write` writes a routing-skill markdown file with YAML frontmatter under the data directory's `skills/` folder. Both validate the slug rule `^[a-z][a-z0-9-]*$` on the relevant identifier.

**Tech Stack:** Node 20, TypeScript, vitest. New code under `server/src/memory/consolidated/` and tested under `server/test/memory/`. Wires through `server/src/tools/cog.ts` RPC dispatcher.

**Worktree:** `/tmp/cog-cleanup-rpcs`

**Branch:** `feat/cog-cleanup-rpcs`

**Closure:** No issue closure on this PR — pure infrastructure for PR-3 (skill rewrite). PR body must say: "Infrastructure for #200, #201, #206 — closed by skill rewrite in follow-up PR."

---

## Baseline

Recorded before any task: `bash scripts/gate.sh` PASSES (server tests 158/158, web tests 158/158, lint + typecheck clean). Recorded from this worktree at 2026-06-15 against base commit `20410ba` (`docs: add design doc for cog cleanup`).

Every task ends with a gate re-run; "no regressions" means against this baseline.

---

## Task 1: Type definitions for the two new RPCs

**Files:**
- Modify: `server/src/memory/types.ts` (add 4 interfaces at the bottom of the file's "param/result types" cluster)

### Step 1: Append the type definitions

Add to the end of `server/src/memory/types.ts`:

```ts
/** Parameters for the `init_canonical_file` RPC. */
export interface InitCanonicalFileParams {
  path: string;
  file_type: "hot-memory" | "observations" | "action-items" | "dev-log" | "generic";
  label: string;
}

/** Result of the `init_canonical_file` RPC. */
export interface InitCanonicalFileResult {
  created: boolean;
  path: string;
  bytes: number;
}

/** Parameters for the `skill_write` RPC. */
export interface SkillWriteParams {
  id: string;
  description: string;
  triggers: string[];
  body: string;
}

/** Result of the `skill_write` RPC. */
export interface SkillWriteResult {
  path: string;
  bytes: number;
}
```

### Step 2: Verify typecheck

Run: `cd server && npm run typecheck`
Expected: PASS (these are unused types added; no consumers yet).

### Step 3: Commit

```bash
cd /tmp/cog-cleanup-rpcs
git add server/src/memory/types.ts
git commit -m "types: add InitCanonicalFile/SkillWrite param + result interfaces"
```

---

## Task 2: `init_canonical_file` implementation

**Files:**
- Create: `server/src/memory/consolidated/init-canonical-file.ts`
- Modify: `server/src/memory/consolidated/index.ts` (export the new function)
- Modify: `server/src/memory/index.ts` (re-export from the top-level memory module)

### Step 1: Write the failing test (before any implementation)

Create `server/test/memory/init-canonical-file.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initCanonicalFile } from "../../src/memory/index.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ytsejam-init-canonical-"));
  process.env.YTSEJAM_MEMORY_DIR = root;
  await writeFile(join(root, "domains.yml"), `version: 1
domains:
  - id: intuneme
    path: projects/intuneme
    label: "intuneme — test"
    files: [hot-memory, observations, action-items, dev-log]
`, "utf8");
});
afterEach(async () => {
  delete process.env.YTSEJAM_MEMORY_DIR;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("init_canonical_file", () => {
  test("creates hot-memory with standard template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe("projects/intuneme/hot-memory.md");
    expect(result.bytes).toBeGreaterThan(0);
    const content = await readFile(join(root, "projects/intuneme/hot-memory.md"), "utf8");
    expect(content).toContain("<!-- L0: Current state and top-of-mind for intuneme -->");
    expect(content).toContain("# intuneme — Hot Memory");
    expect(content).toContain("<!-- Rewrite freely. Keep under 50 lines. -->");
  });

  test("creates observations with standard template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/observations.md",
      file_type: "observations",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/observations.md"), "utf8");
    expect(content).toContain("<!-- L0: Timestamped observations and events for intuneme -->");
    expect(content).toContain("# intuneme — Observations");
    expect(content).toContain("Format: - YYYY-MM-DD [tags]: observation");
  });

  test("creates action-items with Open and Completed sections", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/action-items.md",
      file_type: "action-items",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/action-items.md"), "utf8");
    expect(content).toContain("<!-- L0: Open and completed tasks for intuneme -->");
    expect(content).toContain("# intuneme — Action Items");
    expect(content).toContain("## Open");
    expect(content).toContain("## Completed");
  });

  test("creates dev-log with standard template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/dev-log.md",
      file_type: "dev-log",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/dev-log.md"), "utf8");
    expect(content).toContain("<!-- L0: Development log and architectural decisions for intuneme -->");
    expect(content).toContain("# intuneme — Dev Log");
  });

  test("creates generic file with basename-title-cased header", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/entities.md",
      file_type: "generic",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/entities.md"), "utf8");
    expect(content).toContain("<!-- L0: Entities for intuneme -->");
    expect(content).toContain("# intuneme — Entities");
  });

  test("title-cases multi-segment basenames in generic template", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "generic",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/hot-memory.md"), "utf8");
    expect(content).toContain("# intuneme — Hot Memory");
  });

  test("returns created:false when file already exists (idempotent)", async () => {
    const first = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    });
    expect(first.created).toBe(true);
    const beforeBytes = first.bytes;

    const second = await initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    });
    expect(second.created).toBe(false);
    expect(second.bytes).toBe(0);

    // File content unchanged
    const content = await readFile(join(root, "projects/intuneme/hot-memory.md"), "utf8");
    expect(content.length).toBe(beforeBytes);
  });

  test("rejects paths not under any registered domain", async () => {
    await expect(initCanonicalFile({
      path: "personal/observations.md",
      file_type: "observations",
      label: "personal",
    })).rejects.toThrow(/not under any registered domain/);
  });

  test("rejects basename with underscore (slug rule)", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/hot_memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    })).rejects.toThrow(/basename .* must match/);
  });

  test("rejects basename with capital letter (slug rule)", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/Hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    })).rejects.toThrow(/basename .* must match/);
  });

  test("rejects basename with space (slug rule)", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/hot memory.md",
      file_type: "hot-memory",
      label: "intuneme",
    })).rejects.toThrow(/basename .* must match/);
  });

  test("rejects unknown param keys", async () => {
    await expect(initCanonicalFile({
      path: "projects/intuneme/hot-memory.md",
      file_type: "hot-memory",
      label: "intuneme",
      extra: "nope",
    } as unknown as never)).rejects.toThrow(/unknown param key/);
  });

  test("defaults to generic template when file_type is unrecognized", async () => {
    const result = await initCanonicalFile({
      path: "projects/intuneme/entities.md",
      file_type: "some-unknown-type" as unknown as "generic",
      label: "intuneme",
    });
    expect(result.created).toBe(true);
    const content = await readFile(join(root, "projects/intuneme/entities.md"), "utf8");
    expect(content).toContain("# intuneme — Entities");
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/memory/init-canonical-file.test.ts`
Expected: FAIL — module `initCanonicalFile` not exported from `../../src/memory/index.ts`.

### Step 3: Write the implementation

Create `server/src/memory/consolidated/init-canonical-file.ts`:

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { InitCanonicalFileParams, InitCanonicalFileResult } from "../types.ts";
import { resolveMemoryPath } from "../store/paths.ts";
import { controller } from "./common.ts";
import { validateParams } from "./params.ts";

const BASENAME_RULE = /^[a-z][a-z0-9-]*$/;

type FileType = "hot-memory" | "observations" | "action-items" | "dev-log" | "generic";

const TEMPLATES: Record<Exclude<FileType, "generic">, (label: string) => string> = {
  "hot-memory": (label) =>
    `<!-- L0: Current state and top-of-mind for ${label} -->
# ${label} — Hot Memory

<!-- Rewrite freely. Keep under 50 lines. -->
`,
  "observations": (label) =>
    `<!-- L0: Timestamped observations and events for ${label} -->
# ${label} — Observations

<!-- Append-only. Format: - YYYY-MM-DD [tags]: observation -->
`,
  "action-items": (label) =>
    `<!-- L0: Open and completed tasks for ${label} -->
# ${label} — Action Items

## Open

## Completed
`,
  "dev-log": (label) =>
    `<!-- L0: Development log and architectural decisions for ${label} -->
# ${label} — Dev Log

<!-- Append entries with date headers. Use for ADR-style decisions, design notes, and post-mortems. -->
`,
};

function titleCase(slug: string): string {
  return slug.split("-").map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1)).join(" ");
}

function genericTemplate(label: string, basename: string): string {
  const title = titleCase(basename);
  return `<!-- L0: ${title} for ${label} -->
# ${label} — ${title}
`;
}

function pickTemplate(fileType: string, label: string, basename: string): string {
  if (fileType === "generic") return genericTemplate(label, basename);
  const builder = TEMPLATES[fileType as Exclude<FileType, "generic">];
  if (builder) return builder(label);
  // Unknown file_type falls back to generic.
  return genericTemplate(label, basename);
}

function isPathUnderRegisteredDomain(rel: string): boolean {
  const c = controller();
  const allPaths: string[] = [];
  const walk = (entries: ReturnType<typeof c.list>): void => {
    for (const d of entries) {
      allPaths.push(d.path);
      if (d.subdomains) walk(d.subdomains);
    }
  };
  walk(c.list());
  return allPaths.some((dp) => rel === dp || rel.startsWith(dp + "/"));
}

export async function initCanonicalFile(
  params: InitCanonicalFileParams,
): Promise<InitCanonicalFileResult> {
  validateParams(params as Record<string, unknown>, ["path", "file_type", "label"]);
  if (typeof params.path !== "string" || !params.path) {
    throw new Error("init_canonical_file: path is required");
  }
  if (typeof params.label !== "string" || !params.label) {
    throw new Error("init_canonical_file: label is required");
  }

  const { abs, rel } = await resolveMemoryPath(params.path);

  if (!isPathUnderRegisteredDomain(rel)) {
    throw new Error(`init_canonical_file: path "${rel}" not under any registered domain`);
  }

  const basename = path.basename(rel, ".md");
  if (!BASENAME_RULE.test(basename)) {
    throw new Error(`init_canonical_file: basename "${basename}" must match [a-z][a-z0-9-]*`);
  }

  if (existsSync(abs)) {
    return { created: false, path: rel, bytes: 0 };
  }

  const content = pickTemplate(params.file_type, params.label, basename);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");

  return { created: true, path: rel, bytes: Buffer.byteLength(content) };
}
```

### Step 4: Wire the export

Modify `server/src/memory/consolidated/index.ts` — add at the end:

```ts
export { initCanonicalFile } from "./init-canonical-file.ts";
```

Modify `server/src/memory/index.ts` — find the section that re-exports consolidated members (search for `export { sessionBrief`) and add `initCanonicalFile` to it. Also re-export the types:

```ts
export type { InitCanonicalFileParams, InitCanonicalFileResult } from "./types.ts";
```

### Step 5: Run test to verify it passes

Run: `cd server && npx vitest run test/memory/init-canonical-file.test.ts`
Expected: PASS — all 13 tests green.

### Step 6: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests +13 vs baseline (158 → 171).

### Step 7: Commit

```bash
cd /tmp/cog-cleanup-rpcs
git add server/src/memory/consolidated/init-canonical-file.ts \
        server/src/memory/consolidated/index.ts \
        server/src/memory/index.ts \
        server/test/memory/init-canonical-file.test.ts
git commit -m "feat(memory): add init_canonical_file consolidated RPC"
```

---

## Task 3: `skill_write` implementation

**Files:**
- Create: `server/src/memory/consolidated/skill-write.ts`
- Modify: `server/src/memory/consolidated/index.ts` (export)
- Modify: `server/src/memory/index.ts` (re-export)
- Create: `server/test/memory/skill-write.test.ts`

### Step 1: Write the failing test

Create `server/test/memory/skill-write.test.ts`:

```ts
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { skillWrite } from "../../src/memory/index.ts";

let dataDir = "";
let savedDataDir: string | undefined;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ytsejam-skill-write-"));
  savedDataDir = process.env.YTSEJAM_DATA_DIR;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  await mkdir(join(dataDir, "skills"), { recursive: true });
});
afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
  else process.env.YTSEJAM_DATA_DIR = savedDataDir;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("skill_write", () => {
  test("writes skill file with valid frontmatter and body", async () => {
    const result = await skillWrite({
      id: "intuneme",
      description: "intuneme — test routing skill",
      triggers: ["intune", "intuneme"],
      body: "Use this skill for intuneme work.\n",
    });
    expect(result.path).toBe(join(dataDir, "skills", "intuneme.md"));
    expect(result.bytes).toBeGreaterThan(0);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("---\n");
    expect(content).toContain("name: intuneme\n");
    expect(content).toContain("description: intuneme — test routing skill\n");
    expect(content).toContain("triggers: [intune, intuneme]\n");
    expect(content).toContain("Use this skill for intuneme work.");
  });

  test("emits triggers as inline YAML array", async () => {
    const result = await skillWrite({
      id: "demo",
      description: "demo",
      triggers: ["a", "b", "c"],
      body: "body",
    });
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("triggers: [a, b, c]\n");
  });

  test("overwrites an existing skill file", async () => {
    await skillWrite({
      id: "demo",
      description: "first",
      triggers: ["demo"],
      body: "first body",
    });
    const second = await skillWrite({
      id: "demo",
      description: "second",
      triggers: ["demo"],
      body: "second body",
    });
    const content = await readFile(second.path, "utf8");
    expect(content).toContain("description: second\n");
    expect(content).toContain("second body");
    expect(content).not.toContain("first body");
  });

  test("rejects id slug with underscore", async () => {
    await expect(skillWrite({
      id: "demo_skill",
      description: "x",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/id .* must match/);
  });

  test("rejects id slug with capital letter", async () => {
    await expect(skillWrite({
      id: "Demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/id .* must match/);
  });

  test("rejects id slug starting with digit", async () => {
    await expect(skillWrite({
      id: "1demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/id .* must match/);
  });

  test("rejects empty triggers array", async () => {
    await expect(skillWrite({
      id: "demo",
      description: "x",
      triggers: [],
      body: "body",
    })).rejects.toThrow(/triggers must be non-empty/);
  });

  test("rejects empty description", async () => {
    await expect(skillWrite({
      id: "demo",
      description: "",
      triggers: ["demo"],
      body: "body",
    })).rejects.toThrow(/description is required/);
  });

  test("resolves path via YTSEJAM_DATA_DIR override", async () => {
    // beforeEach already set YTSEJAM_DATA_DIR; verify the written path uses it
    const result = await skillWrite({
      id: "demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
    });
    expect(result.path.startsWith(dataDir)).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  test("rejects unknown param keys", async () => {
    await expect(skillWrite({
      id: "demo",
      description: "x",
      triggers: ["demo"],
      body: "body",
      extra: "no",
    } as unknown as never)).rejects.toThrow(/unknown param key/);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd server && npx vitest run test/memory/skill-write.test.ts`
Expected: FAIL — `skillWrite` not exported.

### Step 3: Write the implementation

Create `server/src/memory/consolidated/skill-write.ts`:

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SkillWriteParams, SkillWriteResult } from "../types.ts";
import { validateParams } from "./params.ts";

const ID_RULE = /^[a-z][a-z0-9-]*$/;

function resolveDataDir(): string {
  const explicit = process.env.YTSEJAM_DATA_DIR;
  if (explicit) {
    if (explicit === "~" || explicit.startsWith("~/")) {
      return path.join(homedir(), explicit.slice(2));
    }
    return path.resolve(explicit);
  }
  return path.join(homedir(), ".ytsejam", "data");
}

function renderSkillFile(p: SkillWriteParams): string {
  const triggers = p.triggers.join(", ");
  // Trim trailing newlines from body, then add exactly one final newline.
  const body = p.body.replace(/\n+$/, "");
  return `---
name: ${p.id}
description: ${p.description}
triggers: [${triggers}]
---

${body}
`;
}

export async function skillWrite(params: SkillWriteParams): Promise<SkillWriteResult> {
  validateParams(params as Record<string, unknown>, ["id", "description", "triggers", "body"]);

  if (typeof params.id !== "string" || !ID_RULE.test(params.id)) {
    throw new Error(`skill_write: id "${params.id}" must match [a-z][a-z0-9-]*`);
  }
  if (typeof params.description !== "string" || !params.description) {
    throw new Error("skill_write: description is required");
  }
  if (!Array.isArray(params.triggers) || params.triggers.length === 0) {
    throw new Error("skill_write: triggers must be non-empty");
  }
  if (params.triggers.some((t) => typeof t !== "string" || !t)) {
    throw new Error("skill_write: every trigger must be a non-empty string");
  }
  if (typeof params.body !== "string") {
    throw new Error("skill_write: body must be a string");
  }

  const skillsDir = path.join(resolveDataDir(), "skills");
  const abs = path.join(skillsDir, `${params.id}.md`);
  const content = renderSkillFile(params);

  await mkdir(skillsDir, { recursive: true });
  await writeFile(abs, content, "utf8");

  return { path: abs, bytes: Buffer.byteLength(content) };
}
```

### Step 4: Wire the exports

In `server/src/memory/consolidated/index.ts` add:

```ts
export { skillWrite } from "./skill-write.ts";
```

In `server/src/memory/index.ts` add `skillWrite` to the consolidated re-exports and add:

```ts
export type { SkillWriteParams, SkillWriteResult } from "./types.ts";
```

### Step 5: Run test to verify it passes

Run: `cd server && npx vitest run test/memory/skill-write.test.ts`
Expected: PASS — 10 tests green.

### Step 6: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests +10 vs prior task (171 → 181).

### Step 7: Commit

```bash
cd /tmp/cog-cleanup-rpcs
git add server/src/memory/consolidated/skill-write.ts \
        server/src/memory/consolidated/index.ts \
        server/src/memory/index.ts \
        server/test/memory/skill-write.test.ts
git commit -m "feat(memory): add skill_write consolidated RPC"
```

---

## Task 4: Wire both new RPCs into the `cog_rpc` dispatcher

**Files:**
- Modify: `server/src/tools/cog.ts` (add two entries to `RPC_METHODS` array and `rpcDispatch` map)

### Step 1: Write the failing test

Create `server/test/cog-rpc-dispatch.test.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let memoryDir = "";
let dataDir = "";
let savedMemoryDir: string | undefined;
let savedDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ytsejam-cog-rpc-data-"));
  memoryDir = join(dataDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(join(dataDir, "skills"), { recursive: true });
  savedMemoryDir = process.env.YTSEJAM_MEMORY_DIR;
  savedDataDir = process.env.YTSEJAM_DATA_DIR;
  process.env.YTSEJAM_MEMORY_DIR = memoryDir;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  await writeFile(join(memoryDir, "domains.yml"), `version: 1
domains:
  - id: demo
    path: projects/demo
    label: "demo project"
    files: [hot-memory, observations]
`, "utf8");
});
afterEach(async () => {
  if (savedMemoryDir === undefined) delete process.env.YTSEJAM_MEMORY_DIR;
  else process.env.YTSEJAM_MEMORY_DIR = savedMemoryDir;
  if (savedDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
  else process.env.YTSEJAM_DATA_DIR = savedDataDir;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("cog_rpc dispatch — new methods", () => {
  test("init_canonical_file is dispatched through cog_rpc", async () => {
    const { cogTools } = await import("../src/tools/cog.ts");
    const rpc = cogTools.find((t) => t.name === "cog_rpc");
    expect(rpc).toBeDefined();
    const result = await rpc!.run({
      method: "init_canonical_file",
      params: {
        path: "projects/demo/hot-memory.md",
        file_type: "hot-memory",
        label: "demo",
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.created).toBe(true);
    expect(parsed.path).toBe("projects/demo/hot-memory.md");
    const content = await readFile(join(memoryDir, "projects/demo/hot-memory.md"), "utf8");
    expect(content).toContain("# demo — Hot Memory");
  });

  test("skill_write is dispatched through cog_rpc", async () => {
    const { cogTools } = await import("../src/tools/cog.ts");
    const rpc = cogTools.find((t) => t.name === "cog_rpc");
    expect(rpc).toBeDefined();
    const result = await rpc!.run({
      method: "skill_write",
      params: {
        id: "demo",
        description: "demo skill",
        triggers: ["demo"],
        body: "Use this skill.\n",
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.path).toBe(join(dataDir, "skills", "demo.md"));
    const content = await readFile(parsed.path, "utf8");
    expect(content).toContain("name: demo");
  });

  test("unknown method still rejected", async () => {
    const { cogTools } = await import("../src/tools/cog.ts");
    const rpc = cogTools.find((t) => t.name === "cog_rpc");
    await expect(rpc!.run({
      method: "not_a_method",
      params: {},
    })).rejects.toThrow(/unknown cog_rpc method/);
  });
});
```

### Step 2: Inspect the test target

Before writing the test, the implementer must read `server/src/tools/cog.ts` to confirm:
- The exact export name (`cogTools` array vs individual tool) so the test can import it correctly.
- The `cog_rpc` tool's `run` signature (`{method, params}`).
- The JSON-stringify convention on the return value.

If the test's import or `run` signature is wrong, adjust the test (not the production code) before implementing. The shapes above are inferred from `head -80 server/src/tools/cog.ts`; verify and correct if needed.

### Step 3: Run test to verify it fails

Run: `cd server && npx vitest run test/cog-rpc-dispatch.test.ts`
Expected: FAIL — first two tests fail with `unknown cog_rpc method: init_canonical_file` and `unknown cog_rpc method: skill_write`.

### Step 4: Wire the two new methods

In `server/src/tools/cog.ts`:

1. Import the two new functions and types at the top alongside existing memory imports:

```ts
import type {
  DomainSummaryParams,
  GitParams,
  InitCanonicalFileParams,
  SkillWriteParams,
} from "../memory/index.ts";
```

2. Add `"init_canonical_file"` and `"skill_write"` to the `RPC_METHODS` tuple (preserve the existing order; add at the end before `"reconcile_now"` if that's the tail, or wherever the existing list groups admin-style operations).

3. Add dispatch entries to `rpcDispatch`:

```ts
"init_canonical_file": (params) =>
  memory.initCanonicalFile(params as unknown as InitCanonicalFileParams),
"skill_write": (params) =>
  memory.skillWrite(params as unknown as SkillWriteParams),
```

4. The existing `validateParams` inside each RPC method body handles unknown-key rejection. No additional wiring needed.

### Step 5: Run test to verify it passes

Run: `cd server && npx vitest run test/cog-rpc-dispatch.test.ts`
Expected: PASS — 3 tests green.

### Step 6: Run the gate

Run: `bash scripts/gate.sh`
Expected: PASS, server tests +3 vs prior task (181 → 184).

### Step 7: Commit

```bash
cd /tmp/cog-cleanup-rpcs
git add server/src/tools/cog.ts server/test/cog-rpc-dispatch.test.ts
git commit -m "feat(cog): wire init_canonical_file + skill_write into cog_rpc dispatcher"
```

---

## Task 5: Pre-PR sweep

### Step 1: Confirm full gate green

Run: `bash scripts/gate.sh`
Expected: PASS — server tests 184 (baseline 158 + 26 new), web tests 158 (unchanged), lint + typecheck clean.

### Step 2: Confirm no scope creep

Run: `git diff --stat main..HEAD`
Expected: only the following files touched:
- `server/src/memory/types.ts`
- `server/src/memory/consolidated/init-canonical-file.ts` (new)
- `server/src/memory/consolidated/skill-write.ts` (new)
- `server/src/memory/consolidated/index.ts`
- `server/src/memory/index.ts`
- `server/src/tools/cog.ts`
- `server/test/memory/init-canonical-file.test.ts` (new)
- `server/test/memory/skill-write.test.ts` (new)
- `server/test/cog-rpc-dispatch.test.ts` (new)

If any other file is in the diff, investigate before opening the PR.

### Step 3: Check rebase status against origin/main

Run: `git fetch origin main && git log origin/main..HEAD --oneline`
Expected: only the commits from Tasks 1-4. If `origin/main` has advanced since the worktree was created, rebase: `git rebase origin/main` and re-run the gate.

### Step 4: Confirm no narration of "Tested" claims unsupported by the gate

Re-read each commit message. Confirm none claims a behavior beyond what the test suite exercises.

### Step 5: Hand back to `/ship`

The plan ends here. `/ship` (run by the calling skill or by Brian) handles push + PR open + merge.

---

## Gate baseline reference

Recorded on this worktree at start: server tests 158 pass, web tests 158 pass, lint + typecheck clean. Final expected: server tests 184 pass (+26 new), web tests 158 pass (unchanged), lint + typecheck clean.

## Out of scope for this PR

- Validate-on-write for `domains.yml` → PR-2
- Routing-RPC error surface change → PR-2
- `/cog` skill rewrite → PR-3

No file under `~/.ytsejam/data/skills/` is modified by this PR (the new `skill_write` RPC is the affordance; the skill that USES it ships in PR-3).
