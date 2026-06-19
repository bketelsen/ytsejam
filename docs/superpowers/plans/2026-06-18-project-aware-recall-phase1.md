# Project-Aware Auto-Recall (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Auto-inject memory (global profile + project-scoped recall) into the model's context before each turn, and force a working-directory choice at chat creation so sessions carry a real project.

**Architecture:** A new optional `workingDir` attribute on cog domains lets an `active-project` resolver map a session's workdir → a `projects:<x>` tag. A memory-section builder composes `ltm.profile()` + project-scoped `recall()` and injects it via the existing `composeSystemPrompt` path (read from `session.getBranch()` for the latest user message). A new-chat UI flow requires a workdir, sourced from domains-with-`workingDir` + recent + free-form.

**Tech Stack:** TypeScript, Node, React 19 + Vite (web), vitest (server/ltm), `node test/run.mjs` (web).

## Global Constraints

- The `ltm` package must not import network/UI code.
- Reuse: `resolveWorkdir`/`WorkdirStore`, cog domain manifest (`server/src/memory/domain/manifest.ts`, `Domain` type in `server/src/memory/types.ts`), `recall()` (`server/src/memory/recall.ts`), `composeSystemPrompt` (`server/src/persona.ts`), the `systemPrompt` callback in `server/src/manager.ts` (~line 302).
- Manager keeps ingest-only LTM coupling; read access enters via an injected `recallSection` callback built in `server/src/index.ts`.
- `recall()`'s own rule (file header): scoped recall uses a SEPARATE `filterTags` (LTM-only) param — never a single conflated filter. Honor it.
- Project tag form: cog domain path `projects/ytsejam` → tag `projects:ytsejam` (replace `/` with `:`).
- All memory injection is best-effort: any failure → omit the section, never block the turn.
- Tests: `cd server && npx vitest run test/<f>` ; typecheck `cd server && npm run check` / `cd packages/ltm && npm run check`.

---

### Task 1: `workingDir` attribute on cog domains

**Files:**
- Modify: `server/src/memory/types.ts` (the `Domain` interface — add `workingDir?`)
- Modify: `server/src/memory/domain/manifest.ts` (`normalizeDomain` — parse/validate it)
- Test: `server/test/domain-manifest-workingdir.test.ts`

**Interfaces:**
- Produces: `Domain.workingDir?: string` (absolute path; optional).

- [ ] **Step 1: Write the failing test**

```ts
// server/test/domain-manifest-workingdir.test.ts
import { describe, it, expect } from "vitest";
import { validateManifestContent } from "../src/memory/domain/manifest.ts";

describe("domain workingDir", () => {
  it("parses an optional absolute workingDir", () => {
    const [d] = validateManifestContent(`domains:\n  - id: ytsejam\n    path: projects/ytsejam\n    workingDir: /home/bjk/projects/ytsejam\n`);
    expect(d.workingDir).toBe("/home/bjk/projects/ytsejam");
  });
  it("omits workingDir when absent", () => {
    const [d] = validateManifestContent(`domains:\n  - id: work\n    path: work\n`);
    expect(d.workingDir).toBeUndefined();
  });
  it("rejects a non-absolute workingDir", () => {
    expect(() => validateManifestContent(`domains:\n  - id: x\n    path: x\n    workingDir: relative/dir\n`)).toThrow(/workingDir/);
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`cd server && npx vitest run test/domain-manifest-workingdir.test.ts`). Expected: `workingDir` undefined / no validation.

- [ ] **Step 3: Add `workingDir?: string` to the `Domain` interface** in `server/src/memory/types.ts` (find `export interface Domain`; add `workingDir?: string;` near `path`/`label`).

- [ ] **Step 4: Parse + validate in `normalizeDomain`** (`server/src/memory/domain/manifest.ts`). Before the `return {...}`, add:

```ts
  if (value.workingDir !== undefined) {
    if (typeof value.workingDir !== "string" || !value.workingDir.startsWith("/")) {
      throw new Error(`domain ${JSON.stringify(id)}: workingDir must be an absolute path`);
    }
  }
```

and add to the returned object literal:

```ts
    ...(typeof value.workingDir === "string" ? { workingDir: value.workingDir } : {}),
