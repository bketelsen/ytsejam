# Slash-Command Completion Overlay — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a slash-command completion overlay to the chat composer: typing `/` at the start of an empty draft opens a filterable menu of available skills; selecting one inserts `/<name> ` into the textarea. No client-side dispatch — the LLM still routes via the existing system-prompt Skills table.

**Spec:** `docs/plans/2026-06-14-slash-completion-design.md`

**Architecture:** Thin server route exposing the existing `SkillsStore.list()` over HTTP; a hand-rolled React overlay positioned above the existing `Textarea`, driven by a pure derivation function (`slashMenu.ts`, behaviorally tested) wrapped in a thin React hook (`useSlashMenu.ts`, source-grep tested). No new dependencies. Server change is one route + one prop on `AppDeps`; client change is three new files + targeted edits in `Chat.tsx`, `lib/api.ts`, `lib/types.ts`. Web tests use the project's existing `node:test`/`.mjs` convention — no vitest, no React renderer. End-to-end keystroke behavior is covered by Task 6's manual smoke checklist.

**Tech Stack:** TypeScript, Hono (server), React + Tailwind (client), vitest (both sides).

**Worktree:** /tmp/slash-completion

**Branch:** feature/slash-completion

---

## Task 1: Server — expose SkillsStore on AppDeps and add `GET /api/skills`

**Files:**
- Modify: `server/src/server.ts` (extend `AppDeps`, add route)
- Modify: `server/src/index.ts` (pass existing `skills` instance into `createApp`)
- Create: `server/test/skills-api.test.ts`

### Step 1: Write the failing test

Create `server/test/skills-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/server.ts";
import { SkillsStore } from "../src/skills.ts";

async function seed(skillsDir: string): Promise<void> {
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, "alpha.md"),
    "---\nname: alpha\ndescription: First skill\ntriggers: [a, alpha, first]\n---\nbody\n",
  );
  await fs.writeFile(
    path.join(skillsDir, "beta.md"),
    "---\nname: beta\ndescription: Second skill\ntriggers: [b, beta]\n---\nbody\n",
  );
}

function fakeDeps(skillsStore?: SkillsStore) {
  // Minimal stubs — createApp only needs these surfaces alive enough to
  // register without throwing. The /api/skills route doesn't touch them.
  const noop = async () => {};
  return {
    manager: {} as any,
    taskManager: { list: () => [] } as any,
    scheduler: { listSchedules: () => [] } as any,
    indexer: {
      listSessions: () => [],
      listTasks: () => [],
      listSchedules: () => [],
    } as any,
    bus: { subscribe: () => () => {}, publish: noop } as any,
    persona: { load: async () => "" } as any,
    config: {
      authToken: "test-token",
      dataDir: "/tmp/unused",
      defaultModel: { provider: "x", modelId: "y" },
    } as any,
    authStore: {} as any,
    skills: skillsStore,
  };
}

async function getJson(app: Hono, path: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { headers });
  const body = res.status === 200 ? await res.json() : null;
  return { status: res.status, body };
}

describe("GET /api/skills", () => {
  it("returns the list from the injected SkillsStore", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytsejam-skills-api-"));
    await seed(path.join(dir, "skills"));
    const store = new SkillsStore(path.join(dir, "skills"));
    const { app } = createApp(fakeDeps(store));
    const { status, body } = await getJson(app, "/api/skills", "test-token");
    expect(status).toBe(200);
    expect(body.skills).toHaveLength(2);
    const names = body.skills.map((s: any) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    const alpha = body.skills.find((s: any) => s.name === "alpha");
    expect(alpha.description).toBe("First skill");
    expect(alpha.triggers).toEqual(["a", "alpha", "first"]);
  });

  it("returns 401 without a bearer token", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytsejam-skills-api-"));
    await seed(path.join(dir, "skills"));
    const store = new SkillsStore(path.join(dir, "skills"));
    const { app } = createApp(fakeDeps(store));
    const { status } = await getJson(app, "/api/skills");
    expect(status).toBe(401);
  });

  it("returns an empty array when no SkillsStore was injected", async () => {
    const { app } = createApp(fakeDeps(undefined));
    const { status, body } = await getJson(app, "/api/skills", "test-token");
    expect(status).toBe(200);
    expect(body.skills).toEqual([]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace server -- skills-api 2>&1 | tail -20
```

