// server/src/memory/dream/dream-job.ts
import fs from "node:fs";
import path from "node:path";
import type { MemorySystem } from "ltm";
import { runMechanicalPass } from "./mechanical.ts";
import { mineProposals } from "./miner.ts";
import { composeReport } from "./report.ts";
import { ProposalStore } from "./proposal-store.ts";
import type { DreamState, MechanicalSummary } from "./types.ts";

export interface DreamJobDeps {
  ltm: MemorySystem;
  reconcile: (o: { force?: boolean; rebuild?: boolean; prune?: boolean }) => Promise<{ pruned: number }>;
  store: ProposalStore;
  storeDir: string;
  dreamDir: string;
  gatherUserTurns: (cursorMs: number) => { turns: { sessionId: string; entryId: string; text: string }[]; newCursorMs: number };
  ensureMaintenanceSession: () => Promise<string>;
  postReport: (sessionId: string, text: string) => Promise<void>;
  getApiKey: () => Promise<string | undefined>;
  model: string;
  baseUrl?: string;
  minConfidence: number;
  tokenBudget: number;
  proposeOnly: boolean;
  idFor: (seed: string) => string;
  now: () => string;
  fetchImpl?: typeof fetch;
}

function loadState(file: string): DreamState {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as DreamState; }
  catch { return { lastRunDate: null, cursorMs: 0, maintenanceSessionId: null }; }
}

export async function runDreamJob(deps: DreamJobDeps): Promise<{ summary: MechanicalSummary | null; proposed: number }> {
  fs.mkdirSync(deps.dreamDir, { recursive: true });
  const stateFile = path.join(deps.dreamDir, "dream-state.json");
  const state = loadState(stateFile);

  // Mechanical pass (deterministic maintenance) — skipped in proposeOnly mode
  const summary: MechanicalSummary | null = deps.proposeOnly
    ? null
    : await runMechanicalPass({ ltm: deps.ltm, reconcile: deps.reconcile, storeDir: deps.storeDir, now: deps.now });

  // Gather new user turns since last cursor position
  const { turns, newCursorMs } = deps.gatherUserTurns(state.cursorMs);

  // Trim to token budget (newest-first, keep as many as fit)
  const budgetedChars = deps.tokenBudget * 4;
  const kept: typeof turns = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    used += t.text.length;
    if (used > budgetedChars) break;
    kept.unshift(t);
  }

  // Collect active facts for the miner, capped (strongest first) so a large
  // profile can't blow the LLM context. User turns are already token-budgeted.
  const MAX_MINER_FACTS = 300;
  const activeFacts = deps.ltm.listFacts().filter((f) => f.state === "active" && !f.supersededBy);
  const selectedFacts = activeFacts.length > MAX_MINER_FACTS
    ? [...activeFacts].sort((a, b) => b.strength - a.strength).slice(0, MAX_MINER_FACTS)
    : activeFacts;
  if (activeFacts.length > MAX_MINER_FACTS) {
    console.warn(`[dream] ${activeFacts.length} active facts; sending the ${MAX_MINER_FACTS} strongest to the miner`);
  }
  const facts = selectedFacts.map((f) => ({ id: f.id, kind: f.kind, predicate: f.predicate, object: f.object, polarity: f.polarity as 1 | -1 }));

  // Mine proposals via LLM
  const excludeKeys = new Set<string>([...deps.store.dismissedKeys(), ...deps.store.appliedKeys()]);
  const proposals = await mineProposals({
    facts,
    userTurns: kept,
    dismissedKeys: excludeKeys,
    getApiKey: deps.getApiKey,
    model: deps.model,
    baseUrl: deps.baseUrl,
    minConfidence: deps.minConfidence,
    idFor: deps.idFor,
    fetchImpl: deps.fetchImpl,
  });

  // Persist proposals
  deps.store.save(proposals);

  // Ensure maintenance session is visible
  const sessionId = await deps.ensureMaintenanceSession();

  // Compose and post the report (build the id→label map once, not per proposal)
  const factTextById = new Map(
    deps.ltm.listFacts().map((f) => [f.id, `${f.kind}/${f.predicate}=${f.object}`]),
  );
  const report = composeReport(
    deps.now().slice(0, 10),
    summary,
    proposals,
    (id) => factTextById.get(id),
  );
  await deps.postReport(sessionId, report);

  // Advance dream-state
  const next: DreamState = {
    lastRunDate: deps.now().slice(0, 10),
    cursorMs: newCursorMs,
    maintenanceSessionId: sessionId,
  };
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));

  // Append dream-log entry
  fs.appendFileSync(
    path.join(deps.dreamDir, "dream-log.jsonl"),
    JSON.stringify({ ranAt: deps.now(), summary, proposed: proposals.length, reportSessionId: sessionId }) + "\n",
  );

  return { summary, proposed: proposals.length };
}
