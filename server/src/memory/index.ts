import type { MemorySystem } from "ltm";
import type {
  Cluster,
  ClusterCheckParams,
  Domain,
  DomainForPathResult,
  DomainSummaryParams,
  DomainSummaryResult,
  EntityAuditParams,
  EntityAuditResult,
  GitParams,
  GitResult,
  GlacierIndexResult,
  HealthResult,
  HousekeepingScan,
  L0IndexParams,
  L0IndexResult,
  LinkAuditResult,
  LinkIndexResult,
  ListResult,
  MemoryRoot,
  OkResult,
  OpenActionsParams,
  OpenActionsResult,
  OutlineResult,
  ReadOptions,
  ReadResult,
  RecentObservationsParams,
  RecentObservationsResult,
  ScenarioCheckResult,
  SearchResults,
  SessionBrief,
  StatsResult,
  WikiIndexResult,
  WriteResult,
} from "./types.ts";
import * as store from "./store/index.ts";
import * as consolidated from "./consolidated/index.ts";
import { glacierIndexCompute as computeGlacierIndex } from "./consolidated/glacier-index-compute.ts";
import { l0index as computeL0Index } from "./consolidated/l0index.ts";
import { wikiIndexCompute as computeWikiIndex } from "./consolidated/wiki-index-compute.ts";
import { clusterCheck as consolidatedClusterCheck } from "./consolidated/cluster-check.ts";
import { entityAudit as consolidatedEntityAudit } from "./consolidated/entity-audit.ts";
import { linkAudit as consolidatedLinkAudit } from "./consolidated/link-audit.ts";
import { linkIndexCompute as consolidatedLinkIndexCompute } from "./consolidated/link-index-compute.ts";
import { scenarioCheck as consolidatedScenarioCheck } from "./consolidated/scenario-check.ts";
import {
  parseObservationLine,
  computeOrigin,
  mirrorToLtm,
} from "./bridge/ltm-observer.ts";

export type * from "./types.ts";
export { Controller, loadManifest } from "./domain/index.ts";
export { memoryRoot } from "./store/index.ts";

const notImplemented = (pr: string): never => {
  throw new Error(`not implemented — ${pr}`);
};

/** Read a memory file or section from the store; filled in PR-1a. */
export async function read(path: string, options: ReadOptions = {}): Promise<ReadResult> {
  return store.read(path, options);
}

/** Write a complete memory file atomically; filled in PR-1a. */
export async function write(path: string, content: string): Promise<WriteResult> {
  return store.write(path, content);
}

/** Append text to a memory file or section; filled in PR-1a. */
export async function append(
  path: string,
  text: string,
  options: { section?: string } = {},
): Promise<OkResult> {
  return store.append(path, text, options);
}

// -- ltm bridge -----------------------------------------------------------

let attachedLtm: MemorySystem | null = null;

/**
 * Attach (or detach via null) an LTM MemorySystem to receive mirrored
 * observation writes. Module-level state is intentional: the memory
 * namespace itself is process-global (paths.ts configures via
 * YTSEJAM_MEMORY_DIR env), and attachLtm follows that pattern.
 */
export function attachLtm(ltm: MemorySystem | null): void {
  attachedLtm = ltm;
}

/**
 * First-class observation recording: formats the canonical line,
 * appends to <domainPath>/observations.md (SSOT), then best-effort
 * mirrors to attached LTM. Cog write succeeds even when LTM throws
 * or is not attached.
 */
export async function recordObservation(args: {
  domainPath: string;
  text: string;
  tags: string[];
  timestamp?: Date;
}): Promise<{
  cog: { ok: true; line: string };
  ltm:
    | { ok: true }
    | { ok: true; skipped: "ltm-not-attached" }
    | { ok: false; error: Error };
}> {
  if (!args.tags || args.tags.length === 0) {
    throw new Error(
      "recordObservation: tags are mandatory (cog SSOT validator requires [...]). Pass at least one tag.",
    );
  }
  const ts = args.timestamp ?? new Date();
  const date = ts.toISOString().slice(0, 10);
  const line = `- ${date} [${args.tags.join(",")}]: ${args.text}`;

  const path = `${args.domainPath}/observations.md`;
  await store.append(path, line + "\n");
  const cog = { ok: true as const, line };

  if (!attachedLtm) {
    return { cog, ltm: { ok: true, skipped: "ltm-not-attached" } };
  }
  const parsed = parseObservationLine(line);
  if (!parsed) {
    // Should be unreachable since we just formatted it ourselves,
    // but defend rather than crash.
    return {
      cog,
      ltm: {
        ok: false,
        error: new Error(
          `internal: failed to re-parse own formatted line: ${line}`,
        ),
      },
    };
  }
  const origin = computeOrigin(args.domainPath, "observations.md", line);
  const ltmResult = await mirrorToLtm(attachedLtm, parsed, origin);
  if (!ltmResult.ok) {
    console.warn(
      `[memory] ltm bridge: recordObservation mirror failed for ${origin}: ${ltmResult.error.message}`,
    );
  }
  return { cog, ltm: ltmResult };
}

