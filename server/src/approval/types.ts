/**
 * Allowed per-session approval modes.
 * - `yolo`: gated/mutating tools run without prompting.
 * - `ask`: gated/mutating tools pause for a human approval prompt.
 * - `read_only`: gated/mutating tools are auto-DENIED without prompting; only
 *   non-gated read tools run. Escalate to `ask`/`yolo` to allow mutations.
 */
export type ApprovalMode = "yolo" | "ask" | "read_only";

/** All approval modes, in escalation order (safest → most permissive). */
export const APPROVAL_MODES = ["read_only", "ask", "yolo"] as const;

/** Runtime guard usable by config/route/JSONL validation. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "yolo" || value === "ask" || value === "read_only";
}

/**
 * JSONL session entry that persists a per-session approval-mode change.
 * Stored as `type: "set_approval_mode"` in the session's JSONL log.
 * Replayed at session-load time to derive the current mode (last-write-wins).
 */
export interface SetApprovalModeEntry {
  type: "set_approval_mode";
  id: string;
  parentId: string | null;
  timestamp: string;
  mode: ApprovalMode;
}

/** Default approval mode when no valid set_approval_mode entry exists. */
export const APPROVAL_MODE_DEFAULT: ApprovalMode = "yolo";
