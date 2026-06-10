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
import { SchedulerService } from "../src/scheduler.ts";
import { ScheduleStore } from "../src/schedules.ts";
import { createSchedulingTools } from "../src/tools/scheduling.ts";

let faux: ReturnType<typeof registerFauxProvider>;
beforeEach(() => {
  faux = registerFauxProvider();
});
afterEach(() => faux.unregister());

function routingResponse(fireAtIso: string) {
  return (context: any) => {
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];
    const lastText = Array.isArray(last?.content)
      ? last.content.map((c: any) => c.text ?? "").join("")
      : String(last?.content ?? "");
    if (last?.role === "toolResult") {
      return fauxAssistantMessage("Scheduled! I'll handle it then.");
    }
    if (lastText.includes('[Scheduled task "water plants"]')) {
      return fauxAssistantMessage("It's time: water the plants now!");
    }
    return fauxAssistantMessage([
      fauxToolCall("schedule", {
        prompt: "tell the user to water the plants",
        label: "water plants",
        at: fireAtIso,
      }),
    ]);
  };
}

test("full scheduling loop: chat turn → schedule → tick fires → assistant acts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "schedtools-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const fauxModel = faux.getModel() as any;
  let now = new Date("2026-06-09T10:00:00.000Z");

  let scheduler!: SchedulerService;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    sessionTools: (sessionId) => createSchedulingTools(() => scheduler, sessionId),
    generateTitles: false,
    authStore: new PiAuthStore(join(dataDir, "no-auth.json")),
  });
  scheduler = new SchedulerService({
    store: new ScheduleStore(join(dataDir, "schedules")),
    indexer,
    bus,
    now: () => now,
    inject: (sessionId, text) => manager.injectMessage(sessionId, text),
    createTargetSession: async (label) => (await manager.createSession()).id,
  });

  const fireAt = "2026-06-09T11:00:00.000Z";
  faux.setResponses(Array.from({ length: 6 }, () => routingResponse(fireAt)));

  const row = await manager.createSession();
  await manager.sendMessage(row.id, "schedule a reminder to water the plants at 11am");
  await manager.waitForIdle(row.id);

  const sched = indexer.listSchedules();
  expect(sched).toHaveLength(1);
  expect(sched[0]).toMatchObject({ label: "water plants", enabled: true, targetSessionId: row.id });

  // advance the clock past the fire time and tick
  now = new Date("2026-06-09T11:00:30.000Z");
  await scheduler.tick();
  await manager.waitForIdle(row.id);

  const messages = (await manager.getMessages(row.id)) as any[];
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.map((c: any) => c.text ?? "").join(""));
  expect(userTexts.some((t) => t.includes('[Scheduled task "water plants"]'))).toBe(true);
  const assistantTexts = messages
    .filter((m) => m.role === "assistant")
    .map((m) => JSON.stringify(m.content));
  expect(assistantTexts.some((t) => t.includes("water the plants now"))).toBe(true);
  expect(indexer.listSchedules()[0]).toMatchObject({ enabled: false, firedCount: 1 });
}, 20_000);
