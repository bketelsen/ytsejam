# CopilotEmbedder + Runtime Embedder Factory Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add `CopilotEmbedder` to `packages/ltm`, build a runtime embedder factory in the server, and wire both Copilot and Ollama into the live `MemorySystem` so prod stops silently using `HashEmbedder`.

**Spec:** `docs/plans/2026-06-14-copilot-embedder-design.md`

**Architecture:** Mirror the existing `OllamaEmbedder` shape for the new adapter. Add a single `createLtmEmbedder()` factory in `server/src/memory/embedder.ts` that both `server/src/index.ts` and `server/src/cli/ltm-commands.ts` use, with capability probes (`auto`) or fail-closed pinning (`copilot`/`ollama`/`hash`). Detect dimension mismatch against the existing LTM index and refuse startup with a clear `ltm replay --force` remediation.

**Tech Stack:** TypeScript, Node built-in `fetch`, vitest. Zero new dependencies.

**Worktree:** /home/bjk/projects/.worktrees/copilot-embedder

**Branch:** feat/copilot-embedder

---

## Task 1: `CopilotEmbedder` adapter

**Files:**
- Create: `packages/ltm/src/embedding/copilot-embedder.ts`
- Create: `packages/ltm/test/copilot-embedder.test.ts`
- Modify: `packages/ltm/src/index.ts` (add export, see existing OllamaEmbedder export line ~20)

### Step 1: Write the failing tests

Tests mirror `packages/ltm/test/ollama-embedder.test.ts` (read it first for the existing patterns: `globalThis.fetch` stubbing, `countingEmbedder` reuse with `CachedEmbedder`, dimension-disagree assertions).

`packages/ltm/test/copilot-embedder.test.ts` must cover:

1. `create()` probes once and discovers dimension from `data[0].embedding.length` (mock returns 1536-dim vector).
2. Second `embed()` reuses discovered dimension, no second probe call beyond the one-shot.
3. HTTP 500 throws with `{url, model, status, body}` in the error message.
4. HTTP 401 triggers a fresh `getApiKey()` call and one retry; if the retry also 401s, throw.
5. Missing `data[0].embedding` throws with contract-violation context (include the body prefix in the message).
6. Returned vector is L2-unit-norm after defensive renormalization (sum-of-squares within 1e-9 of 1).
7. `getApiKey()` returning undefined throws immediately on first use.
8. Wrapping in `CachedEmbedder` cache-hits on repeat calls (use the `countingEmbedder` pattern from the Ollama tests, but wrap Copilot).
9. Explicit `dimension` option in `create()` skips the probe; subsequent `embed()` that returns a different dimension from the wire throws with the disagreement message.

Use the same module-mocked fetch pattern Ollama tests use. Authorization header must be `Bearer <key>`, plus `Content-Type: application/json` and `Copilot-Integration-Id: vscode-chat`.

### Step 2: Run tests to verify they fail

Run: `cd packages/ltm && npx vitest --run test/copilot-embedder.test.ts`
Expected: FAIL — `Cannot find module './copilot-embedder.ts'` or similar.

### Step 3: Write minimal implementation

`packages/ltm/src/embedding/copilot-embedder.ts` mirrors `ollama-embedder.ts` structurally:

- Top-of-file doc comment explaining why: optional, opt-in, talks to GitHub Copilot's `/embeddings` (`text-embedding-3-small` default, 1536-dim, OpenAI response shape), no SDK dependency. Constructor takes `getApiKey: () => Promise<string | undefined>` so the package stays decoupled from `PiAuthStore`.
- `interface CopilotEmbedderOptions { getApiKey: () => Promise<string | undefined>; model?: string; baseUrl?: string; dimension?: number; }`
- Default `model = "text-embedding-3-small"`, default `baseUrl = "https://api.enterprise.githubcopilot.com"`.
- Private `requestEmbedding(baseUrl, model, text, getApiKey)` that:
  - Resolves the key via `getApiKey()`; throws if undefined.
  - POSTs to `${baseUrl}/embeddings` with headers `Authorization: Bearer <key>`, `Content-Type: application/json`, `Copilot-Integration-Id: vscode-chat`, body `{input: text, model}`.
  - On HTTP 401, calls `getApiKey()` again (force-refresh-via-store happens inside the injected function) and retries the POST once.
  - On any other non-2xx, throws with `{url, model, status, body}`.
  - Reads `body.data[0].embedding`. If missing/empty, throws contract violation with `body.slice(0, 200)`.
  - Returns the raw vector (renormalization happens in `embed()`).
