import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, fauxToolCall, makeManager, setupFaux, waitFor } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

const probeParams = Type.Object({});

function makeApprovalHarness(timeoutMs = 60_000) {
  const events: ServerEvent[] = [];
  const probeTool: AgentTool<typeof probeParams> = {
    name: "probe_ungated",
    label: "Probe Ungated",
    description: "test ungated tool",
    parameters: probeParams,
    execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
  };
  const coordinator = new ApprovalCoordinator({
    timeoutMs,
    onRequest: (req) => {
      events.push({
        type: "approval_request",
        approvalId: req.approvalId,
        createdAt: req.createdAt,
        sessionId: req.sessionId,
        toolName: req.toolName,
        toolLabel: req.toolLabel,
        params: req.params,
      });
    },
    onResolved: (approvalId, decision) => {
      events.push({ type: "approval_resolved", approvalId, decision });
    },
  });
  const made = makeManager(faux, { approvalCoordinator: coordinator, tools: [probeTool] });
  made.bus.subscribe((event) => events.push(event));
  return { ...made, coordinator, events, probeTool };
}

function approvalRequests(events: ServerEvent[]) {
  return events.filter((e): e is Extract<ServerEvent, { type: "approval_request" }> => e.type === "approval_request");
}

function userTexts(messages: any[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : String(m.content ?? "")));
}

describe("AgentManager lifecycle — abort cancels pending approvals (B1)", () => {
  test("abort() resolves promptly while an ASK-mode tool approval is pending", async () => {
    // timeoutMs huge so the ONLY way the pending approval resolves is the
    // abort path calling cancelSession — not the coordinator's own timeout.
    const h = makeApprovalHarness(60 * 60 * 1000);
    const marker = join(h.dataDir, "should-not-run.txt");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: `printf x > ${JSON.stringify(marker)}` })]),
      fauxAssistantMessage("done"),
    ]);
    const row = await h.manager.createSession();
    await h.manager.setApprovalMode(row.id, "ask");

    await h.manager.sendMessage(row.id, "delete everything");
    // Wait until the gated bash tool is blocked on an approval.
    await waitFor(() => approvalRequests(h.events).length === 1);
    const req = approvalRequests(h.events)[0];
    expect(h.coordinator.list()).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);

    // The crux: abort must return promptly. Before the fix it blocked on
    // harness.abort()'s waitForIdle() until the approval timeout (here: 1h).
    const started = Date.now();
    await h.manager.abort(row.id);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);

    // The pending approval was cancelled (denied), not left dangling.
    expect(h.coordinator.list()).toHaveLength(0);
    expect(h.events).toContainEqual({ type: "approval_resolved", approvalId: req.approvalId, decision: "deny" });

    // Session settles and the gated command never ran.
    await h.manager.waitForIdle(row.id);
    expect(h.manager.isRunning(row.id)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("abortAll() resolves promptly while an approval is pending", async () => {
    const h = makeApprovalHarness(60 * 60 * 1000);
    const marker = join(h.dataDir, "should-not-run-all.txt");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: `printf x > ${JSON.stringify(marker)}` })]),
      fauxAssistantMessage("done"),
    ]);
    const row = await h.manager.createSession();
    await h.manager.setApprovalMode(row.id, "ask");

    await h.manager.sendMessage(row.id, "rm -rf");
    await waitFor(() => approvalRequests(h.events).length === 1);
    expect(h.coordinator.list()).toHaveLength(1);

    const started = Date.now();
    await h.manager.abortAll();
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(h.coordinator.list()).toHaveLength(0);
    await h.manager.waitForIdle(row.id);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("AgentManager lifecycle — concurrent turn-start does not drop the loser (B2)", () => {
  test("sendMessage + injectMessage racing an idle session both land; running not corrupted", async () => {
    // Two assistant turns are primed: one for whichever start wins the fresh
    // prompt, and one for the queued follow-up. Both user/injected messages
    // must appear in the transcript — before the fix the loser's prompt() threw
    // "busy" and its text was silently dropped.
    const { manager } = makeManager(faux);
    faux.setResponses([
      fauxAssistantMessage("first reply"),
      fauxAssistantMessage("second reply"),
    ]);
    const row = await manager.createSession();

    // Fire both at the SAME idle session without awaiting between them, so they
    // interleave across the turn-start await window.
    await Promise.all([
      manager.sendMessage(row.id, "user-message"),
      manager.injectMessage(row.id, "injected-message"),
    ]);
    await manager.waitForIdle(row.id);

    const texts = userTexts(await manager.getMessages(row.id));
    expect(texts).toContain("user-message");
    expect(texts).toContain("injected-message");
    // Neither was dropped.
    expect(texts.filter((t) => t === "user-message" || t === "injected-message")).toHaveLength(2);
    // running flag is not stuck/corrupted after both turns settle.
    expect(manager.isRunning(row.id)).toBe(false);
  });

  test("many concurrent injects on an idle session all reach the transcript", async () => {
    const { manager } = makeManager(faux);
    const N = 5;
    faux.setResponses(Array.from({ length: N }, (_, i) => fauxAssistantMessage(`reply ${i}`)));
    const row = await manager.createSession();

    await Promise.all(
      Array.from({ length: N }, (_, i) => manager.injectMessage(row.id, `inject-${i}`)),
    );
    await manager.waitForIdle(row.id);

    const texts = userTexts(await manager.getMessages(row.id));
    for (let i = 0; i < N; i++) {
      expect(texts).toContain(`inject-${i}`);
    }
    expect(manager.isRunning(row.id)).toBe(false);
  });
});
