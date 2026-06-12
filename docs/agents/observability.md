# Observability — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Snapshot Race-Cleared State Before Downstream Awaits

When code eagerly clears state for race-safety (e.g., `runCompactionIfPending` nulling `opened.compaction.pendingCompaction` before awaiting `harness.compact()`), treat that state as gone for any downstream or third-party listener — pi-agent-core's synchronous, awaited `session_compact` handler ran after the clear and read `null`, so observability silently fell back to `"proactive"` + `"session_compact fired"`, mislabeling every reactive compaction. Capture an explicit snapshot before clearing (`const pendingSnapshot = { ...pending }`), thread it through the return value (`RunCompactionResult.pending`), and write observability records caller-side after the orchestrator returns rather than inside the event handler. Keep the third-party event handler enrichment-only (caching `lastCompactionDetails`), since labels derived from live manager state inside it are inherently racy. Add a wiring test that asserts the snapshot drives the labels (trigger/reason/tokensBefore for the reactive case) — it catches this regression immediately. Generally: never derive observer-visible facts from mutable state that a race-safety clear has already destroyed; snapshot it and pass it explicitly.

_Added: 2026-06-12 | Task: Task 5: orchestrator + main-session wiring_