```

- [ ] **Step 5: Run it — PASS.** Then `cd server && npm run check`.

- [ ] **Step 6: Commit**

```bash
git add server/src/memory/types.ts server/src/memory/domain/manifest.ts server/test/domain-manifest-workingdir.test.ts
git commit -m "feat(cog): optional workingDir attribute on domains"
```

---

### Task 2: Active-project resolver

**Files:**
- Create: `server/src/memory/active-project.ts`
- Test: `server/test/active-project.test.ts`

**Interfaces:**
- Consumes: a domain list (`Domain[]`), and a workdir string.
- Produces: `projectTagForWorkdir(domains: Domain[], workdir: string): string | null` (pure, testable) and `activeProjectTag(resolveWorkdir, manifestLoader, sessionId): string | null` wrapper. Tag form: `projects/ytsejam` → `projects:ytsejam`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/active-project.test.ts
import { describe, it, expect } from "vitest";
import { projectTagForWorkdir } from "../src/memory/active-project.ts";
import type { Domain } from "../src/memory/types.ts";

const domains: Domain[] = [
  { id: "ytsejam", path: "projects/ytsejam", workingDir: "/home/bjk/projects/ytsejam" },
  { id: "mcp", path: "projects/truenas-mcp", workingDir: "/home/bjk/projects/truenas-mcp" },
  { id: "work", path: "work" }, // no workingDir
];

describe("projectTagForWorkdir", () => {
  it("maps an exact workdir to its domain tag", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/projects/ytsejam")).toBe("projects:ytsejam");
  });
  it("maps a nested subdir to the nearest-ancestor domain", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/projects/ytsejam/server/src")).toBe("projects:ytsejam");
  });
  it("returns null for an unmapped dir", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/.ytsejam/data")).toBeNull();
  });
  it("ignores domains without workingDir", () => {
    expect(projectTagForWorkdir(domains, "/home/bjk/work")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — FAIL** (module missing).

- [ ] **Step 3: Implement**

```ts
// server/src/memory/active-project.ts
import path from "node:path";
import type { Domain } from "./types.ts";

/** Flatten a domain tree into a list (domains may nest via subdomains). */
function flatten(domains: Domain[]): Domain[] {
  const out: Domain[] = [];
  const walk = (ds: Domain[]) => { for (const d of ds) { out.push(d); if (d.subdomains) walk(d.subdomains); } };
  walk(domains);
  return out;
}

/** True when `child` is `parent` or a descendant path of it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Map a session workdir to a project tag via domain `workingDir`, nearest
 * ancestor wins. `projects/ytsejam` → `projects:ytsejam`. Null when unmapped.
 */
