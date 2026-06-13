import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, fauxToolCall, makeManager, setupFaux } from "./helpers.ts";

function makeProactiveCompactionFaux() {
  return registerFauxProvider({
    provider: "openai",
    models: [{ id: "faux", contextWindow: 40_000, maxTokens: 256 }],
  });
}

function withCompactionEnv(dataDir: string): () => void {
  const prev = {
    YTSEJAM_DATA_DIR: process.env.YTSEJAM_DATA_DIR,
    YTSEJAM_MEMORY_DIR: process.env.YTSEJAM_MEMORY_DIR,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    YTSEJAM_COMPACTION_ENABLED: process.env.YTSEJAM_COMPACTION_ENABLED,
  } as const;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = "test-key-for-faux-compaction";
  process.env.YTSEJAM_COMPACTION_ENABLED = "true";
  delete process.env.YTSEJAM_MEMORY_DIR;
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }
  };
}

function readDevLog(dataDir: string): string {
  const path = join(dataDir, "memory", "projects", "ytsejam", "dev-log.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("compaction inner-loop e2e", () => {
  test("inner-loop hook fires compact() mid-loop and writes a compactionSummary entry (#70 regression)", async () => {
    // SWAP to the proactive-compaction faux (40k context window, openai provider)
    faux.unregister();
    faux = makeProactiveCompactionFaux() as any;

    // Wire a trivial no-op "ping" tool so turn 1 can issue a tool call,
    // triggering pi's loop to continue into turn 2 after the tool result.
    // sessionTools is per-session (the existing convention used by manager.test.ts:477).
    const pingTool = (sessionId: string) => ({
      name: "ping",
      label: "Ping",
      description: "no-op tool used by the e2e test",
      parameters: { type: "object", properties: {} } as any,
      execute: async () => ({
        content: [{ type: "text" as const, text: `pong:${sessionId}` }],
        details: {},
      }),
    });

    const { manager, bus, dataDir } = makeManager(faux, {
      sessionTools: (id) => [pingTool(id) as any],
    });
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const restoreEnv = withCompactionEnv(dataDir);
    try {
      // Three faux responses in order:
      //   #1: turn 1 assistant calls the ping tool (loop continues to turn 2 after tool result)
      //   #2: compaction summary (fired by inner-loop hook before turn 2's LLM call)
      //   #3: turn 2 assistant response (with compacted context)
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("ping", {})]),
        fauxAssistantMessage("MOCK_COMPACTION_SUMMARY_TOKEN_xyz123"),
        fauxAssistantMessage("post-compaction-response-token-abc456"),
      ]);

      const row = await manager.createSession();

      // Capture `opened` for in-test arming
      const opened = (manager as any).open.get(row.id);
      expect(opened.compaction).toBeDefined();

      // Arm pendingCompaction AS SOON AS the first turn_end arrives for this
      // session. This mimics how production's handleCompactionTurnEnd arms
      // from decideCompaction at L441-448 of manager.ts — except we skip the
      // token-estimation step and inject the pending flag directly so the test
      // doesn't have to forge a 128KB+ assistant response to trip the threshold.
      let armed = false;
      bus.subscribe((e) => {
        if (armed) return;
        if (e.type !== "agent") return;
        if (e.sessionId !== row.id) return;
        if ((e as any).event.type !== "turn_end") return;
        armed = true;
        opened.compaction.pendingCompaction = {
          trigger: "proactive",
          reason: "isThresholdExceeded",
          tokensBefore: 32_000,
          budget: 38_000,
        };
      });

      await manager.sendMessage(row.id, "trigger-inner-loop-compaction");

      // Wait for the post-compaction response to be persisted (proves we got
      // through compaction AND past it into turn 2's response)
      await waitFor(() =>
        events.some((e) =>
          e.type === "agent" &&
          e.sessionId === row.id &&
          (e as any).event.type === "message_end" &&
          JSON.stringify((e as any).event.message ?? "").includes("post-compaction-response-token-abc456"),
        ),
      );
      await manager.waitForIdle(row.id);
      await new Promise((r) => setTimeout(r, 50)); // dev-log writer tick

      // === ASSERTIONS ===

      // Hard proof #1: armed flag was set (turn_end fired and our handler ran)
      expect(armed).toBe(true);

      // Hard proof #2: THREE faux LLM calls happened — turn 1 + compaction + turn 2.
      // If the inner-loop hook were inert (v1 bug), only 2 calls would happen
      // (turn 1 + turn 2 with un-compacted context).
      expect(faux.state.callCount).toBe(3);

      // Hard proof #3: pendingCompaction was cleared by the orchestrator
      expect(opened.compaction.pendingCompaction).toBeNull();

      // Hard proof #4: a compactionSummary entry exists in the session JSONL
      const messages = await manager.getMessages(row.id);
      const compactionEntry = messages.find(
        (m: any) => m.role === "compactionSummary",
      ) as any;
      expect(compactionEntry).toBeTruthy();
      expect(compactionEntry.summary).toContain("MOCK_COMPACTION_SUMMARY_TOKEN_xyz123");

      // Hard proof #5: post-compaction response made it into the session
      expect(
        messages.some((m: any) =>
          JSON.stringify(m.content ?? "").includes("post-compaction-response-token-abc456"),
        ),
      ).toBe(true);

      // Hard proof #6: dev-log records via=inner_loop (entryPoint plumbing proof)
      const devLog = readDevLog(dataDir);
      expect(devLog).toContain("via=inner_loop");
      expect(devLog).toContain("compaction in session " + row.id);
    } finally {
      restoreEnv();
    }
  });
});
