# Architecture — Project Lessons

Lessons learned from architecture-shaped failures and fix cycles in ytsejam.
Auto-appended by the lessons skill.

## Match Source Types In Skeleton Stubs

When porting a structural skeleton from a reference implementation (e.g. cogmemory's Go into `server/src/memory/`), treat the source as the spec for stub shapes and types — do not inject speculative `TODO` placeholders or narrowed union types where the source is unambiguous. In PR-0, `L0IndexResult.index` in `server/src/memory/types.ts` was typed `string | Record<string, unknown>[]` with a "define exact row shape" TODO, but the Go `MemoryStore.L0Index` returns `strings.Join(lines, "\n")` — a plain `string`, so it should be pinned to `string` with a comment noting a later PR may deliberately widen it. Similarly, keep invariants intact: the discipline grep in `server/src/memory/README.md` must include every token from the plan (`memory_root`, `ytsejam/data/memory`, and `chapterhouse/memory`) to guard the legacy live-store path during the two-track migration window. Faithfully mirroring the source removes uncertainty the source already resolved; reserve intentional improvements for the PR that actually implements the behavior.

_Added: 2026-06-12 | Task: PR-0 of "Fold cogmemory into ytsejam" plan_

## Match Reference Port Or Document Divergence

When porting a reference implementation (here, cogmemory's Go store at `/home/bjk/projects/cogmemory/store/store.go` into `server/src/memory/store/`), treat the source as the spec and verify the brief against the actual source code before trusting it — a wrong brief produced the regex search regression (Go uses case-insensitive `strings.Contains`, not `new RegExp(query, "gim")`, which broke metacharacter literals and threw on inputs like `[unclosed`). Never silently weaken a ported primitive: match Go exactly, e.g. `atomicWrite()` in `fs.ts` must `fh.sync()` before rename to preserve the temp→sync→close→rename durability guarantee. When you do intentionally diverge (the `move()` allow-list tightening that closes a write-allow-list backdoor), keep the safer behavior but surface it at three places — a code comment/JSDoc, a user-facing doc (`docs/memory/FORMAT.md`), and a contract-locking regression test asserting both reject and accept cases. The meta-rule: silent drift from a reference port is worse than explicit, documented divergence; lock every semantic with regression tests (and cross-reference Go's tests like `TestSearchCaseInsensitive` in `PARITY.md`) so the cross-family review cycle catches drift before merge.

_Added: 2026-06-12 | Task: PR-1a of "Fold cogmemory into ytsejam" plan_

## Port Reference Edge Cases Not Just Happy Paths

When porting reference behavior (here the cogmemory Go controller in `server/src/memory/domain/`), port the edge cases the reference handles silently, not just the happy paths its API obviously serves — Go's `yaml.Unmarshal`, `filepath.Clean`, and `Sort` quietly cover cases TS does not. Specifically: match Go's nil-slice semantics with `raw.domains == null` (loose equality catches both `null` and `~`) in `manifest.ts`; have `cleanRel` in `controller.ts` resolve `..` by popping segments (throw `invalid path: escapes root` past root) since `validateWrite` is the membership-check door bouncer; and sort with byte order (`a.path < b.path`) not `localeCompare` to match Go on mixed-case/punctuation paths. Write tests that exercise these edges (all YAML spellings, `..` resolution and escape rejection, and the stale-error-then-valid-reload recovery cycle that clears `lastError`) because happy-path tests that mirror happy-path implementation will both pass while drift ships silently to PR-3 consumers. Also resist speculative surface (the dead `ActionTarget` alias, `_options` param) — verify zero external consumers with grep before deleting, consistent with the "bash+grep+LLM DNA" lean principle.

_Added: 2026-06-12 | Task: PR-1b of "Fold cogmemory into ytsejam" plan_

## Audit Cross Language Library Defaults And Contracts

When porting Go to TypeScript under `server/src/memory/consolidated/`, treat language-default behavior as a parity hazard: probe what Go's libraries actually do and match it or document the divergence. Three boundaries pass all-green tests yet drift silently — (1) library defaults like `eemeli/yaml` retaining `\r` where Go's `yaml.v3` strips it (fix: normalize CRLF→LF at the head of `parseFrontmatter` in `frontmatter.ts`), `localeCompare` vs Go's byte-wise `sort.Slice` (fix: add explicit `a.path < b.path` sorts in `glacier-index-compute.ts` and `wiki-index-compute.ts`); (2) inherited order/contracts — don't trust `store.list()` ordering, sort explicitly like each Go compute function does; (3) speculative permissiveness like the `category` YAML alias Go never reads (drop keys absent from Go fixtures). Always delegate to existing Go-faithful helpers (`store.l0Index()`, not a re-walk via `store.list()`) and match the brief's literal error strings (`unknown param key: <key>`). Lock every fix with a regression test that genuinely fails when reverted, and add parity comments to the most sensitive files naming the Go function they mirror.

_Added: 2026-06-12 | Task: PR-2c of "Fold cogmemory into ytsejam" plan_
