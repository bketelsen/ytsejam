import { describe, expect, test } from "vitest";
import { GATED_GIT_OPS, GATED_TOOL_NAMES, canToolRequireApproval, isGatedTool } from "../src/approval/gated-tools.ts";

describe("gated tools registry", () => {
  test("gated set is exactly the design-doc list", () => {
    // Pinning this prevents accidental drift — change requires a deliberate edit.
    expect([...GATED_TOOL_NAMES].sort()).toEqual(
      ["apply_patch", "bash", "cancel_schedule", "delegate", "edit", "run_checks", "schedule", "write"],
    );
  });

  test("git gates only local mutating subcommands", () => {
    expect([...GATED_GIT_OPS].sort()).toEqual(["add", "branch", "checkout", "commit", "restore"]);
    for (const op of ["add", "branch", "checkout", "commit", "restore"]) {
      expect(isGatedTool("git", { op })).toBe(true);
    }
    for (const op of ["status", "diff", "log", "show"]) {
      expect(isGatedTool("git", { op })).toBe(false);
    }
  });

  test("git is wrapped because some subcommands can require approval", () => {
    expect(canToolRequireApproval("git")).toBe(true);
    expect(canToolRequireApproval("read")).toBe(false);
  });

  test("isGatedTool true for bash, write, edit, apply_patch, run_checks, delegate, schedule, cancel_schedule", () => {
    for (const name of ["bash", "write", "edit", "apply_patch", "run_checks", "delegate", "schedule", "cancel_schedule"]) {
      expect(isGatedTool(name)).toBe(true);
    }
  });

  test("isGatedTool false for read/ls/grep/find/web_*/cancel_task/cog_*/recall", () => {
    for (const name of [
      "read", "ls", "grep", "find",
      "web_search", "web_fetch",
      "cancel_task", "check_task",
      "cog_read", "cog_write", "cog_append", "cog_patch", "cog_search", "cog_list",
      "cog_outline", "cog_move", "cog_rpc",
      "list_schedules",
      "recall",
      "skill",
      "git",
    ]) {
      expect(isGatedTool(name)).toBe(false);
    }
  });
});