- `class CopilotEmbedder implements Embedder` with `readonly dimension`, `readonly modelName`, private constructor, `static async create(opts)`:
  - If `opts.dimension !== undefined`, construct directly (no probe).
  - Otherwise, probe with text `"dimension probe"`, set dimension from `vector.length`.
- `embed(text)`:
  - Calls `requestEmbedding()`.
  - Asserts returned vector length === `this.dimension`, throws disagreement message if not.
  - Defensive L2 renormalization (same as Ollama).
  - Returns the unit vector.

Export from `packages/ltm/src/index.ts`: add `export { CopilotEmbedder, type CopilotEmbedderOptions } from "./embedding/copilot-embedder.ts";` next to the `OllamaEmbedder` export.

### Step 4: Run tests to verify they pass

Run: `cd packages/ltm && npx vitest --run test/copilot-embedder.test.ts`
Expected: PASS — all 9 tests green.

### Step 5: Run full ltm gate

Run: `cd packages/ltm && npm test && npm run check`
Expected: PASS — no regressions in existing tests, no type errors.

### Step 6: Commit

```bash
git add packages/ltm/src/embedding/copilot-embedder.ts \
        packages/ltm/test/copilot-embedder.test.ts \
        packages/ltm/src/index.ts
git commit -m "feat(ltm): CopilotEmbedder adapter + unit tests"
```

---

## Task 2: Eval CLI `--copilot` mode

**Files:**
- Modify: `packages/ltm/src/eval/run.ts` (add `--copilot` parsing, mutex with `--semantic` and `--ollama`)
- Modify: `packages/ltm/package.json` (add `eval:copilot` script)
- Modify: `packages/ltm/README.md` (add embedder row, add command, add maturity row)

### Step 1: Read the existing `--ollama` wiring

Read `packages/ltm/src/eval/run.ts` lines around the existing `ollama` handling (the boolean parse, the mutex check `semantic && ollama`, the construction inside the `else if (ollama)` branch). Copilot wiring follows the same shape.

### Step 2: Add `--copilot` handling

In `packages/ltm/src/eval/run.ts`:

- Parse `--copilot` as boolean, `--copilot-model` (default `"text-embedding-3-small"`), `--copilot-url` (default `process.env.COPILOT_BASE_URL` or `"https://api.enterprise.githubcopilot.com"`).
- Extend the mutex check: any two of `{semantic, ollama, copilot}` exits 2 with `"--semantic, --ollama, and --copilot are mutually exclusive: pick one embedder mode."`
- Add an `else if (copilot)` branch that constructs `CopilotEmbedder.create()`. The eval CLI does NOT have a `PiAuthStore` — read the API key from `process.env.GITHUB_COPILOT_API_KEY` and pass `() => Promise.resolve(process.env.GITHUB_COPILOT_API_KEY)` as `getApiKey`. If unset, exit 2 with `"--copilot requires GITHUB_COPILOT_API_KEY (a Copilot API key from PiAuthStore.getApiKey('github-copilot'))"`.
- Wrap in `CachedEmbedder` namespaced by `"copilot:" + copilotEmbedder.modelName` (the new namespace convention).
- Apply the same medium-band paraphrase threshold raise that `--semantic` and `--ollama` use.

### Step 3: Update `packages/ltm/package.json`

Add `"eval:copilot": "node src/eval/run.ts --copilot"` next to `eval:ollama`.

### Step 4: Update `packages/ltm/README.md`

In the embedders table, add a `copilot (optional)` row similar to the Ollama row. In the commands block, add `npm run eval:copilot`. In the maturity table, add `CopilotEmbedder | stable — mocked-fetch tested, live smoke gated on `LTM_COPILOT_LIVE=1``. One paragraph in the Embedders section pointing at the env var and the namespace convention.

ALSO change the existing `OllamaEmbedder` namespace example in the README from `ollama.modelName` to `"ollama:" + ollama.modelName` (the new convention from this PR).

### Step 5: Verify type-check + tests still pass

