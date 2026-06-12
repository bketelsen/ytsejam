# Release-Workflow — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Trace Renamed Fields To Downstream Consumers

When renaming any field that crosses a serialization or external boundary (e.g.
the ytsejam `CompactionEvent.tokensAfter` → `tokensAfterEstimated` rename), do
not scope the brief to `server/src/` and `server/test/` alone — grep the whole
repo for both the code identifier and its serialized form (`tokensAfter` and
`tokens_after`) including `*.md`, `deploy/`, and `web/`, because user-facing
schema docs like `deploy/README.md` are the only description of the
`.compactions.jsonl` shape and silently drift otherwise. Per
`docs/agents/architecture.md`, surface a changed semantic in three places
including a user-facing doc. Where a rename leaves a deliberately asymmetric
line at a third-party/`any`-typed membrane — such as the
`tokensAfter: tokensAfterEstimated` enrichedEntry literal in `manager.ts:513`
and `task-manager.ts:392`, where `buildCompactionEvent` reads
`compactionEntry?.tokensAfter` back — add a verbatim guard comment
(`// key stays pi-shape; buildCompactionEvent reads compactionEntry?.tokensAfter`),
since no type checks the key name and a future "consistency" rename would
type-check yet fall through to `?? 0`, reintroducing the issue #72 zero/
wrong-token bug. Also update docstrings inside the functions you touch — e.g.
`formatDevLogLine` at `compaction.ts:271` must show `ctx <before>→~<after> tokens`
to match emitted output.

_Added: 2026-06-12 | Task: Pure rename of CompactionEvent.tokensAfter to tokensAfterEstimated_
