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
    const reqs: Array<{ approvalId: string; sessionId: string }> = [];
    const coord = new ApprovalCoordinator({
      timeoutMs: 60_000,
      onRequest: (r) => { reqs.push(r); },
      onResolved: noop,
    });
    const p1 = coord.request({ sessionId: "s1", toolName: "bash", toolLabel: "Bash", params: {} });
    const p2 = coord.request({ sessionId: "s2", toolName: "bash", toolLabel: "Bash", params: {} });
    coord.cancelSession("s1");
    await expect(p1).resolves.toBe("deny");
    // p2 should still be pending
    expect(coord.list().some((e) => e.sessionId === "s2")).toBe(true);
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
      vi.advanceTimersByTime(2000);
      await expect(p).resolves.toBe("approve");
      expect(resolutions).toEqual(["approve"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
