import { randomUUID } from "node:crypto";

export type ApprovalDecision = "approve" | "deny" | "timeout";

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  toolName: string;
  toolLabel: string;
  params: unknown;
}

export interface ApprovalCoordinatorOptions {
  /** Default 5 minutes. Tests override. */
  timeoutMs?: number;
  /** Called when an approval is created so transport (WS) can broadcast. */
  onRequest: (req: ApprovalRequest) => void;
  /** Called when an approval resolves so transport can broadcast resolved state. */
  onResolved: (approvalId: string, decision: ApprovalDecision) => void;
}

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;
  private readonly onRequest: ApprovalCoordinatorOptions["onRequest"];
  private readonly onResolved: ApprovalCoordinatorOptions["onResolved"];

  constructor(opts: ApprovalCoordinatorOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onRequest = opts.onRequest;
    this.onResolved = opts.onResolved;
  }

  /**
   * Open an approval. Returns a promise that resolves with the eventual decision
   * (approve / deny / timeout). The transport must call `resolve` for approve/deny;
   * the coordinator itself triggers timeout.
   */
  request(input: Omit<ApprovalRequest, "approvalId">): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(approvalId)) {
          this.onResolved(approvalId, "timeout");
          resolve("timeout");
        }
      }, this.timeoutMs);
      this.pending.set(approvalId, { resolve, timer, sessionId: input.sessionId });
      this.onRequest({ approvalId, ...input });
    });
  }

  /** Called by the WS handler when the client sends a decision. */
  resolve(approvalId: string, decision: "approve" | "deny"): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    this.onResolved(approvalId, decision);
    entry.resolve(decision);
    return true;
  }

  /** Cancel all pending approvals for a session (e.g. on abort). */
  cancelSession(sessionId: string, decision: ApprovalDecision = "deny"): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.onResolved(id, decision);
      entry.resolve(decision);
    }
  }

  /** Snapshot of currently-pending approvals (for client reconnect catch-up). */
  list(): ReadonlyArray<{ approvalId: string; sessionId: string }> {
    return [...this.pending.entries()].map(([approvalId, entry]) => ({
      approvalId,
      sessionId: entry.sessionId,
    }));
  }
}
