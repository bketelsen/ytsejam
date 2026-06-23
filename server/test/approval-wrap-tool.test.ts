import { describe, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { wrapToolWithApproval } from "../src/approval/wrap-tool.ts";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";
import type { ApprovalMode } from "../src/approval/types.ts";

const emptyParams = Type.Object({});
const gitParams = Type.Object({ op: Type.String() });

function makeFakeTool(name: string): AgentTool<typeof emptyParams> {
  return {
    name,
    label: name,
    description: "",
    parameters: emptyParams,
    execute: async () => ({ content: [{ type: "text", text: `ran ${name}` }], details: {} }),
  };
}

function makeCoordinator(): { coord: ApprovalCoordinator; lastId: () => string } {
  let lastId = "";
  const coord = new ApprovalCoordinator({
    timeoutMs: 60_000,
    onRequest: (r) => { lastId = r.approvalId; },
    onResolved: () => {},
  });
  return { coord, lastId: () => lastId };
}

describe("wrapToolWithApproval", () => {
  test("ungated tool is returned unwrapped (reference equality)", () => {
    const { coord } = makeCoordinator();
    const tool = makeFakeTool("read");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    expect(wrapToolWithApproval(tool, ctx)).toBe(tool);
  });

  test("param-gated git tool runs read ops directly and gates write ops", async () => {
    const { coord, lastId } = makeCoordinator();
    let calls = 0;
    const tool: AgentTool<typeof gitParams> = {
      name: "git",
      label: "Git",
      description: "",
      parameters: gitParams,
      execute: async (_id, params) => {
        calls++;
        return { content: [{ type: "text", text: `ran ${params.op}` }], details: {} };
      },
    };
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);

    expect((await wrapped.execute("read", { op: "status" })).content[0]).toMatchObject({ text: "ran status" });
    expect(coord.list()).toHaveLength(0);

    const p = wrapped.execute("write", { op: "commit" });
    expect(coord.list()).toHaveLength(1);
    coord.resolve(lastId(), "approve");
    expect((await p).content[0]).toMatchObject({ text: "ran commit" });
    expect(calls).toBe(2);
  });

  test("gated tool in YOLO mode calls through", async () => {
    const { coord } = makeCoordinator();
    const tool = makeFakeTool("bash");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "yolo", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const result = await wrapped.execute("call1", {});
    expect((result.content[0] as any).text).toBe("ran bash");
  });

  test("gated tool in ASK mode + approve → calls through", async () => {
    const { coord, lastId } = makeCoordinator();
    const tool = makeFakeTool("bash");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const p = wrapped.execute("call1", {});
    coord.resolve(lastId(), "approve");
    const result = await p;
    expect((result.content[0] as any).text).toBe("ran bash");
  });

  test("gated tool in ASK mode + deny → synthetic denial, original NOT called", async () => {
    const { coord, lastId } = makeCoordinator();
    let calls = 0;
    const tool: AgentTool<typeof emptyParams> = {
      ...makeFakeTool("bash"),
      execute: async () => { calls++; return { content: [{ type: "text", text: "should not run" }], details: {} }; },
    };
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const p = wrapped.execute("call1", {});
    coord.resolve(lastId(), "deny");
    const result = await p;
    expect(calls).toBe(0);
    expect((result.content[0] as any).text).toBe("User denied this tool call.");
    expect((result as any).details).toEqual({ approval: "deny" });
  });

  test("gated tool in ASK mode + timeout → synthetic denial with (timeout) marker", async () => {
    // Override timeout to 10ms for this test.
    const fastCoord = new ApprovalCoordinator({
      timeoutMs: 10,
      onRequest: () => {},
      onResolved: () => {},
    });
    const tool = makeFakeTool("bash");
    const ctx = { sessionId: "s1", effectiveMode: (): ApprovalMode => "ask", coordinator: fastCoord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    const result = await wrapped.execute("call1", {});
    expect((result.content[0] as any).text).toBe("User denied this tool call (timeout).");
  });

  test("effectiveMode is read at execute time, not wrap time", async () => {
    const { coord, lastId } = makeCoordinator();
    const tool = makeFakeTool("bash");
    let mode: ApprovalMode = "yolo";
    const ctx = { sessionId: "s1", effectiveMode: () => mode, coordinator: coord };
    const wrapped = wrapToolWithApproval(tool, ctx);
    // First call: YOLO, passes through.
    expect((await wrapped.execute("c1", {})).content[0]).toMatchObject({ text: "ran bash" });
    // Flip mode and verify the next call awaits an approval (not a passthrough).
    mode = "ask";
    const p = wrapped.execute("c2", {});
    // CRITICAL: if effectiveMode were captured at wrap time, no approval would open.
    expect(coord.list()).toHaveLength(1);
    coord.resolve(lastId(), "approve");
    expect(((await p).content[0] as any).text).toBe("ran bash");
  });
});