Run: `cd packages/ltm && npm run check && npm test`
Expected: PASS.

### Step 6: Commit

```bash
git add packages/ltm/src/eval/run.ts packages/ltm/package.json packages/ltm/README.md
git commit -m "feat(ltm): eval CLI --copilot mode + npm run eval:copilot"
```

---

## Task 3: Update namespace convention for `CachedEmbedder` (`OllamaEmbedder` callers)

**Files:**
- Modify: `packages/ltm/src/eval/run.ts` (existing Ollama branch — change namespace from `ollama.modelName` to `"ollama:" + ollama.modelName`)
- Modify: `packages/ltm/src/embedding/ollama-embedder.ts` (docstring example)
- Modify: `packages/ltm/src/embedding/local-embedder.ts` (docstring example, if any caller uses it — but no live callers exist yet, so docstring only)

### Step 1: Update the Ollama eval branch namespace

In `packages/ltm/src/eval/run.ts`, change the `new CachedEmbedder(ollama, cacheDir, ollama.modelName)` (or however it's currently written) to `new CachedEmbedder(ollama, cacheDir, "ollama:" + ollama.modelName)`.

This invalidates existing on-disk Ollama eval cache entries (one-time recompute). That's intentional — the prefix protects against future cross-provider model-name collisions.

### Step 2: Update the docstring examples

In `packages/ltm/src/embedding/ollama-embedder.ts`, update the top-of-file usage example to show `"ollama:" + ollama.modelName`. Same in `packages/ltm/src/embedding/local-embedder.ts` for consistency (the package will eventually wire this too).

### Step 3: Verify tests still pass

Run: `cd packages/ltm && npm test`
Expected: PASS — the Ollama unit tests don't assert on the cache namespace, so they're unaffected.

### Step 4: Commit

```bash
git add packages/ltm/src/eval/run.ts \
        packages/ltm/src/embedding/ollama-embedder.ts \
        packages/ltm/src/embedding/local-embedder.ts
git commit -m "refactor(ltm): namespace CachedEmbedder by \"<provider>:<model>\" for cross-provider safety"
```

---

## Task 4: Runtime embedder factory

**Files:**
- Create: `server/src/memory/embedder.ts`
- Create: `server/test/memory-embedder.test.ts`

### Step 1: Read context

- `server/src/index.ts` lines 130-160 for the existing `MemorySystem.open()` call and surrounding env-var pattern (`YTSEJAM_LTM_STORE_DIR`, etc.).
- `server/src/cli/ltm-commands.ts` lines 40-55 for the CLI's `MemorySystem.open()` call.
- `server/src/pi-auth.ts` for `PiAuthStore.hasCredentials('github-copilot')` and `PiAuthStore.getApiKey('github-copilot')`.
- `packages/ltm/src/embedding/cached-embedder.ts` for the namespace convention.

### Step 2: Write the failing tests

`server/test/memory-embedder.test.ts` covers:

1. Pinned `hash` mode returns a `HashEmbedder` wrapped in `CachedEmbedder` with namespace `"hash:256"` (or whatever dim). Label is `"hash:256"`.
2. Pinned `copilot` mode with no Copilot creds in the (mocked) `PiAuthStore` throws an error mentioning the env var and how to opt down.
3. Pinned `ollama` mode with an unreachable Ollama URL throws an error mentioning the URL and how to opt down. (Use a guaranteed-closed port like `http://127.0.0.1:1`.)
4. `auto` mode with Copilot creds present (mocked `hasCredentials` returns true, `getApiKey` returns a key, mocked fetch returns a valid embed response) selects Copilot. Label is `"copilot:text-embedding-3-small"`.
5. `auto` mode without Copilot creds, with Ollama reachable (mocked fetch on the Ollama URL returns valid embed), selects Ollama. Label is `"ollama:<model>"`.
6. `auto` mode with neither selects Hash and logs a WARN-level message. Label is `"hash:256"`.
7. The returned `dimension` field matches the wrapped embedder's `.dimension`.
8. The returned `embedder` is a `CachedEmbedder` (assert via `instanceof` or via the cache-hit behavior with a second call).

Use vitest's `vi.mock()` for `globalThis.fetch` and a fake `PiAuthStore` (just a `{hasCredentials, getApiKey}` object — the factory should accept the auth store as a structural type, not a concrete class).

### Step 3: Run tests to verify they fail

Run: `cd server && npx vitest --run test/memory-embedder.test.ts`
Expected: FAIL — module not found.

### Step 4: Implement the factory

`server/src/memory/embedder.ts`:

```ts
import path from "node:path";
import os from "node:os";
import {
  HashEmbedder,
  CachedEmbedder,
  OllamaEmbedder,
  CopilotEmbedder,
  type Embedder,
} from "ltm";

export type LtmEmbedderMode = "auto" | "copilot" | "ollama" | "hash";

export interface LtmEmbedderOptions {
  mode: LtmEmbedderMode;
  cacheDir: string;
  copilot?: { model?: string; baseUrl?: string };
  ollama?: { model?: string; baseUrl?: string };
}

export interface AuthStoreLike {
  hasCredentials(provider: string): boolean;
  getApiKey(provider: string): Promise<string | undefined>;
}

export interface LtmEmbedderResult {
  embedder: Embedder;
  label: string;
  dimension: number;
}

export async function createLtmEmbedder(
  auth: AuthStoreLike,
  opts: LtmEmbedderOptions,
): Promise<LtmEmbedderResult> {
  const mode = opts.mode;

  // Pinned modes
  if (mode === "hash") {
    return wrapHash(opts.cacheDir);
  }
  if (mode === "copilot") {
    if (!auth.hasCredentials("github-copilot")) {
      throw new Error(
        `YTSEJAM_LTM_EMBEDDER=copilot but no github-copilot OAuth credentials in PiAuthStore. ` +
          `Run \`pi\` and \`/login\` to obtain credentials, or set YTSEJAM_LTM_EMBEDDER=ollama|hash to opt down.`,
      );
    }
    return wrapCopilot(auth, opts);
  }
  if (mode === "ollama") {
    return wrapOllama(opts).catch((err: Error) => {
      throw new Error(
        `YTSEJAM_LTM_EMBEDDER=ollama but ${opts.ollama?.baseUrl ?? "http://localhost:11434"} is not reachable: ${err.message}. ` +
          `Start the Ollama service, or set YTSEJAM_LTM_EMBEDDER=hash|auto|copilot to opt down.`,
      );
    });
  }

  // auto mode: probe in order copilot -> ollama -> hash
  if (auth.hasCredentials("github-copilot")) {
    try {
      return await wrapCopilot(auth, opts);
    } catch (err) {
      console.warn(
        `[ltm embedder auto] Copilot creds present but probe failed: ${(err as Error).message}. Falling through.`,
      );
    }
  }
  try {
    return await wrapOllama(opts);
  } catch (err) {
    // Ollama not reachable — silent fall-through is OK in auto mode.
  }
  console.warn(
    `[ltm embedder auto] Falling back to HashEmbedder (no Copilot creds, no Ollama service). ` +
      `Semantic recall will be degraded. Set YTSEJAM_LTM_EMBEDDER=copilot or =ollama to require a real embedder.`,
  );
  return wrapHash(opts.cacheDir);
}

