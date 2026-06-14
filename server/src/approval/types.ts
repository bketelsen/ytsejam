/** Allowed per-session approval modes. */
export type ApprovalMode = "yolo" | "ask";

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
