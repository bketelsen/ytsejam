import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fauxAssistantMessage,
  makeManager,
  setupFaux,
  waitFor,
} from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("AgentManager LTM ingest", () => {
  test("ingests the on-disk chat session JSONL after agent_end", async () => {
    const ltm = {
      ingestSessionFile: vi.fn(async (_path: string) => undefined),
    };
    const { manager } = makeManager(faux, { ltm });
    faux.setResponses([fauxAssistantMessage("reply for ltm ingest")]);

    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hello ltm");
    await manager.waitForIdle(row.id);

    await waitFor(() => ltm.ingestSessionFile.mock.calls.length === 1);
    expect(ltm.ingestSessionFile).toHaveBeenCalledTimes(1);
    expect(ltm.ingestSessionFile).toHaveBeenCalledWith(row.path);
    expect(existsSync(row.path)).toBe(true);
  });
});
