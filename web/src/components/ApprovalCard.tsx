import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import type { ApprovalRequest } from "../lib/types";

interface ApprovalCardProps {
  request: ApprovalRequest;
  onRespond: (decision: "approve" | "deny") => void;
  /** Disable actions while the WebSocket is not healthy; otherwise clicks during reconnect can silently no-op. */
  disabled?: boolean;
}

const TTL_MS = 5 * 60 * 1000;
function computeRemaining(createdAt: number): number {
  if (!Number.isFinite(createdAt)) return 0;
  return Math.max(0, Math.floor((createdAt + TTL_MS - Date.now()) / 1000));
}

export function ApprovalCard({ request, onRespond, disabled }: ApprovalCardProps) {
  const [remaining, setRemaining] = useState(() => computeRemaining(request.createdAt));
  const [responded, setResponded] = useState<"approve" | "deny" | null>(null);
  const params = request.params;
  const paramsJson = useMemo(() => JSON.stringify(params, null, 2), [params]);

  useEffect(() => {
    if (responded) return;
    const t = setInterval(() => setRemaining(computeRemaining(request.createdAt)), 1000);
    return () => clearInterval(t);
  }, [responded, request.createdAt]);

  const handleClick = (decision: "approve" | "deny") => {
    if (responded || disabled) return;
    setResponded(decision);
    onRespond(decision);
  };

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <div data-testid="approval-card" className="flex justify-start">
      <div className="my-1 max-w-[80%] min-w-0 rounded-md border border-border bg-background text-sm text-foreground">
        <header className="flex w-full items-center gap-2 p-2 text-left text-foreground">
          <span className="text-warning">approval required</span>
          <span className="font-mono">{request.toolName}</span>
          {request.toolLabel && <span className="text-xs text-muted-foreground">{request.toolLabel}</span>}
        </header>
        <div className="space-y-2 border-t border-border p-2 font-mono text-xs">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-muted-foreground">
            {paramsJson}
          </pre>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-2">
          <span data-testid="approval-countdown" className="text-xs text-muted-foreground">
            auto-denies in {mm}:{ss}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={!!responded || disabled}
              onClick={() => handleClick("approve")}
              data-testid="approval-approve"
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!!responded || disabled}
              onClick={() => handleClick("deny")}
              data-testid="approval-deny"
            >
              Deny
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
