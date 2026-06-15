import { describe, expect, test, vi } from "vitest";
import { ApprovalCoordinator } from "../src/approval/coordinator.ts";

function noop() {}

describe("ApprovalCoordinator", () => {
  test("approve resolves the promise", async () => {
    let req!: { approvalId: string };
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: noop,
    });
    const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    expect(coord.resolve(req.approvalId, "approve")).toBe(true);
    await expect(p).resolves.toBe("approve");
  });

  test("deny resolves with deny", async () => {
    let req!: { approvalId: string };
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: noop,
    });
    const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.resolve(req.approvalId, "deny");
    await expect(p).resolves.toBe("deny");
  });

  test("timeout fires after timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const coord = new ApprovalCoordinator({
        timeoutMs: 1000,
        onRequest: noop,
        onResolved: noop,
      });
      const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
      vi.advanceTimersByTime(1001);
      await expect(p).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  test("onResolved fires with correct decision", () => {
    const resolutions: Array<[string, string]> = [];
    let req!: { approvalId: string };
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: (id, decision) => { resolutions.push([id, decision]); },
    });
    coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.resolve(req.approvalId, "approve");
    expect(resolutions).toEqual([[req.approvalId, "approve"]]);
  });

  test("resolve unknown id returns false, no throw", () => {
    const coord = new ApprovalCoordinator({ timeoutMs: 60_000, onRequest: noop, onResolved: noop });
    expect(coord.resolve("does-not-exist", "approve")).toBe(false);
  });

  test("cancelSession denies all pending for that session", async () => {
    const reqs: Array<{ approvalId: string; createdAt: number; sessionId: string }> = [];
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { reqs.push(r); },
      onResolved: noop,
    });
    const p1 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    const p2 = coord.request({ sessionId: "s2", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.cancelSession("s1");
    await expect(p1).resolves.toBe("deny");
    // p2 should still be pending with the full request payload for reconnect snapshots
    expect(coord.list()).toEqual([{
      approvalId: reqs[1]!.approvalId,
      createdAt: reqs[1]!.createdAt,
      sessionId: "s2",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    }]);
    // Clean up
    coord.resolve(reqs[1]!.approvalId, "approve");
    await p2;
  });

  test("timer is cleared on explicit resolve (no double-fire)", async () => {
    vi.useFakeTimers();
    try {
      const resolutions: string[] = [];
      let req!: { approvalId: string };
      const coord = new ApprovalCoordinator({
        timeoutMs: 1000,
        onRequest: (r) => { req = r; },
        onResolved: (_, d) => { resolutions.push(d); },
      });
      const p = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
      coord.resolve(req.approvalId, "approve");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(2000);
      await expect(p).resolves.toBe("approve");
      expect(resolutions).toEqual(["approve"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancelSession clears timers for cancelled approvals", async () => {
    vi.useFakeTimers();
    try {
      const coord = new ApprovalCoordinator({
        timeoutMs: 60_000,
        onRequest: noop,
        onResolved: noop,
      });
      const p1 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
      const p2 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
      expect(vi.getTimerCount()).toBe(2);
      coord.cancelSession("s1");
      expect(vi.getTimerCount()).toBe(0);
      await expect(p1).resolves.toBe("deny");
      await expect(p2).resolves.toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancelSession resilient to throwing onResolved (no stranded entries)", async () => {
    let calls = 0;
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: noop,
      onResolved: () => {
        calls++;
        if (calls === 1) throw new Error("transport blew up");
      },
    });
    const p1 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    const p2 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    expect(() => coord.cancelSession("s1")).not.toThrow();
    await expect(p1).resolves.toBe("deny");
    await expect(p2).resolves.toBe("deny");
    expect(coord.list()).toEqual([]);
  });

  test("list() reflects pending entries and shrinks on resolve", async () => {
    const requests: Array<{ approvalId: string; createdAt: number }> = [];
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { requests.push(r); },
      onResolved: noop,
    });
    expect(coord.list()).toEqual([]);
    const p1 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    expect(coord.list()).toEqual([{
      approvalId: requests[0]!.approvalId,
      createdAt: requests[0]!.createdAt,
      sessionId: "s1",
      toolName: "bash",
      toolLabel: "Bash",
      params: {},
    }]);
    const p2 = coord.request({ sessionId: "s2", toolName: "write", toolLabel: "Write", params: {} });
    expect(coord.list()).toHaveLength(2);
    coord.resolve(requests[0]!.approvalId, "approve");
    await p1;
    expect(coord.list()).toEqual([{
      approvalId: requests[1]!.approvalId,
      createdAt: requests[1]!.createdAt,
      sessionId: "s2",
      toolName: "write",
      toolLabel: "Write",
      params: {},
    }]);
    coord.resolve(requests[1]!.approvalId, "deny");
    await p2;
    expect(coord.list()).toEqual([]);
  });

  test("onRequest receives full ApprovalRequest shape with UUID approvalId and numeric createdAt", () => {
    let req!: import("../src/approval/coordinator.ts").ApprovalRequest;
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { req = r; },
      onResolved: noop,
    });
    const testStartTime = Date.now();
    coord.request({
      sessionId: "session-xyz",
      toolName: "bash",
      toolLabel: "Bash",
      params: { command: "echo hi" },
    });
    expect(req).toEqual({
      approvalId: expect.any(String),
      createdAt: expect.any(Number),
      sessionId: "session-xyz",
      toolName: "bash",
      toolLabel: "Bash",
      params: { command: "echo hi" },
    });
    expect(req.createdAt).toBeGreaterThanOrEqual(testStartTime);
    expect(req.createdAt).toBeLessThanOrEqual(Date.now());
    // UUID v4 shape
    expect(req.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
