import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

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

  test("delete during title generation does not resurrect the session", async () => {
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AgentManager } = await import("../src/manager.ts");
    const { PersonaStore } = await import("../src/persona.ts");
    const { EventBus } = await import("../src/events.ts");
    const { Indexer } = await import("../src/indexer.ts");

    const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-"));
    const indexer = new Indexer(join(dataDir, "index.db"));
    const manager = new AgentManager({
      dataDir,
      indexer,
      bus: new EventBus(),
      persona: new PersonaStore(join(dataDir, "persona")),
      resolveModel: () => faux.getModel() as any,
      defaultModel: "faux/faux",
      tools: [],
      generateTitles: true,
    });

    faux.setResponses([
      fauxAssistantMessage("normal reply"),
      // title-gen completion: delayed so delete races ahead of the appendSessionName
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return fauxAssistantMessage("Resurrected Title");
      },
    ]);

    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);
    // title generation is now in flight; delete before it completes
    await manager.deleteSession(row.id);
    await new Promise((r) => setTimeout(r, 500)); // let title-gen completion settle

    expect(indexer.getSession(row.id)).toBeUndefined();
    const chatDir = join(dataDir, "sessions", "--chat--");
    const remaining = readdirSync(chatDir).filter((f) => f.includes(row.id));
    expect(remaining).toEqual([]);
  });

  test("rename and delete update index and emit events", async () => {
    const { manager, indexer, bus } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const row = await manager.createSession();
    await manager.rename(row.id, "My title");
    expect(indexer.getSession(row.id)!.title).toBe("My title");
    await manager.deleteSession(row.id);
    expect(indexer.getSession(row.id)).toBeUndefined();
    expect(events.some((e) => e.type === "session_deleted")).toBe(true);
  });
});
