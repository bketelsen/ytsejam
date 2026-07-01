import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerEvent } from "../src/events.ts";
import { ArchiveStore } from "../src/archive-store.ts";
import { makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("AgentManager.postAssistantNote", () => {
  test("appends an assistant message without running a turn and emits bus events", async () => {
    const { manager, bus } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    // callCount before — the faux model must NOT be called
    const callsBefore = faux.state.callCount;

    const row = await manager.createSession();
    await manager.postAssistantNote(row.id, "── System note ──\nNothing to report.");

    // 1. The assistant message is persisted in the session branch
    const messages = await manager.getMessages(row.id);
    const assistantMsg = messages.find(
      (m: any) => m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === "text" && c.text.includes("System note")),
    );
    expect(assistantMsg).toBeDefined();

    // 2. A bus event was emitted (message_end at minimum)
    const agentEvents = events.filter((e) => e.type === "agent");
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(
      agentEvents.some((e: any) => e.event.type === "message_end"),
    ).toBe(true);

    // 3. No agent turn ran — faux model was NOT invoked
    expect(faux.state.callCount).toBe(callsBefore);
  });

  test("unarchives a session before appending the note", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-pn-"));
    const archiveStore = new ArchiveStore(join(dataDir, "archived"));
    const { manager, indexer, bus } = makeManager(faux, {
      dataDir,
      isArchived: (id) => archiveStore.isArchived(id),
      markArchived: (id, archived) =>
        archiveStore.append(id, { archived, timestamp: new Date().toISOString() }),
    });
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const row = await manager.createSession();
    // Archive the session
    await manager.archiveSession(row.id);
    expect(indexer.getSession(row.id)!.archived).toBe(true);

    // postAssistantNote should unarchive first
    await manager.postAssistantNote(row.id, "System note: nothing to do.");

    // Session is now unarchived
    expect(indexer.getSession(row.id)!.archived).toBe(false);
    expect(events.some((e) => e.type === "session_unarchived")).toBe(true);

    // Message was still appended
    const messages = await manager.getMessages(row.id);
    expect(
      messages.some(
        (m: any) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === "text" && c.text.includes("System note")),
      ),
    ).toBe(true);
  });
});
