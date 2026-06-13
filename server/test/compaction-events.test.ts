import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeReactiveCompactionFaux() {
  return registerFauxProvider({
    provider: "openai",
    models: [{ id: "faux", contextWindow: 40_000, maxTokens: 256 }],
  });
}

function withReactiveCompactionEnv(dataDir: string): () => void {
  const prevDataDir = process.env.YTSEJAM_DATA_DIR;
  const prevMemoryDir = process.env.YTSEJAM_MEMORY_DIR;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.YTSEJAM_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = "test-key-for-faux-compaction";
  delete process.env.YTSEJAM_MEMORY_DIR;
  return () => {
    if (prevDataDir === undefined) delete process.env.YTSEJAM_DATA_DIR;
    else process.env.YTSEJAM_DATA_DIR = prevDataDir;
    if (prevMemoryDir === undefined) delete process.env.YTSEJAM_MEMORY_DIR;
    else process.env.YTSEJAM_MEMORY_DIR = prevMemoryDir;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
  };
}

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("compaction events", () => {
  test("reactive compaction emits compaction_start then compaction_end{succeeded}", async () => {
    faux.unregister();
    faux = makeReactiveCompactionFaux() as any;
    const { manager, bus, dataDir } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const restoreEnv = withReactiveCompactionEnv(dataDir);

    try {
      faux.setResponses([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 50000 tokens > 40000 maximum",
        }),
        fauxAssistantMessage("Summary of compacted overflow."),
        fauxAssistantMessage("Recovered after reactive compaction"),
      ]);

      const row = await manager.createSession();
      await manager.sendMessage(row.id, "trigger overflow");
      await waitFor(() =>
        events.some(
          (e) =>
            e.type === "agent" &&
            e.sessionId === row.id &&
            (e as any).event.type === "message_end" &&
            JSON.stringify((e as any).event.message ?? "").includes("Recovered"),
        ),
      );
      await manager.waitForIdle(row.id);

      const starts = events.filter((e) => e.type === "compaction_start");
      const ends = events.filter((e) => e.type === "compaction_end");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toEqual({ type: "compaction_start", sessionId: row.id, trigger: "reactive" });
      expect(ends).toHaveLength(1);
      expect(ends[0]).toEqual({ type: "compaction_end", sessionId: row.id, status: "succeeded" });

      // Ordering: start strictly before end
      const startIdx = events.findIndex((e) => e.type === "compaction_start");
      const endIdx = events.findIndex((e) => e.type === "compaction_end");
      expect(startIdx).toBeLessThan(endIdx);

      // isCompacting is false after the dust settles
      expect(manager.isCompacting(row.id)).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  test("reactive retry exhaust surrenders without a paired compaction_end (design gap, pinned)", async () => {
    faux.unregister();
    faux = makeReactiveCompactionFaux() as any;
    const { manager, bus, dataDir } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const restoreEnv = withReactiveCompactionEnv(dataDir);

    try {
      faux.setResponses([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 50000 tokens > 40000 maximum",
        }),
        fauxAssistantMessage("Summary."),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 50001 tokens > 40000 maximum",
        }),
      ]);

      const row = await manager.createSession();
      await manager.sendMessage(row.id, "overflow twice");
      await waitFor(() =>
        events.some(
          (e) =>
            e.type === "agent" &&
            e.sessionId === row.id &&
            (e as any).event.type === "turn_end" &&
            JSON.stringify((e as any).event.message ?? "").includes("Diagnostic: prompt was ~"),
        ),
      );
      await manager.waitForIdle(row.id);

      // The first compaction succeeded — that compaction_end was emitted.
      const ends = events.filter((e) => e.type === "compaction_end");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({
        type: "compaction_end",
        sessionId: row.id,
        status: "succeeded",
      });

      // The retry-exhaust surrender path is observable via the assistant
      // diagnostic message, NOT via a compaction_end{surrendered}. This pins
      // the documented design gap: surrender after the prior compaction already
      // cleared the flag makes markCompactionEnd's idempotence guard a no-op.
      // See docs/plans/2026-06-13-compaction-pill-design.md, Open Questions.
      const surrenderMsgs = events.filter(
        (e) =>
          e.type === "agent" &&
          e.sessionId === row.id &&
          JSON.stringify((e as any).event.message ?? "").includes("Diagnostic: prompt was ~"),
      );
      expect(surrenderMsgs.length).toBeGreaterThan(0);
      expect(ends.some((e) => (e as any).status === "surrendered")).toBe(false);

      expect(manager.isCompacting(row.id)).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  test("session_meta payload includes compacting field", async () => {
    const { manager, bus } = makeManager(faux);
    const seen: ServerEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const row = await manager.createSession();
    await manager.rename(row.id, "renamed");
    const meta = seen.find((e) => e.type === "session_meta") as any;
    expect(meta).toBeTruthy();
    expect(typeof meta.session.compacting).toBe("boolean");
    expect(meta.session.compacting).toBe(false);
  });
});
