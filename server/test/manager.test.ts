import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerEvent } from "../src/events.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { fauxAssistantMessage, fauxToolCall, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("AgentManager", () => {
  test("createSession indexes a row and lists it", async () => {
    const { manager, indexer } = makeManager(faux);
    const row = await manager.createSession();
    expect(row.id).toBeTruthy();
    expect(indexer.listSessions().map((s) => s.id)).toEqual([row.id]);
  });

  test("sendMessage runs a turn, persists to JSONL, updates index, emits events", async () => {
    const { manager, indexer, bus } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    faux.setResponses([fauxAssistantMessage("Hello from faux!")]);

    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);

    // transcript persisted
    const messages = await manager.getMessages(row.id);
    const assistant = messages.find((m: any) => m.role === "assistant") as any;
    expect(assistant.content[0].text).toContain("Hello from faux!");

    // index updated with preview + unread
    const indexed = indexer.getSession(row.id)!;
    expect(indexed.preview).toContain("Hello from faux!");
    expect(indexed.unread).toBe(true);

    // events flowed
    const types = events.filter((e) => e.type === "agent").map((e: any) => e.event.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_end");
    expect(events.some((e) => e.type === "session_meta")).toBe(true);
  });

  test("survives reopen: a second manager instance serves the same transcript", async () => {
    const first = makeManager(faux);
    faux.setResponses([fauxAssistantMessage("persisted reply")]);
    const row = await first.manager.createSession();
    await first.manager.sendMessage(row.id, "hi");
    await first.manager.waitForIdle(row.id);

    // simulate restart: new manager + EMPTY index over the same dataDir
    first.indexer.reset();
    const { AgentManager } = await import("../src/manager.ts");
    const { PersonaStore } = await import("../src/persona.ts");
    const { EventBus } = await import("../src/events.ts");
    const { join } = await import("node:path");
    const manager2 = new AgentManager({
      dataDir: first.dataDir,
      indexer: first.indexer,
      bus: new EventBus(),
      persona: new PersonaStore(join(first.dataDir, "persona")),
      resolveModel: () => faux.getModel() as any,
      defaultModel: "faux/faux",
      tools: [],
      generateTitles: false,
      authStore: new PiAuthStore(join(first.dataDir, "no-auth.json")),
    });
    await manager2.rebuildIndex();

    // KEY INVARIANT: rebuilt index matches incrementally-built state (minus volatile unread)
    const rebuilt = first.indexer.getSession(row.id)!;
    expect(rebuilt.preview).toContain("persisted reply");
    const messages = await manager2.getMessages(row.id);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  test("sendMessage while running steers instead of throwing", async () => {
    const { manager } = makeManager(faux);
    // first response waits, so the run is in-flight when we send the second message
    faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return fauxAssistantMessage("first");
      },
      fauxAssistantMessage("second"),
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "one");
    await manager.sendMessage(row.id, "two"); // should not throw "busy"
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const userTexts = messages.filter((m: any) => m.role === "user").map((m: any) => m.content[0].text);
    expect(userTexts).toEqual(["one", "two"]);
  });

  test("rename during a run is flushed to JSONL and survives rebuild", async () => {
    const { manager, indexer } = makeManager(faux);
    faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return fauxAssistantMessage("slow reply");
      },
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.rename(row.id, "Mid-run title"); // while running
    expect(indexer.getSession(row.id)!.title).toBe("Mid-run title"); // index immediate
    await manager.waitForIdle(row.id);
    await new Promise((r) => setTimeout(r, 50)); // let the deferred flush run
    await manager.rebuildIndex();
    expect(indexer.getSession(row.id)!.title).toBe("Mid-run title"); // survived = in JSONL
  });

  test("archive during title generation does not resurrect the session into the active list", async () => {
    const { mkdtempSync, readdirSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AgentManager } = await import("../src/manager.ts");
    const { PersonaStore } = await import("../src/persona.ts");
    const { EventBus } = await import("../src/events.ts");
    const { Indexer } = await import("../src/indexer.ts");
    const { ArchiveStore } = await import("../src/archive-store.ts");

    const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-"));
    const indexer = new Indexer(join(dataDir, "index.db"));
    const archiveStore = new ArchiveStore(join(dataDir, "archived"));
    const manager = new AgentManager({
      dataDir,
      indexer,
      bus: new EventBus(),
      persona: new PersonaStore(join(dataDir, "persona")),
      resolveModel: () => faux.getModel() as any,
      defaultModel: "faux/faux",
      tools: [],
      generateTitles: true,
      authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
      isArchived: (id) => archiveStore.isArchived(id),
      markArchived: (id, archived) =>
        archiveStore.append(id, { archived, timestamp: new Date().toISOString() }),
    });

    faux.setResponses([
      fauxAssistantMessage("normal reply"),
      // title-gen completion: delayed so archive races ahead of the appendSessionName
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return fauxAssistantMessage("Late Title");
      },
    ]);

    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);
    // title generation is now in flight; archive before it completes
    await manager.archiveSession(row.id);
    await new Promise((r) => setTimeout(r, 500)); // let title-gen completion settle

    // hidden from default list, present with includeArchived; JSONL preserved
    expect(indexer.listSessions().map((s) => s.id)).toEqual([]);
    expect(indexer.listSessions({ includeArchived: true }).map((s) => s.id)).toEqual([row.id]);
    const chatDir = join(dataDir, "sessions", "--chat--");
    const remaining = readdirSync(chatDir).filter((f) => f.includes(row.id));
    expect(remaining.length).toBe(1); // file stays on disk
    expect(existsSync(join(chatDir, remaining[0]))).toBe(true);
  });

  test("rename and archive update index and emit events; JSONL file stays on disk", async () => {
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ArchiveStore } = await import("../src/archive-store.ts");

    const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-"));
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
    await manager.rename(row.id, "My title");
    expect(indexer.getSession(row.id)!.title).toBe("My title");

    await manager.archiveSession(row.id);
    // hidden from default list but the row + file both still exist
    expect(indexer.getSession(row.id)).toBeDefined();
    expect(indexer.getSession(row.id)!.archived).toBe(true);
    expect(indexer.listSessions().map((s) => s.id)).toEqual([]);
    expect(events.some((e) => e.type === "session_archived")).toBe(true);
    const chatDir = join(dataDir, "sessions", "--chat--");
    expect(readdirSync(chatDir).filter((f) => f.includes(row.id)).length).toBe(1);

    // unarchive restores it
    await manager.unarchiveSession(row.id);
    expect(indexer.getSession(row.id)!.archived).toBe(false);
    expect(indexer.listSessions().map((s) => s.id)).toEqual([row.id]);
    expect(events.some((e) => e.type === "session_unarchived")).toBe(true);
  });

  test("archiving a running session does not abort it; it is just hidden", async () => {
    const { manager, indexer } = makeManager(faux);
    faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return fauxAssistantMessage("ran to completion");
      },
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "go");
    expect(manager.isRunning(row.id)).toBe(true);

    // archive mid-run; the spec says non-destructive — turn must finish
    await manager.archiveSession(row.id);
    expect(indexer.listSessions().map((s) => s.id)).toEqual([]); // hidden

    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
    // the reply landed in the JSONL — turn was not interrupted
    const assistant = messages.find((m: any) => m.role === "assistant") as any;
    expect(assistant.content[0].text).toContain("ran to completion");
  });

  test(
    "archive state survives rebuildIndex (SSOT lives in the sidecar, not index.db)",
    async () => {
      // The load-bearing invariant: index.db is reset every boot. If archive
      // were a DB-only flag the next restart would un-archive every session.
      // Inject isArchived via the same hook the live wiring uses (index.ts
      // passes ArchiveStore.isArchived); here we use an in-memory Set as a
      // stand-in for any SSOT that the rebuild can consult.
      const archived = new Set<string>();
      const { manager, indexer } = makeManager(faux, {
        isArchived: (id) => archived.has(id),
      });
      const row = await manager.createSession();
      expect(indexer.getSession(row.id)!.archived).toBe(false);

      // mark as archived in the SSOT (sidecar stand-in) — the DB column is
      // stale on purpose to prove the rebuild reads the SSOT, not the DB
      archived.add(row.id);

      await manager.rebuildIndex();
      expect(indexer.getSession(row.id)!.archived).toBe(true);
      // default listSessions hides archived rows
      expect(indexer.listSessions().map((s) => s.id)).toEqual([]);
      // includeArchived surfaces them
      expect(indexer.listSessions({ includeArchived: true }).map((s) => s.id)).toEqual([row.id]);

      // Flip back: SSOT says active, rebuild should agree
      archived.delete(row.id);
      await manager.rebuildIndex();
      expect(indexer.getSession(row.id)!.archived).toBe(false);
      expect(indexer.listSessions().map((s) => s.id)).toEqual([row.id]);
    },
  );

  test("archive state survives rebuildIndex via the real ArchiveStore wired the way index.ts wires it", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ArchiveStore } = await import("../src/archive-store.ts");

    const dataDir = mkdtempSync(join(tmpdir(), "arch-rebuild-"));
    const store = new ArchiveStore(join(dataDir, "archived"));
    const { manager, indexer } = makeManager(faux, {
      dataDir,
      isArchived: (id) => store.isArchived(id),
    });
    faux.setResponses([fauxAssistantMessage("reply")]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);

    // archive via the sidecar
    store.append(row.id, { archived: true, timestamp: new Date().toISOString() });
    // simulate the boot path: reset the index (a stale boot would reset to
    // archived=0 for every row), then rebuild from JSONL + sidecar
    indexer.reset();
    await manager.rebuildIndex();
    expect(indexer.getSession(row.id)!.archived).toBe(true);
    expect(indexer.listSessions().map((s) => s.id)).toEqual([]);
    expect(indexer.listSessions({ includeArchived: true }).map((s) => s.id)).toEqual([row.id]);
  });
});