function wrapHash(cacheDir: string): LtmEmbedderResult {
  const inner = new HashEmbedder();
  const namespace = `hash:${inner.dimension}`;
  return {
    embedder: new CachedEmbedder(inner, cacheDir, namespace),
    label: namespace,
    dimension: inner.dimension,
  };
}

async function wrapCopilot(auth: AuthStoreLike, opts: LtmEmbedderOptions): Promise<LtmEmbedderResult> {
  const inner = await CopilotEmbedder.create({
    getApiKey: () => auth.getApiKey("github-copilot"),
    model: opts.copilot?.model ?? "text-embedding-3-small",
    baseUrl: opts.copilot?.baseUrl,
  });
  const namespace = `copilot:${inner.modelName}`;
  return {
    embedder: new CachedEmbedder(inner, opts.cacheDir, namespace),
    label: namespace,
    dimension: inner.dimension,
  };
}

async function wrapOllama(opts: LtmEmbedderOptions): Promise<LtmEmbedderResult> {
  const inner = await OllamaEmbedder.create({
    model: opts.ollama?.model ?? "nomic-embed-text:latest",
    baseUrl: opts.ollama?.baseUrl,
  });
  const namespace = `ollama:${inner.modelName}`;
  return {
    embedder: new CachedEmbedder(inner, opts.cacheDir, namespace),
    label: namespace,
    dimension: inner.dimension,
  };
}

