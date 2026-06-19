import { X } from "lucide-react";
import { Button } from "./ui/button";
import type { LostApproval } from "../lib/types";

interface LostApprovalNoticeProps {
  lost: LostApproval;
  onDismiss: () => void;
}

export function LostApprovalNotice({ lost, onDismiss }: LostApprovalNoticeProps) {
  return (
    <div data-testid="approval-lost" className="flex justify-start">
      <div className="my-1 max-w-[80%] min-w-0 rounded-md border border-border bg-background text-sm text-foreground">
        <div className="flex items-center gap-2 p-2">
          <span className="text-warning">Resolution lost — please retry</span>
          <span className="font-mono">{lost.toolName}</span>
          {lost.toolLabel && <span className="text-xs text-muted-foreground">{lost.toolLabel}</span>}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7"
            onClick={onDismiss}
            aria-label="Dismiss lost approval notice"
          >
            <X />
          </Button>
        </div>
      </div>
    </div>
  );
}
