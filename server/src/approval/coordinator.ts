import { randomUUID } from "node:crypto";

export type ApprovalDecision = "approve" | "deny" | "timeout";

export interface ApprovalRequest {
  approvalId: string;
  createdAt: number;
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
  request: ApprovalRequest;
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
   *
   * If `onRequest` throws, the returned promise rejects with that error AND the
   * pending entry remains registered until the timeout fires. Callers (transport
   * layer) must ensure `onRequest` does not throw, or wrap it themselves.
   */
  request(input: Omit<ApprovalRequest, "approvalId" | "createdAt">): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const fullRequest: ApprovalRequest = { approvalId, createdAt: Date.now(), ...input };
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(approvalId)) {
          this.onResolved(approvalId, "timeout");
          resolve("timeout");
        }
      }, this.timeoutMs);
      this.pending.set(approvalId, { resolve, timer, request: fullRequest });
      this.onRequest(fullRequest);
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
      if (entry.request.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      try {
        this.onResolved(id, decision);
      } catch {
        // Trusted callback failing must not strand sibling approvals.
        // Swallow to guarantee atomicity of the cancel sweep.
      }
      entry.resolve(decision);
    }
  }

  /** Snapshot of currently-pending approvals (for client reconnect catch-up). */
  list(): ReadonlyArray<ApprovalRequest> {
    return [...this.pending.values()].map((entry) => entry.request);
  }
}