export function parseLtmEmbedderMode(raw: string | undefined): LtmEmbedderMode {
  const v = (raw ?? "auto").toLowerCase();
  if (v === "auto" || v === "copilot" || v === "ollama" || v === "hash") return v;
  throw new Error(`Invalid YTSEJAM_LTM_EMBEDDER=${raw}. Valid: auto, copilot, ollama, hash.`);
}
```

### Step 5: Run tests to verify they pass

Run: `cd server && npx vitest --run test/memory-embedder.test.ts`
Expected: PASS — all 8 tests green.

### Step 6: Commit

```bash
git add server/src/memory/embedder.ts server/test/memory-embedder.test.ts
git commit -m "feat(server): runtime LTM embedder factory + tests"
```

---

## Task 5: Wire the factory into server boot + CLI + dimension-mismatch refusal

**Files:**
- Modify: `server/src/index.ts` (around line 131-160, the `MemorySystem.open()` call)
- Modify: `server/src/cli/ltm-commands.ts` (around line 47, the `MemorySystem.open()` call)
- Modify: `server/src/config.ts` (add the new env-var-derived config)
- Create: `server/test/server-embedder-startup.test.ts` (dimension-mismatch refusal integration test)

### Step 1: Read existing config flow

- `server/src/config.ts` for how env vars are surfaced (e.g. `piAuthPath`, the pattern is `process.env.YTSEJAM_X ?? default`).
- `server/src/index.ts` for the boot sequence — see where `authStore` is constructed, where `MemorySystem.open` is called, and where startup errors are surfaced.

### Step 2: Add config fields

In `server/src/config.ts`, add:

```ts
ltmEmbedderMode: parseLtmEmbedderMode(process.env.YTSEJAM_LTM_EMBEDDER),
ltmEmbedderCacheDir: process.env.YTSEJAM_LTM_CACHE_DIR ?? path.join(dataDir, "memory", "ltm-cache"),
ltmCopilotModel: process.env.YTSEJAM_LTM_COPILOT_MODEL ?? "text-embedding-3-small",
ltmCopilotUrl: process.env.YTSEJAM_LTM_COPILOT_URL,
ltmOllamaModel: process.env.YTSEJAM_LTM_OLLAMA_MODEL ?? "nomic-embed-text:latest",
ltmOllamaUrl: process.env.YTSEJAM_LTM_OLLAMA_URL,
```

(Import `parseLtmEmbedderMode` from `./memory/embedder.ts`.)

### Step 3: Wire the factory into `server/src/index.ts`

Replace the existing:

```ts
ltm = MemorySystem.open({ storeDir: ltmStoreDir });
```

With:

```ts
const embedderResult = await createLtmEmbedder(authStore, {
  mode: config.ltmEmbedderMode,
  cacheDir: config.ltmEmbedderCacheDir,
  copilot: { model: config.ltmCopilotModel, baseUrl: config.ltmCopilotUrl },
  ollama: { model: config.ltmOllamaModel, baseUrl: config.ltmOllamaUrl },
});
console.log(`[ltm] embedder: ${embedderResult.label} (${embedderResult.dimension}-dim)`);
ltm = MemorySystem.open({ storeDir: ltmStoreDir, embedder: embedderResult.embedder });

