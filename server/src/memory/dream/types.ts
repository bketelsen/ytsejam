export type ProposalKind = "drop" | "merge" | "resolve" | "add";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  factIds: string[];
  add?: { kind: string; predicate: string; object: string; polarity: 1 | -1; sourceRef: { sessionId: string; entryId: string } };
  canonical?: { kind: string; predicate: string; object: string; polarity: 1 | -1 };
  rationale: string;
  confidence: number;
  status: "pending" | "applied" | "dismissed";
}

export interface DreamState {
  lastRunDate: string | null;
  cursorMs: number;
  maintenanceSessionId: string | null;
}

export interface MechanicalSummary {
  backup: string;
  canonicalized: number;
  merged: number;
  folded: number;
  pruned: number;
  embedded: number;
}
