import { Plug, Brain } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type HealthState = "unknown" | "ok" | "bad";

const COLOR: Record<HealthState, string> = {
  unknown: "text-muted-foreground",
  ok:      "text-success",
  bad:     "text-destructive",
};

const ICON: Record<"ws" | "ltm", LucideIcon> = { ws: Plug, ltm: Brain };

// `border-current` is load-bearing: the ring inherits the same text-* color as the icon
// stroke, so the single COLOR[state] class drives both. Don't "simplify" by dropping it.
// role="img" (not "status") avoids the implicit aria-live=polite that would re-announce
// the tooltip every poll cycle — aria-label provides the accessible name. (Issue #116.)
export function HealthIcon({
  kind, state, title,
}: { kind: "ws" | "ltm"; state: HealthState; title: string }) {
  const Icon = ICON[kind];
  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      data-state={state}
      className={`inline-flex h-7 w-7 items-center justify-center rounded border border-current ${COLOR[state]}`}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}
