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
  "delegate",
  "schedule",
  "cancel_schedule",
]);

/**
 * Returns true if a tool's execution must pause for user approval in ASK mode.
 * Sibling tools not in this registry run immediately regardless of approval mode.
 */
export function isGatedTool(name: string): boolean {
  return GATED_TOOL_NAMES.has(name);
}
