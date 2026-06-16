# Frontend — Project Lessons

Rules learned from fix cycles. Each entry is a rule a reader can apply without
re-reading the originating commit. Cap: 30 entries — prune oldest if exceeded.

## Guard Re-Entry With Refs Not State

A guard that reads render-closure state cannot block a second call sharing that same closure, since both see the stale pre-update value; use a mutable ref latch (set immediately, cleared in finally) for idempotency across double-fired handlers. (seen in: commitRename — guard correct only by React quirk)

_Added: 2026-06-16 | Task: Add a UI affordance to rename an active session in a Re | Occurrence: 1_
