import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { composeSystemPrompt } from "../src/persona.ts";
import { PlanStore, renderPlanSection } from "../src/plans.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("composeSystemPrompt + planSection", () => {
  test("includes a rendered plan section when provided", () => {
    const planSection = renderPlanSection([
      { id: "p1", text: "do the thing", status: "in_progress" },
    ]);
    const prompt = composeSystemPrompt("# Persona", { dataDir: "/data", planSection });
    expect(prompt).toContain("## Current plan");
    expect(prompt).toContain("(p1) do the thing");
  });

  test("omits the plan section entirely when there is none", () => {
    const prompt = composeSystemPrompt("# Persona", { dataDir: "/data" });
    expect(prompt).not.toContain("## Current plan");
  });
});

describe("AgentManager injects the persisted plan into the system prompt", () => {
  // Capture the system prompt the model actually receives each turn.
  function captureSystemPrompts() {
    const captured: string[] = [];
    faux.setResponses([
      (ctx: Context) => {
        captured.push(ctx.systemPrompt ?? "");
        return fauxAssistantMessage("ok");
      },
      (ctx: Context) => {
        captured.push(ctx.systemPrompt ?? "");
        return fauxAssistantMessage("ok again");
      },
    ]);
    return captured;
  }

  test(
    "the plan section is read from the persisted store, not the conversation, and is rebuilt fresh each turn (so it survives compaction)",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "plan-ctx-"));
      const store = new PlanStore(join(dataDir, "plans"));

      const { manager } = makeManager(faux, {
        dataDir,
        planSection: (sessionId) => renderPlanSection(store.current(sessionId)),
      });

      const captured = captureSystemPrompts();
      const s = await manager.createSession();

      // Plan is set out-of-band — it is NEVER mentioned in the conversation.
      store.set(s.id, ["investigate bug", "write the fix"]);

      // Turn 1: a user message that says nothing about the plan.
      await manager.sendMessage(s.id, "hello there");
      await manager.waitForIdle(s.id);

      // The plan still shows up in the system prompt -> it came from the store,
      // not the conversation history. This is exactly what makes it survive a
      // compaction event (which only rewrites the conversation branch).
      expect(captured[0]).toContain("## Current plan");
      expect(captured[0]).toContain("(p1) investigate bug");
      expect(captured[0]).toContain("(p2) write the fix");

      // Mutate the persisted plan, then take another turn. The system prompt is
      // reassembled from the store every turn, so the new state is reflected
      // without anything being threaded through the conversation.
      store.update(s.id, { updates: [{ id: "p1", status: "done" }] });
      await manager.sendMessage(s.id, "carry on");
      await manager.waitForIdle(s.id);

      expect(captured[1]).toContain("- [x] (p1) investigate bug");
    },
  );

  test("injects nothing when the session has no plan", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plan-ctx-"));
    const store = new PlanStore(join(dataDir, "plans"));
    const { manager } = makeManager(faux, {
      dataDir,
      planSection: (sessionId) => renderPlanSection(store.current(sessionId)),
    });

    const captured = captureSystemPrompts();
    const s = await manager.createSession();
    await manager.sendMessage(s.id, "no plan here");
    await manager.waitForIdle(s.id);

    expect(captured[0]).not.toContain("## Current plan");
  });
});