export function projectTagForWorkdir(domains: Domain[], workdir: string): string | null {
  const candidates = flatten(domains)
    .filter((d): d is Domain & { workingDir: string } => typeof d.workingDir === "string")
    .filter((d) => isWithin(d.workingDir, workdir))
    .sort((a, b) => b.workingDir.length - a.workingDir.length); // longest (nearest) first
  const best = candidates[0];
  return best ? best.path.replace(/\//g, ":") : null;
}
```

- [ ] **Step 4: Run it — PASS.** Then `cd server && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/active-project.ts server/test/active-project.test.ts
git commit -m "feat(memory): active-project resolver (workdir -> project tag)"
```

---

### Task 3: `recall()` gains a separate LTM `filterTags` (project boost)

**Files:**
- Modify: `server/src/memory/recall.ts`
- Test: `server/test/recall-filtertags.test.ts`

**Interfaces:**
- Produces: `recall(query, opts?: { filterTags?: string[] })`. When `filterTags` is set, run the normal (global) recall AND an additional LTM `retrieve(query, { k, filterTags })`, merge so tagged hits are boosted to the front, deduped by `where`. Cog stays query-only (cog path-scoping deferred per the file header). Default (no opts) = unchanged behavior.

- [ ] **Step 1: Write the failing test** — uses the real `recall` against a temp LTM store seeded with one tagged and one untagged active record, asserting that with `filterTags:["projects:ytsejam"]` the tagged record's `where` appears AND an untagged global hit can still appear. (Implementer: seed via a `MemorySystem.open` temp store + `attachLtm`; mirror the setup in existing `server/test/*recall*`/memory tests. If a unit test against the singleton `memory` module is impractical, write the test against an extracted pure merge helper `mergeRecall(global, projectHits)` instead and cover the wiring by typecheck.)

```ts
// server/test/recall-filtertags.test.ts — shape; implementer adapts seeding to the repo's memory test harness
import { describe, it, expect } from "vitest";
import { mergeRecallHits } from "../src/memory/recall.ts";

describe("mergeRecallHits", () => {
  it("boosts project-tagged hits ahead of globals and dedupes by where", () => {
    const globals = [{ from: "ltm", text: "g", where: "ltm:1", score: 0.5 }] as const;
    const project = [{ from: "ltm", text: "p", where: "ltm:2", score: 0.4, tags: ["projects:ytsejam"] }] as const;
    const merged = mergeRecallHits(globals as any, project as any);
    expect(merged[0].where).toBe("ltm:2"); // project first
    expect(merged.some((h) => h.where === "ltm:1")).toBe(true); // global still present
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`mergeRecallHits` missing).

- [ ] **Step 3: Implement.** Change the signature to `recall(query: string, opts: { filterTags?: string[] } = {})`. Add an exported pure helper and a second LTM pass:

```ts
/** Merge project-tagged hits ahead of global hits, deduped by `where`. */
export function mergeRecallHits(global: RecallHit[], project: RecallHit[]): RecallHit[] {
  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const h of [...project, ...global]) {
    if (seen.has(h.where)) continue;
    seen.add(h.where);
    out.push(h);
  }
  return out;
}
```

In `recall`, after building the global `hits` (existing logic), if `opts.filterTags?.length` and `ltm` is present, run `ltm.retrieve(query, { k: K, filterTags: opts.filterTags })`, normalize its items to `RecallHit[]` (reuse the existing LTM-normalization block — extract it to a local `toLtmHits(items, cogOriginPrefixes)` helper to avoid duplication), then `return { ...rest, hits: mergeRecallHits(hits, projectHits) }`. Keep `cogCount`/`ltmCount`/`dropped` from the global pass.

> Verify `RetrieveOptions` accepts `filterTags` (it does — `packages/ltm/src/types.ts`). If `ltm.retrieve`'s options type doesn't expose it, pass it through per the real signature.

- [ ] **Step 4: Run it — PASS.** Then `cd server && npm run check` and run the existing recall test(s) to confirm default behavior is unchanged: `npx vitest run test/ | grep -i recall` (or the specific file).

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/recall.ts server/test/recall-filtertags.test.ts
git commit -m "feat(recall): optional LTM filterTags for project-boosted recall"
```

---

### Task 4: Memory-section builder

**Files:**
- Create: `server/src/memory/memory-section.ts`
- Test: `server/test/memory-section.test.ts`

**Interfaces:**
- Produces: `buildMemorySection(deps, sessionId, query): Promise<string | undefined>` where `deps = { profile: () => ProfileSummary | undefined, recall: (q, opts) => Promise<RecallResult>, activeProjectTag: (sessionId) => string | null }`. Returns a labeled markdown block, or `undefined` when there's nothing. Inject deps so it's unit-testable without the live singletons.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/memory-section.test.ts
import { describe, it, expect } from "vitest";
import { buildMemorySection } from "../src/memory/memory-section.ts";

const profile = () => ({
  identity: [{ predicate: "name", object: "Brian" }],
  preferences: [{ predicate: "prefers", object: "Go" }],
  directives: [], attributes: [],
}) as any;

