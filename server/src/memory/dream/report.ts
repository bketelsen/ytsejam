import type { Proposal, MechanicalSummary } from "./types.ts";

export function composeReport(
  date: string, s: MechanicalSummary | null, proposals: Proposal[], factById: (id: string) => string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`── Memory maintenance · ${date} ──`);
  if (s === null) {
    lines.push("Autonomous: skipped (propose-only).");
  } else {
    lines.push(
      `Autonomous (done): canonicalized ${s.canonicalized}, merged ${s.merged}, folded ${s.folded}, pruned ${s.pruned}, embedded ${s.embedded}.`,
    );
  }
  if (proposals.length === 0) {
    lines.push("", "No proposals — nothing needs your review.");
    return lines.join("\n");
  }
  lines.push("", `Needs your call (${proposals.length}):`);
  proposals.forEach((p, i) => {
    const targets = p.factIds.map((id) => factById(id) ?? id).join(" + ");
    let head: string;
    if (p.kind === "drop") head = `DROP ${targets}`;
    else if (p.kind === "merge") head = `MERGE ${targets} → ${p.canonical?.predicate}=${p.canonical?.object}`;
    else if (p.kind === "resolve") head = `CONFLICT ${targets}`;
    else head = `ADD ${p.add?.predicate}=${p.add?.object}`;
    lines.push(` ${i + 1}. [${p.id}] ${head} — ${p.rationale}`);
  });
  lines.push("", "Reply: `apply all` · `apply 1,2` · `dismiss 3` · `explain 2`");
  return lines.join("\n");
}
