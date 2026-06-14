# Release-Workflow — Project Lessons

Rules learned from fix cycles. Cap: 30 entries — prune oldest if exceeded.

## Grep Both Code Identifier And Serialized Form For Renames

When renaming a field that crosses a serialization or external boundary, grep the whole repo for BOTH the code identifier (`tokensAfter`) AND the serialized form (`tokens_after`) — including `*.md`, `deploy/`, and `web/`. User-facing schema docs are often the only description of the on-disk shape and drift silently otherwise. Where the rename leaves a deliberately asymmetric line at a third-party / `any`-typed membrane, add a verbatim guard comment naming the read-back site, since no type checks the key name and a future "consistency" rename would type-check yet fall through to a zero-token bug.

(seen in: `CompactionEvent.tokensAfter` → `tokensAfterEstimated` rename — deploy/README.md was the sole `.compactions.jsonl` schema doc; manager.ts:513 and task-manager.ts:392 carry the pi-shape literal that `buildCompactionEvent` reads back)

_Added: 2026-06-12 | Task: Pure rename of CompactionEvent.tokensAfter to tokensAfterEstimated_
