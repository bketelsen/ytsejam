import type { ApprovalMode } from "./types.ts";

export type TurnOverride = ApprovalMode | null;

/**
 * If `message` starts with `/yolo ` or `/careful ` (case-sensitive, requires
 * trailing whitespace OR end-of-string), strip the prefix and return the
 * implied override. Otherwise return null override + original message.
 *
 * `/yolocowboy` (no whitespace boundary) is NOT a match — passes through.
 * Pure stdlib, no allocations beyond the slice.
 */
export function extractTurnOverride(message: string): { override: TurnOverride; message: string } {
  const match = message.match(/^(\/yolo|\/careful)(\s+|$)/);
  if (!match) return { override: null, message };
  const verb = match[1]!;
  const mode: ApprovalMode = verb === "/yolo" ? "yolo" : "ask";
  // Strip the prefix and the single boundary whitespace char.
  // For `/yolo<EOL>` rest is empty; for `/yolo foo` rest is "foo".
  const rest = message.slice(verb.length).replace(/^\s+/, "");
  return { override: mode, message: rest };
}
