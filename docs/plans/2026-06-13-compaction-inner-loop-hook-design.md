# Design: Inner-loop proactive compaction (issue #70)

**Branch:** `compaction-inner-loop-hook`
**Issue:** [#70](https://github.com/bketelsen/ytsejam/issues/70)
**Status:** Approved 2026-06-13 (revised 2026-06-13 to use the `context` hook instead of `shouldStopAfterTurn` — see §3)
**Predecessor:** PR #71 (context-window compaction + overflow recovery)

## 1. Problem statement

Proactive compaction currently fires only at message-arrival idle boundaries (`runPendingCompactionAtIdle`, called from `sendMessage`/`injectMessage`). Within a single autonomous run (long reviewer turns, cross-domain housekeeping loops, multi-tool subagent dispatches), accumulation crosses the model's context window before the loop ever returns to idle. The reactive backstop catches the resulting API `400 model_max_prompt_tokens_exceeded` and retries, so the user gets an error-then-retry flicker on every long autonomous run instead of the documented "proactive primary + reactive backstop" behavior (design doc §3.1 of PR #71).

We need a way for compaction to fire **between turns of an autonomous run**, not just at idle.

## 2. Justify-server-change

Per the harness-check rule (cog `patterns.md` / `wiki/topics/harness-check`), any plan crossing `server/src/` earns a written justification:

- **What it lets the harness DO that a skill can't:** intercept pi-agent-core's inner loop between turns. A markdown skill cannot reach inside the agent loop; only a `pi-agent-core` hook subscription can.
- **What friction it removes:** the user-visible error-then-retry flicker on every long autonomous run. The reactive backstop becomes a true backstop instead of the de-facto primary trigger.
- **Why not extend an existing skill:** no skill has access to the loop. The hook is the only mechanism.
- **What we do NOT add:** no new config keys, no new helper, no new public API surface, no new SSE event type, no new session message role. We add one event-subscription handler and call one existing private method (`runPendingCompactionAtIdle`).

## 3. Architecture

### 3.1 Why not `shouldStopAfterTurn` (the original choice)

The issue text and the initial design proposed `pi-agent-core`'s `AgentLoopConfig.shouldStopAfterTurn` hook — awaited after every `turn_end`, between `prepareNextTurn` and the next iteration. Reading the upstream code (`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js:350-396`) shows that `AgentHarness` (the wrapper ytsejam uses, not raw `agentLoop`) **hardcodes `prepareNextTurn` inside its private `createLoopConfig()` and does not expose `shouldStopAfterTurn` to consumers at all**. ytsejam never passes either hook to the harness — it uses the event-subscribe model (`harness.subscribe(...)`) for `turn_end` and friends, and subscribe listeners are fire-and-forget (return value ignored by the loop).

Three forks from there:
1. **Use the existing `context` hook event.** Pre-turn, awaited, return value mutates the context. (Chosen — see §3.2.)
2. **Patch pi-agent-core to expose `shouldStopAfterTurn`.** Adds upstream-patch maintenance burden on every pi-agent-core upgrade. Bandaid-y per Brian's "right way" principle.
3. **Send an upstream PR.** Right long-term, unbounded timeline; not a path to closing #70.

### 3.2 Chosen mechanism: the `context` hook

`pi-agent-core` exposes a `context` event via `AgentHarness.subscribe(...)`. From `agent-harness.js:356-359`:

```ts
transformContext: async (messages) => {
  const result = await this.emitHook({ type: "context", messages: [...messages] });
  return result?.messages ?? messages;
},
```

The hook is:
- **Awaited** by the loop (synchronous semantics from the loop's POV).
- **Fires before each turn's LLM call** — including between turns of an autonomous run.
- **Can mutate the context** — returning `{messages: [...]}` replaces the in-flight context.

This is the only consumer-accessible point that (a) runs between turns and (b) can synchronously block to do compaction first. Timing shifts from "after `turn_end` + before next turn" to "before next turn" — semantically identical for our purpose.

### 3.3 Wiring

Single behavioral change at two locations — `server/src/manager.ts` and `server/src/task-manager.ts` both build `AgentHarness` instances and both subscribe to harness events. Both need the new handler.

In `onHarnessEvent` (manager.ts:265+) and the analogous handler in task-manager.ts, add a new event-type branch:

```ts
if (event.type === "context" && opened.compaction) {
  // Inner-loop proactive compaction trigger. Mirrors the idle-path entry
  // (runPendingCompactionAtIdle from sendMessage/injectMessage) but runs
  // between turns of an autonomous run — before each turn's LLM call.
  const ok = await this.runPendingCompactionAtIdle(opened, "inner_loop");
  if (!ok) {
    // Surrender: emit surrender message into the context the LLM will see
    // this turn so it sees the final state and stops naturally. The session
    // already has the surrender message appended by emitCompactionSurrender.
    return { messages: [...event.messages, buildSurrenderContextMessage(opened)] };
  }
  // Happy path: context unchanged. pi-agent-core's transformContext sees
  // no return value (or our explicit `undefined`) and uses the original.
}
```

The exact return-value mechanism for `subscribe` handlers feeding back into `emitHook` is verified during PR 2 (see §10 — implementation note 1). If `subscribe` listeners cannot return a `ContextResult`, PR 2 switches to a direct `harness.onHook("context", handler)` registration if one is exposed, or falls back to the patch-package option (§3.1 fork 2) with the cost trade-off accepted.

`runPendingCompactionAtIdle` already:
- no-ops if `pendingCompaction` is null
- runs the compaction
- records the event
- emits the surrender message into the session and returns `false` on surrender
- returns `true` otherwise

The threshold check at `turn_end` (which sets `pendingCompaction` when the model's context window is crossed) is already in place from PR #71 and is unchanged.

### 3.4 Surrender semantics

Per the option-A2 choice during brainstorming: on inner-loop surrender, the handler returns a context with a surrender notice appended (so the LLM sees its prior state ended in surrender and stops naturally) AND the existing `emitCompactionSurrender` records the surrender message into the session for the persistence trail. The autonomous run terminates with the surrender message as the final assistant turn.

The alternative (return unchanged context, let the next LLM call hit the over-budget context and trigger the reactive backstop) was rejected because it defeats half the point of the fix — the user would still see the reactive-path round-trip on surrender.

The session is left in a state where the next user `sendMessage` will trip the idle-path surrender (already-emitted message, already-set state) — i.e., the user will see another surrender notice and the message won't go through. This matches existing idle-path behavior and remains correct (over-budget session, can't accept new turns until cleared).

## 4. Telemetry — `entryPoint` field

Add `entryPoint: "idle" | "inner_loop" | "reactive_path"` to `CompactionEvent` in `server/src/compaction.ts`. **Orthogonal** to the existing `trigger: "proactive" | "reactive"` field:

| Field | Meaning |
|---|---|
| `trigger` | *Why* compaction was needed — threshold check (`"proactive"`) vs. API 400 (`"reactive"`) |
| `entryPoint` (new) | *Where* the compaction was actually fired — `"idle"` (sendMessage/injectMessage), `"inner_loop"` (the new context-hook handler), `"reactive_path"` (reactive recovery) |

After this change:
- `trigger:"proactive" + entryPoint:"inner_loop"` is the new behavior we want to observe in prod
- `trigger:"proactive" + entryPoint:"idle"` is the pre-#70 behavior; should now be rare on long autonomous runs
- `trigger:"reactive" + entryPoint:"reactive_path"` is the (now-rarer) backstop catching mode-B accumulation

Threaded through the three call sites:
- `runPendingCompactionAtIdle(opened, entryPoint)` accepts the new parameter
- callers (idle-path in `sendMessage`/`injectMessage`, the new inner-loop hook, the reactive recovery path) pass their respective values
- `buildCompactionEvent` propagates it onto the `CompactionEvent`
- written to `<sessionFilePath>.compactions.jsonl` (snake_case: `entry_point`) and reflected in the dev-log line
- `formatDevLogLine` appends `via=<entryPoint>` to the existing line for human-readable narrative

Type-level: `CompactionEvent.entryPoint` is **required** (not optional) — every recorded event MUST identify its source, no silent defaults.

## 5. Frontend safety (per the #73 lesson)

Explicit non-regression posture:

- `CompactionEvent` is server-internal. Verified zero references in `web/src/` (`grep -r CompactionEvent web/src` → no hits). It is emitted to `<sessionFilePath>.compactions.jsonl` and the dev-log — never sent to the web client, no API route exposes it, no SSE/WebSocket payload includes it. **Adding a field to it cannot reach the frontend.**
- **No new session message role.** The surrender message reuses the existing `role:"assistant"` shape with a text part unchanged. The context-hook surrender-message-injection is a transient in-memory wrap of the existing message shape, not a new role.
- **No new SSE event type** or API field exposed to the web.
- **Gate guard:** `scripts/gate.sh` runs web build + web typecheck + web tests. Plan requires the gate to pass green before each PR.

## 6. Testing

Three test additions:

### Unit (`server/test/compaction.test.ts`)
- `context-hook handler invokes runPendingCompactionAtIdle and returns undefined (unchanged context) in happy path` — verifies the wiring with a mocked `OpenSession`
- `context-hook handler returns context with surrender notice on surrender` — verifies the mutated-context return shape
- `context-hook handler is a cheap no-op when pendingCompaction is null` — guards against per-turn overhead
- `entryPoint field flows through to the recorded CompactionEvent for each of the three call sites` — three sub-cases, each asserting the right value on the resulting event

### Integration (`server/test/compaction.integration.test.ts`)
- `inner-loop compaction fires between turns of an autonomous run` — drive `AgentHarness` with a fake LLM stream emitting N synthetic turns that cross the threshold mid-run; spy on the compaction event recorder; assert it fires before `agent_end` (i.e., between turns, not after idle)
- `inner-loop surrender terminates the autonomous run cleanly` — same setup forced into surrender via low context window; assert loop ends with surrender message as final turn
- `recorded event carries trigger:"proactive" + entryPoint:"inner_loop"` — telemetry shape check

### Regression
- The existing idle-path tests at `server/test/compaction.test.ts:917-971` get one extra assertion each: `entryPoint === "idle"` on the recorded event. Guards against refactor pressure to move logic out of `runPendingCompactionAtIdle` when wiring the second caller.
- One assertion that no new message-role values appear in the session JSONL after an inner-loop compaction (#73 frontend-safety regression).

### Gate
`scripts/gate.sh` (server typecheck + server tests + web build + web typecheck + web tests) MUST pass before each PR. This includes the regression suites from PRs #71/#72/#73/#79/#83/#85 — the entire compaction history.

## 7. Risk and rollback

- **Kill switch:** the existing `YTSEJAM_COMPACTION_ENABLED=false` already disables all compaction; the new handler reads through the same gate (the `if (event.type === "context" && opened.compaction)` guard — `opened.compaction` is only set when `compactionEnabled()` is true, see manager.ts:255-260).
- **Blast radius:** the change introduces mid-loop async work that didn't exist before. Mitigations:
  - The hook is awaited by pi-agent-core (synchronous semantics from the loop's POV); no parallel state mutation.
  - No new shared locks. The only mutated state is `opened.compaction.pendingCompaction`, which `runPendingCompactionAtIdle` already clears eagerly with the comment `// Clear flag eagerly so concurrent triggers don't double-fire`.
  - Pi-agent-core's `transformContext` already handles a hook that mutates messages; we're not exercising a new code path on their side.
- **Self-modification hazard:** this agent runs as the live ytsejam process. Source edits to `~/projects/ytsejam` are safe; the cutover (deploy + restart) is Brian's deliberate act, not part of the merge.
- **Concurrency with idle-path:** can the inner-loop hook AND `sendMessage`/`injectMessage` both try to compact simultaneously? Not within a single session — `sendMessage` returns `busy` (or steers) while a run is in progress, so the two callers are serialized.
- **task-manager parity:** the wiring change goes into BOTH `manager.ts` and `task-manager.ts` (both build `AgentHarness` instances, both have the same problem). The plan must explicitly cover both — a one-sided fix would leave subagent tasks crashing on the API 400.

## 8. Out of scope

- Re-architecting the trigger model (the "fire compaction inline at `turn_end` instead of deferring to next idle" option from the original scope question — explicitly punted).
- Exposing compaction events to the frontend (no UI requirement; observability is dev-log + side-file).
- Per-trigger configurable thresholds.
- Touching the existing `prepareNextTurn` handler (it's hardcoded inside pi-agent-core's `createLoopConfig` and not consumer-modifiable anyway).
- Updating dev-log narrative format beyond appending `via=<entryPoint>` to the existing line.
- Sending an upstream PR to expose `shouldStopAfterTurn` (future-considered; not blocking #70).

## 9. Implementation notes for the plan

Suggested PR shape (write-plan will refine):

1. **PR 1: telemetry plumbing.** Add `entryPoint` to `CompactionEvent` and thread it through `runPendingCompactionAtIdle`, the reactive path, and all two current callers (idle from manager + task-manager). All values are `"idle"` or `"reactive_path"` at this point — no behavior change, just instrumentation. Tests: unit coverage for the new field flowing through. Gate green. Brian merges.

2. **PR 2: inner-loop hook.** Add the `context` event handler on both `manager.ts` and `task-manager.ts` `onHarnessEvent` switches. The third `entryPoint` value (`"inner_loop"`) starts being recorded. **First task in PR 2 is a 20-minute spike:** verify that `harness.subscribe(...)` listeners can return a `ContextResult` that pi-agent-core's `transformContext` will honor. If they can't, PR 2 pivots to:
   - **2a:** check if `AgentHarness` exposes a direct `onHook` registration or a `transformContext` config option; or
   - **2b:** add a small patch to `patches/@earendil-works+pi-agent-core+*.patch` exposing the hook (we already use patch-package; one more patch is acceptable cost).

   Whichever path the spike picks, the rest of PR 2 is unchanged: surrender semantics, telemetry value, tests (unit + integration + #73 regression), gate green. Brian merges.

Splitting in two keeps each PR's diff small and the bisection bisectable if anything regresses in prod. The order of work (telemetry first, then behavior change) keeps each commit semantically clean.
