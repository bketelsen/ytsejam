# Architecture — Project Lessons

Lessons learned from architecture-shaped failures and fix cycles in ytsejam.
Auto-appended by the lessons skill.

## Match Source Types In Skeleton Stubs

When porting a structural skeleton from a reference implementation (e.g. cogmemory's Go into `server/src/memory/`), treat the source as the spec for stub shapes and types — do not inject speculative `TODO` placeholders or narrowed union types where the source is unambiguous. In PR-0, `L0IndexResult.index` in `server/src/memory/types.ts` was typed `string | Record<string, unknown>[]` with a "define exact row shape" TODO, but the Go `MemoryStore.L0Index` returns `strings.Join(lines, "\n")` — a plain `string`, so it should be pinned to `string` with a comment noting a later PR may deliberately widen it. Similarly, keep invariants intact: the discipline grep in `server/src/memory/README.md` must include every token from the plan (`memory_root`, `ytsejam/data/memory`, and `chapterhouse/memory`) to guard the legacy live-store path during the two-track migration window. Faithfully mirroring the source removes uncertainty the source already resolved; reserve intentional improvements for the PR that actually implements the behavior.

_Added: 2026-06-12 | Task: PR-0 of "Fold cogmemory into ytsejam" plan_