Expected: FAIL with `/api/skills` route not found (likely a 404 turning into a body parse error, OR `createApp` rejecting the new `skills` prop on `AppDeps` if vitest is strict about it). Either failure mode is acceptable.

### Step 3: Extend AppDeps in `server/src/server.ts`

Find the `AppDeps` interface (around line 18–28) and add the optional `skills` field next to `workdirs`:

```ts
  /** Optional: when supplied, exposes POST /api/sessions/:id/cwd. */
  workdirs?: WorkdirStore;
  /** Optional: when supplied, exposes GET /api/skills. */
  skills?: SkillsStore;
}
```

Add the import at the top of the file:

```ts
import type { SkillsStore } from "./skills.ts";
```

### Step 4: Add the route

In `server/src/server.ts`, find a clean spot among the GET routes (after `/api/persona` or `/api/models` looks natural). Add:

```ts
  app.get("/api/skills", async (c) => {
    const skills = deps.skills ? await deps.skills.list() : [];
    return c.json({ skills });
  });
```

Auth: confirm the file's existing bearer-token middleware covers `/api/*` paths (it does — every `/api/*` route except `/api/login` is behind the middleware). The new route inherits the same protection automatically; no extra wiring needed. If the test in Step 1 sees 200-without-token, audit the middleware — DON'T paper over it in the route.

### Step 5: Wire the existing skills instance into createApp in `server/src/index.ts`

Find the call (around line 211):

```ts
const { app, injectWebSocket } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs });
```

Add `skills`:

```ts
const { app, injectWebSocket } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs, skills });
```

(The `skills` const is already declared earlier at line 47.)

### Step 6: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace server -- skills-api 2>&1 | tail -20
```

Expected: all 3 tests PASS.

### Step 7: Run the full server suite to confirm no regression

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm run check && env -u NODE_ENV npm test --workspace server 2>&1 | tail -10
```

Expected: typecheck passes, full server suite passes (existing skill tests + new ones).

### Step 8: Commit

```bash
git add server/src/server.ts server/src/index.ts server/test/skills-api.test.ts
git commit -m "feat(server): expose GET /api/skills from SkillsStore"
```

---

## Task 2: Client — types and API client method

**Files:**
- Modify: `web/src/lib/types.ts` (add `SkillSummary`)
- Modify: `web/src/lib/api.ts` (add `listSkills`)
- Create: `web/test/api-skills.test.mjs`
- Modify: `web/test/run.mjs` (register the new test)