describe("buildMemorySection", () => {
  it("composes profile + recalled hits into a labeled block", async () => {
    const recall = async () => ({ hits: [{ from: "ltm", text: "decided to use streaming JSONL", where: "ltm:1", score: 0.7 }], cogCount: 0, ltmCount: 1, dropped: 0 }) as any;
    const out = await buildMemorySection({ profile, recall, activeProjectTag: () => "projects:ytsejam" }, "s1", "how do we load logs?");
    expect(out).toContain("Brian");
    expect(out).toContain("streaming JSONL");
  });
  it("returns undefined when profile is empty and recall has no hits", async () => {
    const recall = async () => ({ hits: [], cogCount: 0, ltmCount: 0, dropped: 0 }) as any;
    const out = await buildMemorySection({ profile: () => undefined, recall, activeProjectTag: () => null }, "s1", "hi");
    expect(out).toBeUndefined();
  });
  it("never throws if recall rejects (best-effort) -> returns profile-only or undefined", async () => {
    const recall = async () => { throw new Error("boom"); };
    const out = await buildMemorySection({ profile, recall, activeProjectTag: () => null }, "s1", "hi");
    expect(out).toContain("Brian"); // profile still rendered
  });
});
```

- [ ] **Step 2: Run it — FAIL** (module missing).

- [ ] **Step 3: Implement**

```ts
// server/src/memory/memory-section.ts
import type { ProfileSummary, RecallResult } from "ltm";

export interface MemorySectionDeps {
  profile: () => ProfileSummary | undefined;
  recall: (query: string, opts?: { filterTags?: string[] }) => Promise<RecallResult>;
  activeProjectTag: (sessionId: string) => string | null;
}

function renderProfile(p: ProfileSummary | undefined): string | undefined {
  if (!p) return undefined;
  const lines: string[] = [];
  const add = (label: string, items?: { predicate: string; object: string }[]) => {
    for (const i of items ?? []) lines.push(`- ${label}: ${i.predicate} ${i.object}`);
  };
  add("identity", p.identity); add("preference", p.preferences);
  add("directive", p.directives); add("attribute", p.attributes);
  return lines.length ? `What you know about the user:\n${lines.join("\n")}` : undefined;
}

const MAX_HITS = 6;

export async function buildMemorySection(deps: MemorySectionDeps, sessionId: string, query: string): Promise<string | undefined> {
  const tag = deps.activeProjectTag(sessionId);
  const profileBlock = renderProfile(deps.profile());
  let recallBlock: string | undefined;
  try {
    const r = await deps.recall(query, tag ? { filterTags: [tag] } : undefined);
    const hits = r.hits.slice(0, MAX_HITS).map((h) => `- (${h.from}) ${h.text}`);
    if (hits.length) recallBlock = `Relevant memory:\n${hits.join("\n")}`;
  } catch { /* best-effort */ }
  const parts = [profileBlock, recallBlock].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}
```

> Verify the actual `ProfileSummary` shape (`packages/ltm/src/types.ts`) — field names (`identity`/`preferences`/`directives`/`attributes`) and item shape (`predicate`/`object`). Adapt `renderProfile` to the real fields if they differ.

- [ ] **Step 4: Run it — PASS.** Then `cd server && npm run check`.

- [ ] **Step 5: Commit**

```bash
git add server/src/memory/memory-section.ts server/test/memory-section.test.ts
git commit -m "feat(memory): memory-section builder (profile + project recall)"
```

---

### Task 5: Inject the memory section into the per-turn prompt

**Files:**
- Modify: `server/src/persona.ts` (`composeSystemPrompt` — add `memorySection?`)
- Modify: `server/src/manager.ts` (build the section in the `systemPrompt` callback)
- Modify: `server/src/index.ts` (provide the `recallSection` callback + `manifest loader`)
- Test: `server/test/compose-system-prompt-memory.test.ts`

**Interfaces:**
- Consumes: `buildMemorySection` (Task 4), `projectTagForWorkdir` (Task 2), `recall` (Task 3), `memory.getLtm()`.
- Produces: `composeSystemPrompt(persona, { …, memorySection? })` renders the block; manager opts gain `recallSection?: (sessionId: string, query: string) => Promise<string | undefined>`.

- [ ] **Step 1: Write the failing test** (pure — `composeSystemPrompt` includes the memory block):

```ts
// server/test/compose-system-prompt-memory.test.ts
import { describe, it, expect } from "vitest";
import { composeSystemPrompt } from "../src/persona.ts";