/** Replace an exact text occurrence in a memory file; filled in PR-1a. */
export async function patch(path: string, oldText: string, newText: string): Promise<OkResult> {
  return store.patch(path, oldText, newText);
}

/** Return a markdown heading outline plus L0 summary; filled in PR-1a. */
export async function outline(path: string): Promise<OutlineResult> {
  return store.outline(path);
}

/** Move or rename a memory file; filled in PR-1a. */
export async function move(from: string, to: string): Promise<OkResult> {
  return store.move(from, to);
}

/** List memory markdown files in the store; filled in PR-1a. */
export async function list(): Promise<ListResult> {
  return store.list();
}

/** Search memory files with full-text matching; filled in PR-1a. */
export async function search(query: string): Promise<SearchResults> {
  return store.search(query);
}

/** Compute filesystem statistics for the memory store; filled in PR-1a. */
export async function stats(prefix?: string): Promise<StatsResult> {
  return store.stats(prefix);
}

/** Report memory store health and last commit metadata; filled in PR-1a. */
export async function health(): Promise<HealthResult> {
  return store.health();
}

/** Run a supported git operation against the memory store; filled in PR-1a. */
export async function git(params: GitParams): Promise<GitResult> {
  return store.git(params);
}

/** Domain controller exports are implemented in ./domain (PR-1b). */
/** Build the session-start memory brief envelope; filled in PR-2a. */
export async function sessionBrief(params: object = {}): Promise<SessionBrief> {
  return consolidated.sessionBrief(params);
}

/** Scan memory for housekeeping thresholds and stale items; filled in PR-2a. */
export async function housekeepingScan(params: object = {}): Promise<HousekeepingScan> {
  return consolidated.housekeepingScan(params);
}

/** Return unchecked action items, optionally scoped to a domain; filled in PR-2a. */
export async function openActions(params: OpenActionsParams = {}): Promise<OpenActionsResult> {
  return consolidated.openActions(params);
}

/** Summarize one domain's hot memory, actions, and recent observations; filled in PR-2a. */
export async function domainSummary(params: DomainSummaryParams): Promise<DomainSummaryResult> {
  return consolidated.domainSummary(params);
}

/** Return recent observation entries and aggregate counts; filled in PR-2a. */
export async function recentObservations(
  params: RecentObservationsParams = {},
): Promise<RecentObservationsResult> {
  return consolidated.recentObservations(params);
}

/** Detect observation clusters by tag, keyword, and thread candidate; filled in PR-2b. */
export async function clusterCheck(params: ClusterCheckParams = {}): Promise<Cluster> {
  return consolidatedClusterCheck(params);
}

/** Audit entity registries for format, age, and temporal issues; filled in PR-2b. */
export async function entityAudit(params: EntityAuditParams = {}): Promise<EntityAuditResult> {
  return consolidatedEntityAudit(params);
}

/** Find unlinked entity mentions that should become wiki-links; filled in PR-2b. */
export async function linkAudit(params: Record<string, unknown> = {}): Promise<LinkAuditResult> {
  return consolidatedLinkAudit(params);
}

/** Compute the reverse wiki-link index; filled in PR-2b. */
export async function linkIndexCompute(params: Record<string, unknown> = {}): Promise<LinkIndexResult> {
  return consolidatedLinkIndexCompute(params);
}

/** Check active scenario files for due and overdue reviews; filled in PR-2b. */
export async function scenarioCheck(params: Record<string, unknown> = {}): Promise<ScenarioCheckResult> {
  return consolidatedScenarioCheck(params);
}

/** Compute the glacier archive index envelope; filled in PR-2c. */
export async function glacierIndexCompute(): Promise<GlacierIndexResult> {
  return computeGlacierIndex();
}

/** Compute the wiki page index envelope; filled in PR-2c. */
export async function wikiIndexCompute(): Promise<WikiIndexResult> {
  return computeWikiIndex();
}

/** Compute the L0 summary index, optionally scoped to a domain; filled in PR-2c. */
export async function l0index(params: L0IndexParams = {}): Promise<L0IndexResult> {
  return computeL0Index(params);
}