> **Test framework note:** `web/` uses `node:test` with `.mjs` files registered in `web/test/run.mjs`. There is NO vitest, no `@testing-library/react`. Tests are either source-grep contract tests (read the source file, regex-assert structural facts) OR pure-logic behavior tests (direct `.ts` import via Node's built-in TS-strip, exercise the function). All Task 2–5 tests follow that convention.

### Step 1: Write the failing test

Create `web/test/api-skills.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;

const apiSrc = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const typesSrc = readFileSync(join(root, "src/lib/types.ts"), "utf8");

test("types.ts exports the SkillSummary interface with name/description/triggers", () => {
  assert.match(typesSrc, /export\s+interface\s+SkillSummary\b/);
  // All three fields present in the interface body.
  const body = typesSrc.match(/export\s+interface\s+SkillSummary\s*\{([\s\S]*?)\}/);
  assert.ok(body, "could not locate SkillSummary interface body");
  assert.match(body[1], /\bname\s*:\s*string\b/);
  assert.match(body[1], /\bdescription\s*:\s*string\b/);
  assert.match(body[1], /\btriggers\s*:\s*string\[\]/);
});

test("api.ts imports SkillSummary from ./types", () => {
  assert.match(
    apiSrc,
    /import\s+type\s*\{[^}]*\bSkillSummary\b[^}]*\}\s*from\s*["']\.\/types["']/,
  );
});

test("client.listSkills calls /api/skills via the shared api() helper", () => {
  // Use the centralized api<T>() helper so bearer auth + 401 handling is uniform.
  assert.match(
    apiSrc,
    /listSkills\s*:\s*\(\)\s*=>\s*api<\{\s*skills\s*:\s*SkillSummary\[\]\s*\}>\(\s*["']\/api\/skills["']\s*\)/,
  );
});
```

### Step 2: Register the test in `web/test/run.mjs`

`run.mjs` is an explicit registry (the node:test runner imports it as the entry point). Append the new import at the end of the existing list:

```js
import "./api-skills.test.mjs";
```

### Step 3: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -10
```

Expected: FAIL with assertions failing on `SkillSummary` not exported / `listSkills` not present / import missing.

### Step 4: Add the `SkillSummary` type

In `web/src/lib/types.ts`, add (alongside the other exported interfaces):

```ts
export interface SkillSummary {
  name: string;
  description: string;
  triggers: string[];
}
```

### Step 5: Add the `listSkills` client method

In `web/src/lib/api.ts`:

1. Add `SkillSummary` to the existing type import from `./types`:
   ```ts
   import type { ChatMessage, LtmHealth, ModelInfo, ScheduleRow, SessionRow, SkillSummary, TaskRow } from "./types";
   ```
2. Add the method near `listSchedules` / `listTasks` (keep alphabetical-ish grouping):
   ```ts
   listSkills: () => api<{ skills: SkillSummary[] }>("/api/skills"),
   ```

### Step 6: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -10
```

Expected: full web suite green, the three new asserts among them.

### Step 7: Commit

```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/test/api-skills.test.mjs web/test/run.mjs
git commit -m "feat(web): add SkillSummary type + client.listSkills"
```

---

## Task 3: Client — `useSlashMenu` hook (pure derivation extracted)

**Files:**
- Create: `web/src/components/slashMenu.ts` (PURE derivation — no React)
- Create: `web/src/components/useSlashMenu.ts` (thin React wrapper)
- Create: `web/test/slash-menu.test.mjs`

> **Why split:** React hooks can't be invoked outside a renderer, and `web/` has no `@testing-library/react`. The fix is to keep the derivation pure and importable as plain TS — the hook becomes a thin `useState`+`useMemo`+`useEffect` wrapper that source-grep tests can verify structurally, while the rank/filter logic gets exercised behaviorally.

### Step 1: Write the failing test

Create `web/test/slash-menu.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

// Pure-derivation behavior tests — direct .ts import (Node 22+ strips types).
const { slashMenuState, acceptSlash } = await import(
  "../src/components/slashMenu.ts"
);

const SKILLS = [
  { name: "reflect", description: "Reflect", triggers: ["reflect", "memory", "consolidate"] },
  { name: "ship", description: "Ship", triggers: ["ship", "ship it"] },
  { name: "review", description: "Review", triggers: ["review", "code review"] },
  { name: "housekeeping", description: "HK", triggers: ["housekeeping", "memory", "archive"] },
];

test("slashMenuState: empty draft → closed", () => {
  const s = slashMenuState("", SKILLS);
  assert.equal(s.open, false);
  assert.deepEqual(s.items, []);
});

test("slashMenuState: draft without leading / → closed", () => {
  const s = slashMenuState("hello", SKILLS);
  assert.equal(s.open, false);
});

test("slashMenuState: bare '/' opens with all skills alphabetically", () => {
  const s = slashMenuState("/", SKILLS);
  assert.equal(s.open, true);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["housekeeping", "reflect", "review", "ship"],
  );
  // bare "/" rows have reason: "all"
  assert.ok(s.items.every((i) => i.reason === "all"));
});

test("slashMenuState: name-prefix ranks above trigger-substring", () => {
  const s = slashMenuState("/re", SKILLS);
  // name-prefix: reflect, review (both start with "re"); no trigger-only matches for "re"
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["reflect", "review"],
  );
  assert.ok(s.items.every((i) => i.reason === "name"));
});

test("slashMenuState: trigger-substring matches surfaced with reason + matchedTrigger", () => {
  const s = slashMenuState("/memory", SKILLS);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["housekeeping", "reflect"],
  );
  assert.ok(s.items.every((i) => i.reason === "trigger"));
  assert.ok(s.items.every((i) => i.matchedTrigger === "memory"));
});

test("slashMenuState: case-insensitive (multi-match)", () => {
  // /RE matches both reflect and review by name-prefix, same as /re.
  const upper = slashMenuState("/RE", SKILLS);
  const lower = slashMenuState("/re", SKILLS);
  assert.deepEqual(
    upper.items.map((i) => i.skill.name),
    ["reflect", "review"],
  );
  // And the upper-case result equals the lower-case one — proves the toLowerCase
  // happens BOTH on the query AND on the comparison side.
  assert.deepEqual(
    upper.items.map((i) => i.skill.name),
    lower.items.map((i) => i.skill.name),
  );
});

test("slashMenuState: case-insensitive (single-match)", () => {
  // /REF only matches reflect — review does NOT start with "ref" in any case.
  const s = slashMenuState("/REF", SKILLS);
  assert.deepEqual(
    s.items.map((i) => i.skill.name),
    ["reflect"],
  );
});

test("slashMenuState: whitespace in draft closes the menu", () => {
  assert.equal(slashMenuState("/ref hello", SKILLS).open, false);
});

test("slashMenuState: newline in draft closes the menu", () => {
  assert.equal(slashMenuState("/ref\n", SKILLS).open, false);
});

test("acceptSlash: returns '/<name> ' (trailing space)", () => {
  assert.equal(acceptSlash("reflect"), "/reflect ");
});

// Source-inspection: the React wrapper exists and uses the pure derivation.
const hookSrc = readFileSync(
  join(root, "src/components/useSlashMenu.ts"),
  "utf8",
);

test("useSlashMenu wrapper imports the pure derivation from ./slashMenu", () => {
  assert.match(
    hookSrc,
    /import\s*\{[^}]*\bslashMenuState\b[^}]*\}\s*from\s*["']\.\/slashMenu["']/,
  );
});

test("useSlashMenu wrapper manages activeIndex with useState", () => {
  assert.match(hookSrc, /useState<number>\(0\)|useState\(0\)/);
});

test("useSlashMenu wrapper clamps activeIndex when items shrink", () => {
  // The clamp lives in a useEffect that watches items.length.
  assert.match(hookSrc, /useEffect\(/);
  assert.match(hookSrc, /items\.length/);
});
```

### Step 2: Register the test in `web/test/run.mjs`

Append:

```js
import "./slash-menu.test.mjs";
```

### Step 3: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
```

Expected: FAIL — module `../src/components/slashMenu.ts` not found.

### Step 4: Create the pure derivation `web/src/components/slashMenu.ts`

```ts
import type { SkillSummary } from "../lib/types";

export type MatchReason = "name" | "trigger" | "all";

export interface RankedSkill {
  skill: SkillSummary;
  reason: MatchReason;
  /** Set when reason === "trigger". The first trigger that matched. */
  matchedTrigger?: string;
}

export interface SlashMenuState {
  open: boolean;
  items: RankedSkill[];
}

/**
 * Pure derivation of slash-menu state from the composer draft.
 *
 * Open contract: draft starts with "/" and contains no whitespace. The user
 * is in command-selection mode while typing the slash token; once they type
 * a space or newline the menu closes (whatever follows is the skill's
 * argument body, not a filter).
 */
export function slashMenuState(
  draft: string,
  skills: SkillSummary[],
): SlashMenuState {
  const open = draft.startsWith("/") && !/\s/.test(draft);
  if (!open) return { open: false, items: [] };
  const query = draft.slice(1).toLowerCase();
  if (query === "") {
    const items: RankedSkill[] = [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ skill: s, reason: "all" }));
    return { open: true, items };
  }
  const prefix: RankedSkill[] = [];
  const trigger: RankedSkill[] = [];
  for (const s of skills) {
    if (s.name.toLowerCase().startsWith(query)) {
      prefix.push({ skill: s, reason: "name" });
      continue;
    }
    const t = s.triggers.find((t) => t.toLowerCase().includes(query));
    if (t) trigger.push({ skill: s, reason: "trigger", matchedTrigger: t });
  }
  const byName = (a: RankedSkill, b: RankedSkill) =>
    a.skill.name.localeCompare(b.skill.name);
  return { open: true, items: [...prefix.sort(byName), ...trigger.sort(byName)] };
}

