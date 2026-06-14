/**
 * Tools whose execution pauses in ASK mode and surfaces an approval card.
 * Decided in design doc 2026-06-14-approval-mode-design.md.
 *
 * Mutating shell + filesystem + outbound side-effects.
 */
export const GATED_TOOL_NAMES = new Set<string>([
  "bash",
  "write",
  "edit",
  "delegate",
  "schedule",
  "cancel_schedule",
]);

export function isGatedTool(name: string): boolean {
  return GATED_TOOL_NAMES.has(name);
}
