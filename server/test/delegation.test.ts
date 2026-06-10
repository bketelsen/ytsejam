import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { AgentManager } from "../src/manager.ts";
import { PersonaStore } from "../src/persona.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { TaskManager } from "../src/task-manager.ts";
import { TaskStore } from "../src/tasks.ts";
import { createDelegationTools } from "../src/tools/delegation.ts";

let faux: ReturnType<typeof registerFauxProvider>;
beforeEach(() => {
  faux = registerFauxProvider();
});
afterEach(() => faux.unregister());

/** Route faux replies by inspecting the request context — deterministic under concurrency. */
function routingResponse() {
  return (context: any) => {
    const system = String(context.systemPrompt ?? "");
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    const lastText = Array.isArray(last?.content)
      ? last.content.map((c: any) => c.text ?? "").join("")
      : String(last?.content ?? "");

    if (system.includes("background worker subagent")) {
      return fauxAssistantMessage("SUBAGENT REPORT: the answer is 42");
    }
    if (last?.role === "toolResult") {
      return fauxAssistantMessage("Delegated. I'll let you know when it's done.");
    }
    if (lastText.includes('[Task "find answer" completed]')) {
      return fauxAssistantMessage("Your task finished: the answer is 42.");
    }
    return fauxAssistantMessage([
      fauxToolCall("delegate", { task: "compute the answer", label: "find answer" }),
    ]);
  };
}

test("full delegation loop: chat turn → subagent → parent notified and replies", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "deleg-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const persona = new PersonaStore(join(dataDir, "persona"));
  const authStore = new PiAuthStore(join(dataDir, "no-auth.json"));
  const fauxModel = faux.getModel() as any;

  let taskManager!: TaskManager;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona,
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    sessionTools: (sessionId) => createDelegationTools(() => taskManager, sessionId),
    generateTitles: false,
    authStore,
  });
  taskManager = new TaskManager({
    dataDir,
    store: new TaskStore(join(dataDir, "tasks")),
    indexer,
    bus,
    persona,
    authStore,
    resolveModel: () => fauxModel,
    subagentModel: "faux/faux",
    workerTools: [],
    concurrency: 2,
    timeoutMs: 10_000,
    notifyParent: (sessionId, text) => manager.injectMessage(sessionId, text),
  });

  // enough routed responses for: parent toolCall turn, parent post-tool turn,
  // subagent turn, parent notification turn (+ slack for retries)
  faux.setResponses(Array.from({ length: 8 }, () => routingResponse()));

  const row = await manager.createSession();
  await manager.sendMessage(row.id, "please find the answer in the background");

  // wait until the task completes and the parent's final reply lands
  const deadline = Date.now() + 10_000;
  let done = false;
  while (!done && Date.now() < deadline) {
    const tasks = indexer.listTasks();
    const messages = await manager.getMessages(row.id).catch(() => []);
    done =
      tasks.length === 1 &&
      tasks[0]!.status === "completed" &&
      (messages as any[]).some(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes("task finished"),
      );
    if (!done) await new Promise((r) => setTimeout(r, 50));
  }
  expect(done).toBe(true);

  const task = indexer.listTasks()[0]!;
  expect(task.parentSessionId).toBe(row.id);
  expect(task.resultSummary).toContain("42");

  // parent transcript contains: user msg, toolCall turn, [Task completed] injection, final reply
  const messages = (await manager.getMessages(row.id)) as any[];
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.map((c: any) => c.text ?? "").join(""));
  expect(userTexts.some((t) => t.includes('[Task "find answer" completed]'))).toBe(true);
}, 20_000);
