import type { ApprovalMode } from "../lib/types";

interface ApprovalToggleProps {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
}

export function ApprovalToggle({ mode, onChange, disabled }: ApprovalToggleProps) {
  const STABLE_LABEL = "Require approvals for risky tools";
  const isAsk = mode === "ask";
  const next: ApprovalMode = isAsk ? "yolo" : "ask";
  const label = isAsk ? "ASK" : "YOLO";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isAsk}
      aria-label={STABLE_LABEL}
      title={STABLE_LABEL}
      disabled={disabled}
      onClick={() => onChange(next)}
      className={[
        "inline-flex h-7 items-center rounded border px-2 text-xs font-mono",
        "transition-colors disabled:opacity-50 disabled:pointer-events-none",
        "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        isAsk
          ? "border-border text-muted-foreground hover:bg-accent"
          : "border-warning/60 bg-warning/15 text-warning hover:bg-warning/25",
      ].join(" ")}
    >
      <span aria-hidden="true">{label}</span>
    </button>
  );
}
