import { describe, expect, test } from "vitest";
import { deriveApprovalMode } from "../src/approval/session-entry.ts";

describe("deriveApprovalMode", () => {
  test("empty entries → yolo (default)", () => {
    expect(deriveApprovalMode([])).toBe("yolo");
  });

  test("entries with no set_approval_mode → yolo", () => {
    expect(deriveApprovalMode([{ type: "user_message" }, { type: "tool_call" }])).toBe("yolo");
  });

  test("single set_approval_mode → that mode", () => {
    expect(deriveApprovalMode([{ type: "set_approval_mode", mode: "ask" }])).toBe("ask");
  });

  test("multiple set_approval_mode → newest wins", () => {
    expect(
      deriveApprovalMode([
        { type: "set_approval_mode", mode: "ask" },
        { type: "user_message" },
        { type: "set_approval_mode", mode: "yolo" },
      ]),
    ).toBe("yolo");
  });

  test("malformed mode value → ignored", () => {
    expect(
      deriveApprovalMode([
        { type: "set_approval_mode", mode: "ask" },
        { type: "set_approval_mode", mode: "garbage" },
      ]),
    ).toBe("ask");
  });

  test("null/undefined array elements are skipped without throwing", () => {
    // Permissive input type doesn't model these, but the loop must not crash
    // if a caller hands us a sparse array.
    const entries = [
      { type: "set_approval_mode", mode: "ask" },
      null as any,
      undefined as any,
    ] as Array<{ type: string; mode?: unknown }>;
    expect(deriveApprovalMode(entries)).toBe("ask");
  });

  test("accepts pi-agent-core SessionTreeEntry[] without type assertions", () => {
    // This test exists to lock the contract: deriveApprovalMode must accept
    // pi-agent-core's generic SessionTreeEntry[] (the entry shape its JSONL
    // session storage returns) without a cast at the call site.
    // Compile-time check: empty array, typed, no assertion.
    const empty: import("@earendil-works/pi-agent-core").SessionTreeEntry[] = [];
    expect(deriveApprovalMode(empty)).toBe("yolo");
  });
});