describe("composeSystemPrompt memorySection", () => {
  it("includes the memory section when provided", () => {
    const out = composeSystemPrompt("PERSONA", { dataDir: "/tmp", memorySection: "What you know about the user:\n- identity: name Brian" });
    expect(out).toContain("name Brian");
  });
  it("omits cleanly when memorySection is undefined", () => {
    const out = composeSystemPrompt("PERSONA", { dataDir: "/tmp" });
    expect(out).not.toContain("What you know about the user");
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`memorySection` not rendered).

- [ ] **Step 3: Add `memorySection` to `composeSystemPrompt`.** In `server/src/persona.ts`, add `memorySection?: string;` to the opts type and include it in the `extras` join (alongside `cogSection`, `skillsSection`). Mirror the existing extras handling exactly.

- [ ] **Step 4: Build the section in the manager `systemPrompt` callback.** In `server/src/manager.ts` (~line 302), add `recallSection?: (sessionId: string, query: string) => Promise<string | undefined>;` to the manager opts interface. In the `systemPrompt` callback, read the latest user message from the branch and build the section:

```ts
        const latestUser = await opened.session.getBranch()
          .then((b) => [...b].reverse().find((e) => e.role === "user"))
          .catch(() => undefined);
        const query = latestUser ? textBlocksOf(latestUser).join(" ") : "";
        const memorySection = query
          ? await this.opts.recallSection?.(metadata.id, query).catch(() => undefined)
          : undefined;
```

Add `memorySection` to the `Promise.all` group or compute alongside, then pass `memorySection` into `composeSystemPrompt(persona, { …, memorySection })`.

> The exact branch-entry shape (`role`, how to extract text — `textBlocksOf` is already imported in manager.ts) must be verified against `getBranch()`'s real return type; adapt the `latestUser`/`query` extraction accordingly. If `getBranch()` does NOT contain the latest user turn at systemPrompt-build time, fall back to passing only the profile (no query-conditioned recall) and note it in the report as a follow-up.

- [ ] **Step 5: Wire `recallSection` in `index.ts`.** Where the manager is constructed (the opts object with `resolveWorkdir`, `ltm`, etc.), add:

```ts
    recallSection: async (sessionId, query) => {
      const { buildMemorySection } = await import("./memory/memory-section.ts");
      const { projectTagForWorkdir } = await import("./memory/active-project.ts");
      const { recall } = await import("./memory/recall.ts");
      const ltm = memory.getLtm();
      const domains = /* load domain manifest list — reuse the existing manifest loader/controller in scope */;
      const workdir = resolveWorkdir(workdirs, sessionId, config.dataDir);
      return buildMemorySection(
        { profile: () => ltm?.profile(), recall, activeProjectTag: () => projectTagForWorkdir(domains, workdir) },
        sessionId, query,
      );
    },
```

> Use static imports at the top of `index.ts` instead of dynamic `import()` if that matches the file's style. Resolve how the domain manifest list is obtained in `index.ts` (there is already a cog/domain controller wired for `cogBrief`; reuse it — do not re-read the file ad hoc).

- [ ] **Step 6: Run the new test — PASS.** Then `cd server && npm run check && npx vitest run` (full server suite must stay green).

- [ ] **Step 7: Commit**

```bash
git add server/src/persona.ts server/src/manager.ts server/src/index.ts server/test/compose-system-prompt-memory.test.ts
git commit -m "feat(memory): inject profile + project recall into the per-turn prompt"
```

---

### Task 6: `GET /api/workdirs/suggestions`

**Files:**
- Modify: `server/src/server.ts` (new route)
- Test: `server/test/workdir-suggestions.test.ts` (or extend an existing server route test)

**Interfaces:**
- Produces: `GET /api/workdirs/suggestions` → `{ knownProjects: { path: string; label: string }[]; recent: string[] }`. Known = domains with `workingDir` (`{ path: workingDir, label: label ?? id }`). Recent = distinct latest workdirs across `WorkdirStore` session logs (most-recent first), excluding the dataDir default.

- [ ] **Step 1: Write the failing test** — mirror an existing `server/test/api*.test.ts` setup (build the app, call the route). Assert the response shape: `knownProjects` reflects domains-with-workingDir; `recent` is an array. (Implementer: follow the existing server-test harness for app construction + auth.)

- [ ] **Step 2: Run it — FAIL** (404 / route missing).

- [ ] **Step 3: Implement the route** in `server/src/server.ts` near the other `/api/...` routes. Build `knownProjects` from the domain manifest list already available to the server (reuse the controller used elsewhere). Build `recent` from `WorkdirStore` — add a helper to `server/src/workdirs.ts` (e.g. `recentWorkdirs(store, limit)`) that scans the per-session logs, takes the latest event per session, dedupes, returns most-recent-first; cover it with a focused unit test if it carries logic.

- [ ] **Step 4: Run it — PASS.** Then `cd server && npm run check && npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/workdirs.ts server/test/workdir-suggestions.test.ts
git commit -m "feat(api): GET /api/workdirs/suggestions (known projects + recent)"
```

---

### Task 7: New-chat working-directory selection (web)

**Files:**
- Modify: `web/src/lib/api.ts` (client for the suggestions endpoint)
- Modify: `web/src/useApp.ts` (new-chat flow requires a workdir; set cwd on create)
- Create/Modify: a small workdir-picker component (reuse the existing cwd-editor pattern in `web/src/components/Chat.tsx`)
- Test: web tests per `web/test/run.mjs` conventions (light; manual-verify note acceptable where the harness can't cover UI)

**Interfaces:**
- Consumes: `GET /api/workdirs/suggestions`; existing `createSession` + `setSessionCwd` clients.
- Produces: a new-chat flow that does not silently use the dataDir default.

- [ ] **Step 1: Add the API client.** In `web/src/lib/api.ts`, add `workdirSuggestions: () => api<{ knownProjects: {path:string;label:string}[]; recent: string[] }>("/api/workdirs/suggestions")`.

- [ ] **Step 2: Workdir picker UI.** Build a small modal/inline picker that lists `knownProjects` (label + path), `recent`, and a free-form input; the most-recent entry pre-selected. Reuse the styling/pattern of the existing cwd editor in `Chat.tsx` (`cwdEditorOpen` state, the POST at ~line 325).

- [ ] **Step 3: Gate new-chat on a choice.** In `web/src/useApp.ts` (the `createSession` flow ~line 204), open the picker first; on confirm, `createSession(model)` then `setSessionCwd(session.id, chosenDir)` and `setCurrentCwd(chosenDir)`. Do not create a session pinned to the dataDir default without a choice.

- [ ] **Step 4: Verify.** `cd web && npm run check` (typecheck) and `npm test` (the `node test/run.mjs` runner). Manually confirm in the running app that "new chat" prompts for a workdir and the chosen dir is set (note in report; the web harness may not script the modal).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/useApp.ts web/src/components/
git commit -m "feat(web): new-chat working-directory selection flow"
```

---

### Task 8: Full-suite green + deploy-build sanity

**Files:** none (verification)

- [ ] **Step 1:** `cd packages/ltm && npx vitest run && npm run check`
- [ ] **Step 2:** `cd server && npx vitest run && npm run check`
- [ ] **Step 3:** `cd web && npm run check && npm test`
- [ ] **Step 4:** Commit any incidental fixes; otherwise report clean.

---

## Self-Review

- **Spec coverage:** `workingDir` attribute (T1) ✓; resolver (T2) ✓; project-scoped recall via separate `filterTags` (T3, honors recall.ts rule) ✓; memory-section builder profile+recall (T4) ✓; per-turn injection via composeSystemPrompt + getBranch latest-message (T5, resolves the spec's open injection question) ✓; suggestions endpoint known+recent (T6) ✓; new-chat workdir flow known/recent/free-form, no silent default (T7) ✓; best-effort/never-block throughout (T4/T5 error handling) ✓.
- **Placeholders:** none — server tasks carry real code; T5/T6/T7 name the exact files + the verify-against-real-signature steps (getBranch shape, ProfileSummary fields, manifest loader in index.ts, web harness) because those depend on code not quoted here.
- **Type consistency:** `projectTagForWorkdir`, `recall(query, {filterTags})`, `mergeRecallHits`, `buildMemorySection(deps,…)`, `composeSystemPrompt({…,memorySection})`, `recallSection(sessionId,query)` used consistently across tasks.
