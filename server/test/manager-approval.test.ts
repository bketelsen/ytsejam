import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, fauxToolCall, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const probeParams = Type.Object({});

type ApprovalHarness = ReturnType<typeof makeApprovalHarness>;

function makeApprovalHarness() {
  const events: ServerEvent[] = [];
  const probeTool: AgentTool<typeof probeParams> = {
    name: "probe_ungated",
    label: "Probe Ungated",
    description: "test ungated tool",
    parameters: probeParams,
    execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
  };
  const coordinator = new ApprovalCoordinator({
    timeoutMs: 60_000,
    onRequest: (req) => {
      events.push({
        type: "approval_request",
        approvalId: req.approvalId,
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

function approvalRequest(h: ApprovalHarness) {
  return h.events.find((event): event is Extract<ServerEvent, { type: "approval_request" }> => event.type === "approval_request");
}

function userTexts(messages: any[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : String(m.content ?? "")));
}

function writeCommand(h: ApprovalHarness, name: string, content = name): { path: string; command: string } {
  const path = join(h.dataDir, `${name}.txt`);
  return { path, command: `printf ${JSON.stringify(content)} > ${JSON.stringify(path)}` };
}

describe("AgentManager approval-mode tool wrapping", () => {
  test("ASK session + approve → bash runs", async () => {
    const h = makeApprovalHarness();
    const marker = writeCommand(h, "approved", "approved");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: marker.command })]), fauxAssistantMessage("done")]);
    const row = await h.manager.createSession();
    await h.manager.setApprovalMode(row.id, "ask");

    await h.manager.sendMessage(row.id, "run pwd");
    await waitFor(() => approvalRequest(h) !== undefined);
    const req = approvalRequest(h)!;
    expect(req).toMatchObject({ sessionId: row.id, toolName: "bash", toolLabel: "Bash", params: { command: marker.command } });
    expect(h.coordinator.list()).toHaveLength(1);
    expect(existsSync(marker.path)).toBe(false);

    expect(h.coordinator.resolve(req.approvalId, "approve")).toBe(true);
    await h.manager.waitForIdle(row.id);

    expect(readFileSync(marker.path, "utf8")).toBe("approved");
    expect(h.events).toContainEqual({ type: "approval_resolved", approvalId: req.approvalId, decision: "approve" });
  });

  test("ASK session + deny → bash does not run and denial is returned to the model", async () => {
    const h = makeApprovalHarness();
    const marker = writeCommand(h, "denied", "denied");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: marker.command })]),
      (context: any) => {
        const last = context.messages.at(-1);
        expect(last?.role).toBe("toolResult");
        expect(JSON.stringify(last?.content)).toContain("User denied this tool call.");
        return fauxAssistantMessage("ok, denied");
      },
    ]);
    const row = await h.manager.createSession();
    await h.manager.setApprovalMode(row.id, "ask");

    await h.manager.sendMessage(row.id, "delete it");
    await waitFor(() => approvalRequest(h) !== undefined);
    const req = approvalRequest(h)!;
    expect(h.coordinator.resolve(req.approvalId, "deny")).toBe(true);
    await h.manager.waitForIdle(row.id);

    expect(existsSync(marker.path)).toBe(false);
    const messages = await h.manager.getMessages(row.id);
    const denial = messages.find((m: any) => m.role === "toolResult");
    expect(JSON.stringify((denial as any)?.content)).toContain("User denied this tool call.");
  });

  test("YOLO session runs bash without approval", async () => {
    const h = makeApprovalHarness();
    const marker = writeCommand(h, "yolo", "yolo");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: marker.command })]), fauxAssistantMessage("done")]);
    const row = await h.manager.createSession();

    await h.manager.sendMessage(row.id, "run pwd");
    await h.manager.waitForIdle(row.id);

    expect(readFileSync(marker.path, "utf8")).toBe("yolo");
    expect(h.events.some((event) => event.type === "approval_request")).toBe(false);
    expect(h.coordinator.list()).toHaveLength(0);
  });

  test("per-turn /yolo override on ASK session runs without approval and strips prefix", async () => {
    const h = makeApprovalHarness();
    const marker = writeCommand(h, "override-yolo", "override-yolo");
    faux.setResponses([
      (context: any) => {
        expect(userTexts(context.messages)).toContain("please run pwd");
        expect(userTexts(context.messages).some((text) => text.includes("/yolo"))).toBe(false);
        return fauxAssistantMessage([fauxToolCall("bash", { command: marker.command })]);
      },
      fauxAssistantMessage("done"),
    ]);
    const row = await h.manager.createSession();
    await h.manager.setApprovalMode(row.id, "ask");

    await h.manager.sendMessage(row.id, "/yolo please run pwd");
    await h.manager.waitForIdle(row.id);

    expect(readFileSync(marker.path, "utf8")).toBe("override-yolo");
    expect(h.events.some((event) => event.type === "approval_request")).toBe(false);
    expect(userTexts(await h.manager.getMessages(row.id))).toContain("please run pwd");
  });

  test("per-turn /careful override on YOLO session awaits approval", async () => {
    const h = makeApprovalHarness();
    const marker = writeCommand(h, "override-careful", "override-careful");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: marker.command })]), fauxAssistantMessage("done")]);
    const row = await h.manager.createSession();

    await h.manager.sendMessage(row.id, "/careful run pwd");
    await waitFor(() => approvalRequest(h) !== undefined);

    expect(existsSync(marker.path)).toBe(false);
    expect(approvalRequest(h)).toMatchObject({ sessionId: row.id, toolName: "bash" });
    h.coordinator.resolve(approvalRequest(h)!.approvalId, "approve");
    await h.manager.waitForIdle(row.id);
    expect(readFileSync(marker.path, "utf8")).toBe("override-careful");
  });

  test("setApprovalMode mid-session updates the live ref", async () => {
    const h = makeApprovalHarness();
    const first = writeCommand(h, "first", "first");
    const second = writeCommand(h, "second", "second");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: first.command })]),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage([fauxToolCall("bash", { command: second.command })]),
      fauxAssistantMessage("second done"),
    ]);
    const row = await h.manager.createSession();

    await h.manager.sendMessage(row.id, "first");
    await h.manager.waitForIdle(row.id);
    expect(readFileSync(first.path, "utf8")).toBe("first");
    expect(h.events.some((event) => event.type === "approval_request")).toBe(false);

    await h.manager.setApprovalMode(row.id, "ask");
    await h.manager.sendMessage(row.id, "second");
    await waitFor(() => approvalRequest(h) !== undefined);

    expect(existsSync(second.path)).toBe(false);
    h.coordinator.resolve(approvalRequest(h)!.approvalId, "approve");
    await h.manager.waitForIdle(row.id);
    expect(readFileSync(second.path, "utf8")).toBe("second");
  });

  test("manager wrapping preserves ungated tool reference equality", async () => {
    const h = makeApprovalHarness();
    const row = await h.manager.createSession();
    const opened = (h.manager as any).open.get(row.id);
    expect(opened.harness.getTools().find((tool: AgentTool<any>) => tool.name === "probe_ungated")).toBe(h.probeTool);
    expect(opened.harness.getTools().find((tool: AgentTool<any>) => tool.name === "bash")).not.toBeUndefined();
  });
});
