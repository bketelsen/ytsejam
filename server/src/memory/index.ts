import type {
  ActionTarget,
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
  Manifest,
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

export type * from "./types.ts";

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

/** Load and parse domains.yml from a memory root; filled in PR-1b. */
export async function loadManifest(_root: MemoryRoot): Promise<Manifest> {
  return notImplemented("PR-1b");
}

/** Domain manifest controller for path resolution and validation; filled in PR-1b. */
export class Controller {
  readonly root: MemoryRoot;

  constructor(root: MemoryRoot) {
    this.root = root;
  }

  /** List declared domains from domains.yml; filled in PR-1b. */
  async list(): Promise<Domain[]> {
    return notImplemented("PR-1b");
  }

  /** Get a domain by id from domains.yml; filled in PR-1b. */
  async get(_id: string): Promise<Domain> {
    return notImplemented("PR-1b");
  }

  /** Resolve all action-items targets declared by domains.yml; filled in PR-1b. */
  async actionItems(_domain?: string): Promise<ActionTarget[]> {
    return notImplemented("PR-1b");
  }

  /** Resolve a declared file basename to its memory-root-relative path; filled in PR-1b. */
  async resolveFile(_id: string, _file: string): Promise<string> {
    return notImplemented("PR-1b");
  }

  /** Map a memory-root-relative path to its owning declared domain; filled in PR-1b. */
  async domainForPath(_path: string): Promise<DomainForPathResult> {
    return notImplemented("PR-1b");
  }

  /** Validate that a write path is well-formed for its domain; filled in PR-1b. */
  async validateWrite(_path: string): Promise<void> {
    return notImplemented("PR-1b");
  }

  /** Return the last domains.yml hot-reload error, if any; filled in PR-1b. */
  async lastError(): Promise<string | null> {
    return notImplemented("PR-1b");
  }
}

/** Build the session-start memory brief envelope; filled in PR-2a. */
export async function sessionBrief(): Promise<SessionBrief> {
  return notImplemented("PR-2a");
}

/** Scan memory for housekeeping thresholds and stale items; filled in PR-2a. */
export async function housekeepingScan(): Promise<HousekeepingScan> {
  return notImplemented("PR-2a");
}

/** Return unchecked action items, optionally scoped to a domain; filled in PR-2a. */
export async function openActions(_params: OpenActionsParams = {}): Promise<OpenActionsResult> {
  return notImplemented("PR-2a");
}

/** Summarize one domain's hot memory, actions, and recent observations; filled in PR-2a. */
export async function domainSummary(_params: DomainSummaryParams): Promise<DomainSummaryResult> {
  return notImplemented("PR-2a");
}

/** Return recent observation entries and aggregate counts; filled in PR-2a. */
export async function recentObservations(
  _params: RecentObservationsParams = {},
): Promise<RecentObservationsResult> {
  return notImplemented("PR-2a");
}

/** Detect observation clusters by tag, keyword, and thread candidate; filled in PR-2b. */
export async function clusterCheck(_params: ClusterCheckParams = {}): Promise<Cluster> {
  return notImplemented("PR-2b");
}

/** Audit entity registries for format, age, and temporal issues; filled in PR-2b. */
export async function entityAudit(_params: EntityAuditParams = {}): Promise<EntityAuditResult> {
  return notImplemented("PR-2b");
}

/** Find unlinked entity mentions that should become wiki-links; filled in PR-2b. */
export async function linkAudit(): Promise<LinkAuditResult> {
  return notImplemented("PR-2b");
}

/** Compute the reverse wiki-link index; filled in PR-2b. */
export async function linkIndexCompute(): Promise<LinkIndexResult> {
  return notImplemented("PR-2b");
}

/** Check active scenario files for due and overdue reviews; filled in PR-2b. */
export async function scenarioCheck(): Promise<ScenarioCheckResult> {
  return notImplemented("PR-2b");
}

/** Compute the glacier archive index envelope; filled in PR-2c. */
export async function glacierIndexCompute(): Promise<GlacierIndexResult> {
  return notImplemented("PR-2c");
}

/** Compute the wiki page index envelope; filled in PR-2c. */
export async function wikiIndexCompute(): Promise<WikiIndexResult> {
  return notImplemented("PR-2c");
}

/** Compute the L0 summary index, optionally scoped to a domain; filled in PR-2c. */
export async function l0index(_params: L0IndexParams = {}): Promise<L0IndexResult> {
  return notImplemented("PR-2c");
}