describe("injectMessage", () => {
  test("starts a turn when the session is idle", async () => {
    const { manager } = makeManager(faux);
    faux.setResponses([fauxAssistantMessage("noted the result")]);
    const row = await manager.createSession();
    await manager.injectMessage(row.id, '[Task "x" completed] all done');
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const userTexts = messages.filter((m: any) => m.role === "user").map((m: any) => m.content[0].text);
    expect(userTexts).toEqual(['[Task "x" completed] all done']);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  test("queues as follow-up when the session is running", async () => {
    const { manager } = makeManager(faux);
    faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return fauxAssistantMessage("first reply");
      },
      fauxAssistantMessage("handled the task result"),
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hello");
    await manager.injectMessage(row.id, '[Task "y" completed] result'); // mid-run
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const texts = messages.map((m: any) =>
      Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : m.content,
    );
    // follow-up processed after the first turn: hello, first reply, [Task...], handled...
    expect(texts.filter((t) => t.includes("[Task"))).toHaveLength(1);
    expect(messages.filter((m: any) => m.role === "assistant")).toHaveLength(2);
  });
});

describe("sessionTools", () => {
  test("per-session tools are available to the harness and receive the session id", async () => {
    const seen: string[] = [];
    const probeTool = (sessionId: string) => ({
      name: "probe",
      label: "Probe",
      description: "test tool",
      parameters: { type: "object", properties: {} } as any,
      execute: async () => {
        seen.push(sessionId);
        return { content: [{ type: "text" as const, text: "probed" }], details: {} };
      },
    });
    const { manager } = makeManager(faux, { sessionTools: (id) => [probeTool(id) as any] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {})]),
      fauxAssistantMessage("done"),
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "use the probe");
    await manager.waitForIdle(row.id);
    expect(seen).toEqual([row.id]);
  });
});