/** Build the new draft to commit when the user accepts a row. */
export function acceptSlash(name: string): string {
  return `/${name} `;
}
```

### Step 5: Create the React wrapper `web/src/components/useSlashMenu.ts`

```ts
import { useEffect, useMemo, useState } from "react";
import type { SkillSummary } from "../lib/types";
import {
  acceptSlash,
  slashMenuState,
  type RankedSkill,
  type SlashMenuState,
} from "./slashMenu";

export type { RankedSkill, SlashMenuState };

export interface UseSlashMenu extends SlashMenuState {
  activeIndex: number;
  setActiveIndex: (n: number) => void;
  /** Build the new draft to commit when the user accepts a row. */
  accept: (name: string) => string;
}

/**
 * React adapter over the pure slashMenuState derivation. Owns the
 * activeIndex state and clamps it when the items list shrinks (e.g. user
 * types another char that narrows the matches).
 */
export function useSlashMenu(
  draft: string,
  skills: SkillSummary[],
): UseSlashMenu {
  const state = useMemo(() => slashMenuState(draft, skills), [draft, skills]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  useEffect(() => {
    if (state.items.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex > state.items.length - 1) {
      setActiveIndex(state.items.length - 1);
    }
  }, [state.items.length, activeIndex]);
  return { ...state, activeIndex, setActiveIndex, accept: acceptSlash };
}
```

### Step 6: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
```

Expected: full web suite green.

### Step 7: Run typecheck + build

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm run check 2>&1 | tail -5
cd /tmp/slash-completion && env -u NODE_ENV npm run build --workspace web 2>&1 | tail -10
```

Expected: both green.

### Step 8: Commit

```bash
git add web/src/components/slashMenu.ts web/src/components/useSlashMenu.ts web/test/slash-menu.test.mjs web/test/run.mjs
git commit -m "feat(web): add slashMenu pure derivation + useSlashMenu hook"
```

---

## Task 4: Client — `SlashOverlay` presentational component

**Files:**
- Create: `web/src/components/SlashOverlay.tsx`
- Create: `web/test/slash-overlay.test.mjs`
- Modify: `web/test/run.mjs`

### Step 1: Write the failing test

Source-inspection contract test (no React rendering — matches the pattern of `web/test/health-icon.test.mjs` and `web/test/message-error-boundary.test.mjs`).

Create `web/test/slash-overlay.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(
  join(root, "src/components/SlashOverlay.tsx"),
  "utf8",
);

test("SlashOverlay exports a named React component", () => {
  assert.match(src, /export\s+function\s+SlashOverlay\s*\(/);
});

test("SlashOverlay accepts items/activeIndex/onSelect/onActiveChange props", () => {
  // Single props type declaration with all four fields.
  const propsDecl = src.match(/SlashOverlayProps\s*\{([\s\S]*?)\}/);
  assert.ok(propsDecl, "expected a SlashOverlayProps interface/type");
  assert.match(propsDecl[1], /\bitems\b/);
  assert.match(propsDecl[1], /\bactiveIndex\b/);
  assert.match(propsDecl[1], /\bonSelect\b/);
  assert.match(propsDecl[1], /\bonActiveChange\b/);
});

test("SlashOverlay imports RankedSkill from ./useSlashMenu", () => {
  assert.match(
    src,
    /import\s+type\s*\{[^}]*\bRankedSkill\b[^}]*\}\s*from\s*["']\.\/useSlashMenu["']/,
  );
});

test("SlashOverlay returns null when items is empty (no DOM noise)", () => {
  // Defensive render guard so the parent can drop the overlay by passing [].
  assert.match(src, /items\.length\s*===\s*0/);
  assert.match(src, /return\s+null/);
});

test("SlashOverlay container declares role='listbox'", () => {
  assert.match(src, /role=\{?["']listbox["']/);
});

test("SlashOverlay container is absolute-positioned above the composer", () => {
  // Above textarea = bottom-full + mb to clear; absolute so we don't shift layout.
  assert.match(src, /\babsolute\b/);
  assert.match(src, /\bbottom-full\b/);
});

test("SlashOverlay rows render with role='option' and data-active reflecting activeIndex", () => {
  assert.match(src, /role=\{?["']option["']/);
  assert.match(src, /data-active=/);
  // Active comparison uses activeIndex.
  assert.match(src, /activeIndex/);
});

test("SlashOverlay row click path fires onSelect via onMouseDown (not onClick) to avoid blur race", () => {
  // mouseDown not click so the textarea doesn't lose focus before selection fires.
  assert.match(src, /onMouseDown=/);
  assert.match(src, /onSelect\s*\(/);
  // explicit comment OR e.preventDefault to keep focus.
  assert.match(src, /preventDefault\s*\(\s*\)/);
});

test("SlashOverlay row hover path fires onActiveChange via onMouseEnter", () => {
  assert.match(src, /onMouseEnter=/);
  assert.match(src, /onActiveChange\s*\(/);
});

test("SlashOverlay renders the matched trigger label for trigger-reason rows", () => {
  // "match: <trigger>" UI cue so the user understands why a row is shown.
  assert.match(src, /reason\s*===\s*["']trigger["']/);
  assert.match(src, /matchedTrigger/);
  assert.match(src, /match:/);
});
```

### Step 2: Register the test in `web/test/run.mjs`

Append:

```js
import "./slash-overlay.test.mjs";
```

### Step 3: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
```

Expected: FAIL — file does not exist.

### Step 4: Implement the component

Create `web/src/components/SlashOverlay.tsx`:

```tsx
import type { RankedSkill } from "./useSlashMenu";

export interface SlashOverlayProps {
  items: RankedSkill[];
  activeIndex: number;
  onSelect: (name: string) => void;
  onActiveChange: (index: number) => void;
}

/**
 * Positioned listbox shown above the composer when the user is typing a
 * slash command. Stateless and presentational — useSlashMenu owns the
 * filtering/ranking, Chat owns the open state and keyboard wiring.
 *
 * mouseDown (not click) is used for selection so the textarea doesn't lose
 * focus between mousedown and click — the textarea blur path would close
 * the menu before click fires.
 */
export function SlashOverlay({
  items,
  activeIndex,
  onSelect,
  onActiveChange,
}: SlashOverlayProps) {
  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="pointer-events-auto absolute bottom-full left-0 right-0 z-20 mb-2 max-h-48 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      {items.map((item, i) => {
        const active = i === activeIndex;
        return (
          <div
            key={item.skill.name}
            role="option"
            aria-selected={active}
            data-active={active}
            className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm ${
              active ? "bg-accent" : ""
            }`}
            onMouseDown={(e) => {
              // mousedown not click: see comment above. preventDefault keeps
              // focus on the textarea so Enter/Esc still target it.
              e.preventDefault();
              onSelect(item.skill.name);
            }}
            onMouseEnter={() => onActiveChange(i)}
          >
            <span className="font-medium">{item.skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.skill.description}
            </span>
            {item.reason === "trigger" && item.matchedTrigger && (
              <span className="shrink-0 text-xs text-muted-foreground">
                match: {item.matchedTrigger}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

### Step 5: Run test + build to verify

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
cd /tmp/slash-completion && env -u NODE_ENV npm run build --workspace web 2>&1 | tail -5
```

Expected: both green.

### Step 6: Commit

```bash
git add web/src/components/SlashOverlay.tsx web/test/slash-overlay.test.mjs web/test/run.mjs
git commit -m "feat(web): add SlashOverlay listbox component"
```

---

## Task 5: Client — wire overlay into the composer in `Chat.tsx`

**Files:**
- Modify: `web/src/components/Chat.tsx`
- Create: `web/test/chat-slash.test.mjs`
- Modify: `web/test/run.mjs`

> **Test strategy:** source-inspection contract tests for the wiring (same pattern as `message-error-boundary.test.mjs`). Real keystroke behavior is covered by the manual smoke checklist in Task 6 since web/ has no React renderer for tests. The contract tests verify the WIRING is in place; the smoke pass verifies the BEHAVIOR is correct end-to-end.

### Step 1: Write the failing test

Create `web/test/chat-slash.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");

test("Chat imports the slash-menu hook and overlay", () => {
  assert.match(
    src,
    /import\s*\{[^}]*\buseSlashMenu\b[^}]*\}\s*from\s*["']\.\/useSlashMenu["']/,
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bSlashOverlay\b[^}]*\}\s*from\s*["']\.\/SlashOverlay["']/,
  );
});

test("Chat fetches the skills list once via client.listSkills", () => {
  // Loaded into state on mount; the overlay reads from this. Allow chained
  // multi-line style: `client\n  .listSkills()`.
  assert.match(src, /client\s*\.\s*listSkills\s*\(\s*\)/);
  // The catch handler exists so a failed fetch silently degrades (overlay just stays empty).
  assert.match(src, /\.catch\(/);
});

test("Chat invokes useSlashMenu(draft, skills)", () => {
  assert.match(src, /useSlashMenu\s*\(\s*draft\s*,\s*skills\s*\)/);
});

test("Chat renders <SlashOverlay/> guarded on slash.open", () => {
  // The overlay only renders when the menu is open — keeps the DOM clean.
  // Allow an optional `(` and whitespace between `&&` and `<SlashOverlay`
  // because the standard React idiom is `{slash.open && (\n  <SlashOverlay`.
  assert.match(src, /slash\.open\s*&&\s*\(?\s*<SlashOverlay/);
});

test("Chat passes the slash menu state into SlashOverlay", () => {
  // All four props wired.
  assert.match(src, /items=\{slash\.items\}/);
  assert.match(src, /activeIndex=\{slash\.activeIndex\}/);
  assert.match(src, /onSelect=\{/);
  assert.match(src, /onActiveChange=\{slash\.setActiveIndex\}/);
});

test("Chat's textarea container is position-relative so the overlay can absolute-position above it", () => {
  // The overlay uses absolute + bottom-full; it needs a positioned ancestor.
  // Look for a className with "relative" wrapping the Textarea region.
  assert.match(src, /className=["']relative["']/);
});

test("Chat onKeyDown intercepts ArrowDown/ArrowUp/Enter/Tab/Escape when slash.open", () => {
  // Guard: keystroke interception only runs when the menu is open.
  assert.match(src, /slash\.open/);
  // Each key listed.
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
    assert.match(src, new RegExp(`["']${key}["']`), `missing key handler for ${key}`);
  }
});

test("Chat Enter while overlay open accepts the active item and prevents send", () => {
  // The accept path calls setDraft with slash.accept(name) and the existing
  // Enter-sends path is gated to NOT run when slash.open is true.
  assert.match(src, /slash\.accept\s*\(/);
  // Existing send call still present; it's just guarded.
  assert.match(src, /void\s+submit\s*\(\s*\)/);
});

test("Chat respects e.nativeEvent.isComposing so IME input doesn't accept early", () => {
  // Mirror the existing send-on-Enter pattern which already checks isComposing.
  assert.match(src, /isComposing/);
});
```

### Step 2: Register the test in `web/test/run.mjs`

Append:

```js
import "./chat-slash.test.mjs";
```

### Step 3: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
```

Expected: FAIL — assertions about useSlashMenu/SlashOverlay imports failing.

### Step 4: Wire the hook + overlay into `web/src/components/Chat.tsx`

Three edits inside the existing component:

**(a) Imports.** `Chat.tsx` already imports `useEffect, useState` from react (line 2), `client` from `@/lib/api` (line 14), and types from `@/lib/types` (line 15). Make exactly these edits:

Change line 15 from:

```ts
import type { ChatMessage, TaskRow } from "@/lib/types";
```

to:

```ts
import type { ChatMessage, SkillSummary, TaskRow } from "@/lib/types";
```

After the existing `import { TaskTranscriptDialog } from "./TaskCard";` (currently line 19), add two new imports in alphabetical order:

```ts
import { SlashOverlay } from "./SlashOverlay";
import { useSlashMenu } from "./useSlashMenu";
```

**(b) Skills load + slash menu state.** The existing `useState` block is at lines 45–48. Insert this block immediately after line 48 (`const [cwdEditorOpen, setCwdEditorOpen] = useState(false);`):

```ts
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    let alive = true;
    client
      .listSkills()
      .then((r) => {
        if (alive) setSkills(r.skills);
      })
      .catch(() => {
        /* overlay is opt-in; silently degrade on auth/network */
      });
    return () => {
      alive = false;
    };
  }, []);

  const slash = useSlashMenu(draft, skills);
```

**(c) Textarea wrapper + keyboard interception.** The current Textarea block (lines 125–137) is:

```tsx
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={running ? "Assistant is working — messages will steer it" : "Message…"}
            rows={2}
            className="w-full resize-none"
          />
```

Replace it with this exact block (wraps only the Textarea — the send-button row remains a sibling outside the relative wrapper so the overlay positions to the textarea's bounds, not the wider composer container):

```tsx
          <div className="relative">
            {slash.open && (
              <SlashOverlay
                items={slash.items}
                activeIndex={slash.activeIndex}
                onSelect={(name) => setDraft(slash.accept(name))}
                onActiveChange={slash.setActiveIndex}
              />
            )}
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (slash.open) {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    slash.setActiveIndex(
                      (slash.activeIndex + 1) %
                        Math.max(slash.items.length, 1),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    slash.setActiveIndex(
                      (slash.activeIndex - 1 + slash.items.length) %
                        Math.max(slash.items.length, 1),
                    );
                    return;
                  }
                  if (
                    (e.key === "Enter" || e.key === "Tab") &&
                    slash.items.length > 0
                  ) {
                    e.preventDefault();
                    setDraft(
                      slash.accept(slash.items[slash.activeIndex].skill.name),
                    );
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    // Close by appending a space — slash.open is derived from
                    // draft and goes false once any whitespace appears. The
                    // visible draft becomes "/foo " which is harmless. The
                    // pure-derivation design (see Task 3) deliberately has no
                    // dismiss-flag — open state is a pure function of draft.
                    setDraft(draft + " ");
                    return;
                  }
                }
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                running
                  ? "Assistant is working — messages will steer it"
                  : "Message…"
              }
              rows={2}
              className="w-full resize-none"
            />
          </div>
```

**IMPLEMENTER STOP-on-bug-signal:** If the test for Escape (or any unstated test the reviewer adds later) is unhappy with the "append a space" trick, STOP and report — the cleaner fix is a dismiss-flag in `useSlashMenu` (`dismissed: boolean`, reset whenever the draft changes), and the hook's `open` becomes `… && !dismissed`. Do not silently rewrite the hook; surface the choice. (This trade-off is intentional per the pure-derivation design — confirm before changing.)

### Step 5: Run tests + typecheck + build

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
cd /tmp/slash-completion && env -u NODE_ENV npm run check 2>&1 | tail -5
cd /tmp/slash-completion && env -u NODE_ENV npm run build --workspace web 2>&1 | tail -10
```

Expected: all green.

### Step 6: Commit

```bash
git add web/src/components/Chat.tsx web/test/chat-slash.test.mjs web/test/run.mjs
git commit -m "feat(web): wire slash-command overlay into composer"
```

---

## Task 6: Full gate + manual smoke

**Files:** none — verification only.

### Step 1: Full gate

```bash
cd /tmp/slash-completion && bash scripts/gate.sh 2>&1 | tail -20
```

Expected: `=== gate: PASSED ===`.

### Step 2: Document the manual smoke checklist for ship

Print (do not commit) the following so the ship/review pass knows what a human must eyeball on the dev instance at :3000 (or :9873 prod after deploy):

```
Manual smoke (dev instance, http://localhost:3000):
  1. Open a session, focus the composer.
  2. Type "/" → overlay appears above the textarea listing all skills alphabetically.
  3. Type "re" → list narrows to "reflect", "review" (name-prefix bucket).
  4. Type "mem" → list shows trigger-substring matches with "match: memory" tag.
  5. Press ↓ → highlight moves; ↑ → wraps back.
  6. Press Enter → "/<active-name> " inserted; overlay closes; cursor at end; NO send.
  7. Press Enter again (empty selection mode) → message sends as normal.
  8. Type "/", press Esc → overlay closes; verify what's left in the textarea matches the design's Esc behavior (the awkward space-trick OR the dismiss-flag, depending on which Task 5 landed on).
  9. Verify no layout shift in the composer when the overlay opens (overlay is absolute-positioned).
 10. Resize window narrow → overlay should fit composer width, no horizontal scrollbar.
```

### Step 3: No commit — handoff to ship

---

## Post-plan handoff

After all tasks pass and the gate is green: invoke the `ship` skill. It will route the per-task report tails to cog memory, update CHANGELOG, and present the merge/PR options.
