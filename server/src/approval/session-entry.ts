import type { ApprovalMode } from "./types.ts";
import { APPROVAL_MODE_DEFAULT, isApprovalMode } from "./types.ts";

/**
 * Walk a session's tree entries newest-first, return the most recent
 * set_approval_mode entry's mode. Default if none found.
 */
export function deriveApprovalMode(entries: ReadonlyArray<{ type: string; mode?: unknown }>): ApprovalMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "set_approval_mode" && isApprovalMode(entry.mode)) {
      return entry.mode;
    }
  }
  return APPROVAL_MODE_DEFAULT;
}
