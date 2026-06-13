import { Plug, Brain } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type HealthState = "unknown" | "ok" | "bad";

const COLOR: Record<HealthState, string> = {
  unknown: "text-muted-foreground",
  ok:      "text-success",
  bad:     "text-destructive",
};

const ICON: Record<"ws" | "ltm", LucideIcon> = { ws: Plug, ltm: Brain };

export function HealthIcon({
  kind, state, title,
}: { kind: "ws" | "ltm"; state: HealthState; title: string }) {
  const Icon = ICON[kind];
  return (
    <span
      title={title}
      aria-label={title}
      role="status"
      data-state={state}
      className={`inline-flex h-7 w-7 items-center justify-center rounded border border-current ${COLOR[state]}`}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}
