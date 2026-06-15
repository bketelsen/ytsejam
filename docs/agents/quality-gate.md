# Quality gate

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Script: `scripts/gate.sh`.

`scripts/gate.sh` is **the single authoritative quality check for the repo** — every other gate
(CI, deploy-time checks, agent self-verification) runs this same script. `AGENTS.md` states it must
pass before any PR. Treat a green gate as the precondition for landing or deploying anything.

CI runs the gate on every pull request and every push to `main` via
[`.github/workflows/gate.yml`](../../.github/workflows/gate.yml) — `actions/setup-node@v4` (Node 22)
+ `npm ci` (whose `postinstall: patch-package` hook applies vendor patches automatically) +
`bash scripts/gate.sh`. The workflow has a 15-minute timeout and uses concurrency cancellation so a
new push to a PR cancels its in-flight run. **The workflow is intentionally thin** — all the actual
gating logic lives in `scripts/gate.sh`, so CI and local runs diverge only on environment, never on
contract.

## What it runs, in order

From the repo root (the script `cd`s there itself), each step under `env -u NODE_ENV` so an inherited
`NODE_ENV=production` can't make npm skip the devDependencies (`vitest`/`vite`/`tsc`) the checks need:

1. **Typecheck (server + ltm)** — `npm run check` → `npm run check --workspace server && npm run
   check --workspace ltm` → `tsc --noEmit` in each. LTM is the `packages/ltm/` workspace; the cog→LTM
   bridge surface in `server/` references its public types, so they're typechecked together.
2. **Server tests** — `npm test --workspace server` → `vitest --run` (faux LLM provider, no network).
3. **LTM tests** — `npm test --workspace ltm` → `vitest --run` (the LTM engine's own suite —
   episodic/semantic store, decay, consolidation, the `MemorySystem` open/close + lock semantics
   the bridge depends on).
4. **Web build + typecheck** — `npm run build --workspace web` → `tsc -b && vite build`. The web
   typecheck is part of the build (`tsc -b`), so a type error here fails the build step.
5. **Web tests** — `npm test --workspace web` → `node test/run.mjs` (custom runner: theme/contrast,
   message-flow, transcript, time). The theme test (`web/test/theme.test.mjs`) fails the build on any
   raw Tailwind palette class in `src/**/*.tsx` and checks WCAG AA contrast — see `web/CLAUDE.md`.

On success it prints `=== gate: PASSED ===` and exits 0.

## How to interpret a failure

- **The exit code is the only signal.** The script is `set -euo pipefail`, so it stops at the first
  failing step and exits non-zero. Agents and `deploy` check the exit code, not the output banners.
- The last `=== gate: <step> ===` banner before the failure tells you which step broke; the failing
  tool's own output (tsc diagnostics, vitest assertions, vite errors) follows it.
- A **docs-only or other non-code change should pass trivially.** If it fails, the failure is almost
  certainly pre-existing/environmental (e.g. missing `node_modules` — the gate **validates, it does not
  install**; deps must already be present) — investigate rather than papering over it.

## When to run it

- Before opening a PR (mandatory, per `AGENTS.md`).
- Before `deploy/deploy.sh` (deploy does **not** run the gate; it's a separate pre-deploy bar).
- After any change to `server/src/**`, `web/src/**`, or the build/test config.
- As a subagent's final verification step when it edited code — but mind the install gotcha below.

## Install gotcha (subagents / fresh worktrees)

The gate **does not install dependencies** — it assumes `node_modules` is present and only runs the
checks. In a fresh checkout/worktree you must install first. Under the harness shell, `NODE_ENV` is
`production`, so a bare `npm install`/`npm ci` skips the devDeps the gate needs. Either:

- symlink `node_modules` (root, `server/`, `web/`) from a known-good checkout, or
- install with `env -u NODE_ENV npm ci --include=dev` (mirrors `deploy/deploy.sh`).

The gate itself already clears `NODE_ENV` for each step, so once deps exist, `bash scripts/gate.sh`
works regardless of the inherited environment. See [`delegation.md`](delegation.md) → the worktree
gotcha.

## Extending the gate

`scripts/gate.sh` is intentionally a flat list of `echo` banner + command pairs (the `create-gate`
skill's template). If you add a real check the project should always enforce (a lint, a new test
suite), add it here as another banner+command and keep `env -u NODE_ENV` on it. Don't add checks that
aren't genuinely required to land — the gate's value is that green means landable.
