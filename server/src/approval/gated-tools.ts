/**
 * Tools whose execution pauses in ASK mode and surfaces an approval card.
 * Decided in design doc 2026-06-14-approval-mode-design.md.
 *
 * Mutating shell + filesystem + outbound side-effects.
 * Note: all `cog_*` memory tools (including writes like cog_write, cog_move, cog_rpc) are
 * deliberately ungated — memory is internal, low blast radius, used constantly.
 */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "bash",
  "write",
  "edit",
  "apply_patch",
  "run_checks",
  "delegate",
  "schedule",
  "cancel_schedule",
]);

export const GATED_GIT_OPS: ReadonlySet<string> = new Set<string>([
  "add",
  "restore",
  "checkout",
  "branch",
  "commit",
]);

/**
 * Returns true when a tool might require approval for some parameter shape.
 * `git` is parameter-gated so read-only operations can run immediately.
 */
export function canToolRequireApproval(name: string): boolean {
  return GATED_TOOL_NAMES.has(name) || name === "git";
}

/**
 * Returns true if a tool's execution must pause for user approval in ASK mode.
 * Sibling tools not in this registry run immediately regardless of approval mode.
 */
export function isGatedTool(name: string, params?: unknown): boolean {
  if (name === "git") {
    const op = typeof params === "object" && params !== null && "op" in params
      ? (params as { op?: unknown }).op
      : undefined;
    return typeof op === "string" && GATED_GIT_OPS.has(op);
  }
  return GATED_TOOL_NAMES.has(name);
}
