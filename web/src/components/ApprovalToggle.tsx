import { Lock, ShieldQuestion, Zap } from "lucide-react";
import type { ApprovalMode } from "../lib/types";

interface ApprovalToggleProps {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
}

// Clicking cycles to the next mode in escalation order (safest → most
// permissive), wrapping yolo → read_only. Mirrors the server's APPROVAL_MODES.
const NEXT: Record<ApprovalMode, ApprovalMode> = {
  read_only: "ask",
  ask: "yolo",
  yolo: "read_only",
};

const LABELS: Record<ApprovalMode, string> = {
  read_only: "READ-ONLY",
  ask: "ASK",
  yolo: "YOLO",
};

// Per-mode visual tone. read_only is success/green (safe + locked), ask is
// subdued neutral, yolo is warning/yellow (risky) — a traffic-light progression.
const TONES: Record<ApprovalMode, string> = {
  read_only: "border-success/60 bg-success/15 text-success hover:bg-success/25",
  ask: "border-border text-muted-foreground hover:bg-accent",
  yolo: "border-warning/60 bg-warning/15 text-warning hover:bg-warning/25",
};

const ICONS: Record<ApprovalMode, typeof Lock> = {
  read_only: Lock,
  ask: ShieldQuestion,
  yolo: Zap,
};

export function ApprovalToggle({ mode, onChange, disabled }: ApprovalToggleProps) {
  const next: ApprovalMode = NEXT[mode];
  const label = LABELS[mode];
  const Icon = ICONS[mode];
  const accessibleName = `Approval mode: ${label}. Activate to switch to ${LABELS[next]}.`;
  return (
    <button
      type="button"
      aria-label={accessibleName}
      title={accessibleName}
      disabled={disabled}
      onClick={() => onChange(next)}
      className={[
        "inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-mono",
        "transition-colors disabled:opacity-50 disabled:pointer-events-none",
        "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        TONES[mode],
      ].join(" ")}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span aria-hidden="true">{label}</span>
    </button>
  );
}
