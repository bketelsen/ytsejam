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
});
