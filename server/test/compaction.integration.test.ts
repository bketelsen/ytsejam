/**
 * Gate-skipped integration test: real-LLM cutover-confidence smoke.
 *
 * Skipped by default. Run with:
 *   INTEGRATION=1 env -u NODE_ENV npx vitest run server/test/compaction.integration.test.ts --run --no-coverage
 *
 * Requires provider credentials for the selected real model (for example,
 * ANTHROPIC_API_KEY when using an anthropic/* model) and a usable pi auth
 * configuration if the provider requires one.
 *
 * Purpose: verify the compaction wiring works against a real provider before
 * cutover. This is NOT primary regression coverage: compaction.test.ts covers
 * the policy module and task-manager.test.ts covers the subagent state machine
 * end-to-end via pi's faux provider.
 *
 * This file intentionally uses it.todo placeholders rather than issuing a live
 * provider call. The production Anthropic models currently used by ytsejam have
 * very large context windows (for example, Sonnet 4.6 is 1M tokens), so crossing
 * the calibrated proactive threshold against the real model would require an
 * impractically large prompt. The deterministic regression layer already covers
 * compaction + retry behavior with a small faux contextWindow; this scaffold
 * documents the manual smoke contract for a real-provider cutover check.
 */

import { describe, it } from "vitest";

const INTEGRATION = process.env.INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("compaction integration (real provider)", () => {
  it.todo("compacts a real main session once a controlled synthetic budget crosses the proactive threshold");

  it.todo("recovers from a real-provider context-overflow error by compacting and retrying the turn once");

  it.todo("records the real compaction in the per-session compactions JSONL and cog dev-log");

  it.todo("leaves the compacted real-provider session reloadable after the backup/verify chain runs");
});
