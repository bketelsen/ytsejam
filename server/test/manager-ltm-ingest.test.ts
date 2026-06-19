import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
      ingestSessionFile: vi.fn(async (_path: string) => ({
        sessionsSeen: 1,
        turnsIngested: 1,
        recordsCreated: 1,
        warnings: [],
      })),
    };
    const { manager, dataDir } = makeManager(faux, { ltm: () => ltm });
    faux.setResponses([fauxAssistantMessage("reply for ltm ingest")]);

    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hello ltm");
    await manager.waitForIdle(row.id);

    await waitFor(() => ltm.ingestSessionFile.mock.calls.length === 1);
    expect(ltm.ingestSessionFile).toHaveBeenCalledTimes(1);
    const chatDir = join(dataDir, "sessions", "--chat--");
    const [sessionFile] = readdirSync(chatDir).filter((name) =>
      name.includes(row.id),
    );
    const expectedSessionPath = join(chatDir, sessionFile!);

    expect(row.path).toBe(expectedSessionPath);
    // No activeProjectTag wired → opts arg resolves to undefined
    expect(ltm.ingestSessionFile).toHaveBeenCalledWith(
      expectedSessionPath,
      undefined,
    );
    expect(existsSync(expectedSessionPath)).toBe(true);
  });
});