describe("cog brief + skills prompt wiring", () => {
  test("sections reach the harness system prompt", async () => {
    const seen: string[] = [];
    const { manager } = makeManager(faux, {
      cogBrief: { promptSection: async () => "## Memory (cog)\nHOTMARK" } as any,
      skills: { promptSection: async () => "## Skills\nSKILLMARK" } as any,
    });
    faux.setResponses([
      (context: any) => {
        seen.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("ok") as any;
      },
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);
    expect(seen[0]).toContain("HOTMARK");
    expect(seen[0]).toContain("SKILLMARK");
  });

  test("a throwing brief provider does not break the session", async () => {
    const { manager } = makeManager(faux, {
      cogBrief: { promptSection: async () => { throw new Error("boom"); } } as any,
    });
    faux.setResponses([fauxAssistantMessage("still alive")]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const assistant = messages.find((m: any) => m.role === "assistant") as any;
    expect(assistant.content[0].text).toContain("still alive");
  });

  test("loadContextFiles output reaches the harness system prompt", async () => {
    const seen: string[] = [];
    const { manager } = makeManager(faux, {
      loadContextFiles: async () => "CTXMARK",
    });
    faux.setResponses([
      (context: any) => {
        seen.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("ok") as any;
      },
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);
    expect(seen[0]).toContain("## Project context files");
    expect(seen[0]).toContain("CTXMARK");
  });

  test("a throwing loadContextFiles does not break the session", async () => {
    const { manager } = makeManager(faux, {
      loadContextFiles: async () => {
        throw new Error("ctx-boom");
      },
    });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const assistant = messages.find((m: any) => m.role === "assistant") as any;
    expect(assistant.content[0].text).toContain("ok");
  });
});