// Dimension-mismatch refusal
const existingDim = ltm.indexDimension();   // see Step 4 if this method doesn't exist
if (existingDim !== undefined && existingDim !== embedderResult.dimension) {
  console.error(
    `[ltm] embedder dimension mismatch: store has ${existingDim}-dim vectors but ` +
      `${embedderResult.label} produces ${embedderResult.dimension}-dim. ` +
      `Run: node server/src/index.ts ltm replay --force`,
  );
  process.exit(1);
}
```

### Step 4: Add `MemorySystem.indexDimension()` if missing

Check `packages/ltm/src/api/memory-system.ts` — does it expose a method returning the current vector index dimension (or `undefined` if empty)? If not, add one (small surface — reads the semantic store's vector dim).

Tests: a unit test in `packages/ltm/test/memory-system.test.ts` (or wherever fits) verifying `indexDimension()` returns `undefined` for a fresh store and returns the embedder's dimension after the first observation.

### Step 5: Wire the factory into `server/src/cli/ltm-commands.ts`

Same pattern as the server. Construct an `authStore` (the CLI already does this — see lines 40-50) and feed the factory the same way. The dimension-mismatch check in `ltm health` and `ltm replay` (when NOT `--force`) should also refuse and print the remediation.

When `--force` is passed to `ltm replay`, the dimension mismatch is the EXPECTED state — that's why the user is running replay. Skip the refusal in that branch.

### Step 6: Integration test for dimension-mismatch refusal

`server/test/server-embedder-startup.test.ts`:

1. Create a temp LTM store dir. Open with `HashEmbedder` and record one observation. Close.
2. Construct a fake embedder with a different dimension (e.g. 1024 — distinct from Hash's 256).
3. Invoke the factory + the dimension-mismatch check directly (extract it as a helper if needed for testability). Assert it throws with a message containing `"ltm replay --force"`.

### Step 7: Run gate

Run: `bash scripts/gate.sh`
Expected: PASS.

### Step 8: Commit

```bash
git add server/src/index.ts \
        server/src/cli/ltm-commands.ts \
        server/src/config.ts \
        server/test/server-embedder-startup.test.ts \
        packages/ltm/src/api/memory-system.ts \
        packages/ltm/test/memory-system.test.ts
git commit -m "feat(server): wire LTM embedder factory + dimension-mismatch refusal"
```

---

## Task 6: Deploy config + documentation

**Files:**
- Modify: `deploy/dev.sh` (set `YTSEJAM_LTM_EMBEDDER=auto`)
- Modify: prod env template if one exists (look in `deploy/` — set `YTSEJAM_LTM_EMBEDDER=copilot`)
- Modify: `AGENTS.md` (add a breadcrumb to the design doc)

### Step 1: Update `deploy/dev.sh`

Add `export YTSEJAM_LTM_EMBEDDER=auto` to the env-var block in `deploy/dev.sh`. Document inline: `# dev: auto-probes Copilot → Ollama → Hash; prod pins copilot.`

### Step 2: Check for prod env template

Look for `deploy/ytsejam.env.example` or similar. If present, add `YTSEJAM_LTM_EMBEDDER=copilot` with a comment. If not, document the env var in the design doc's Configuration section and note that the live `~/.ytsejam/ytsejam.env` will need it set by Brian before the cutover.

### Step 3: AGENTS.md breadcrumb

Add a one-line pointer under whatever section lists runtime config: `LTM embedder is selected by the runtime factory at server/src/memory/embedder.ts (env: YTSEJAM_LTM_EMBEDDER). See docs/plans/2026-06-14-copilot-embedder-design.md.`

### Step 4: Verify gate one more time

Run: `bash scripts/gate.sh`
Expected: PASS.

### Step 5: Commit

```bash
git add deploy/dev.sh deploy/*.env.example AGENTS.md
git commit -m "docs: deploy config + AGENTS breadcrumb for LTM embedder factory"
```

---

## Final verification + ship

After Task 6:

1. Re-run full gate: `bash scripts/gate.sh` — PASS expected.
2. Optional live smoke (Brian-only, opt-in): `LTM_COPILOT_LIVE=1 cd packages/ltm && npm test` — would hit real Copilot, requires `GITHUB_COPILOT_API_KEY` in env. **Skip in autonomous mode** — credential plumbing is wrong shape for unattended CI, and the mocked-fetch tests cover the contract.
3. Push the branch, open the PR, merge on green. Do NOT restart the live ytsejam service (per Brian's instruction).
4. PR body must include the operator runbook for cutover:
   - Restart service → expect dimension-mismatch refusal with the `ltm replay --force` command.
   - Run `node server/src/index.ts ltm replay --force` (re-embeds the store under Copilot, takes seconds-to-minutes).
   - Restart again → expect green startup + `[ltm] embedder: copilot:text-embedding-3-small (1536-dim)` log line.

## YAGNI cuts honored

- No retry policy beyond the one-shot 401.
- No batching.
- No side-by-side LTM stores.
- No auto-replay on dimension change.
- No persistence of the discovered dimension (re-probed each boot — one HTTP call, cheap).
