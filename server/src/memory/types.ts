/** Root directory for the on-disk memory store. */
export type MemoryRoot = string;

/** Logical memory domain declared in domains.yml. */
export interface Domain {
  id: string;
  path: string;
  label?: string;
  type?: string;
  triggers?: string[];
  files?: string[];
  subdomains?: Domain[];
}

/** Raw domains.yml manifest envelope. */
export interface Manifest {
  version?: number;
  domains: Domain[];
}

/** Resolved domain-owned file target. */
export interface ActionTarget {
  domain: string;
  path: string;
}

/** Result of mapping a memory-root-relative path back to a declared domain file. */
export interface DomainForPathResult {
  domain: string;
  file: string;
  ok: boolean;
}

/** Session-start memory envelope; mirrors server/src/cog/client.ts SessionBrief. */
export interface SessionBrief {
  hot_memory: string;
  patterns: string;
  domains: { id: string; path: string; label?: string; triggers?: string[] }[];
  action_counts: Record<string, number | boolean>;
  controller_last_error: string | null;
}

/** Options for reading part of a memory file. */
export interface ReadOptions {
  section?: string;
  start?: number;
  end?: number;
}

/** Read file result. */
export interface ReadResult {
  content: string;
  found: boolean;
}

/** Write file result. */
export interface WriteResult {
  bytes: number;
}

/** Append, patch, and move success result. */
export interface OkResult {
  ok: boolean;
}

/** Markdown outline row. */
export interface OutlineEntry {
  line: number;
  text: string;
  level: number;
}

/** Outline result. */
export interface OutlineResult {
  entries: OutlineEntry[];
}

/** List result. */
export interface ListResult {
  paths: string[];
}

/** Single full-text search hit. */
export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

/** Search envelope. */
export interface SearchResults {
  results: SearchResult[];
  count: number;
}

/** Per-file stats row. */
export interface FileStats {
  path: string;
  lines: number;
  size: number;
  modified: string;
}

/** Store stats envelope. */
export interface StatsResult {
  files: number;
  lines: number;
  size: number;
  per_file: FileStats[];
}

/** Health check envelope. */
export interface HealthResult {
  ok: boolean;
  files?: number;
  last_commit?: string;
  memory_root?: string;
}

/** Supported git operation names. */
export type GitOperation = "status" | "diff" | "log" | "commit" | "revert";

/** Git operation parameters. */
export interface GitParams {
  op: GitOperation;
  ref?: string;
  commit?: string;
  message?: string;
  paths?: string[];
  limit?: number;
}

/** Git operation result. */
export interface GitResult {
  output: string;
}

/** Parameters for open_actions. */
export interface OpenActionsParams {
  domain?: string;
}

/** One unchecked action item from action-items.md. */
export interface OpenActionItem {
  domain: string;
  path: string;
  line: number;
  text: string;
  raw: string;
  due?: string;
  priority?: string;
  added?: string;
}

/** Open action items envelope. */
export interface OpenActionsResult {
  items: OpenActionItem[];
}

/** Housekeeping numeric thresholds. */
export interface HousekeepingCaps {
  observations_entries: number;
  completed_actions: number;
  improvements_done: number;
  hot_memory_lines: number;
  patterns_lines: number;
  patterns_bytes: number;
  dormant_domain_days: number;
  stale_action_item_days: number;
  changed_recently_fallback_days: number;
}

export interface ObservationsOverCap {
  path: string;
  entries: number;
  cap: number;
  by_primary_tag: Record<string, number>;
}

export interface CompletedActionsOverCap {
  path: string;
  completed: number;
  cap: number;
}

export interface ImprovementsImplementedOverCap {
  path: string;
  implemented: number;
  cap: number;
}

export interface HotMemoryOverCap {
  path: string;
  lines: number;
  cap: number;
}

export interface PatternsOverCap {
  path: string;
  lines: number;
  size: number;
  lines_cap: number;
  size_cap: number;
}

/** Threshold-cap violation groups returned by housekeeping_scan. */
export interface HousekeepingThresholds {
  observations_over_cap: ObservationsOverCap[];
  completed_actions_over_cap: CompletedActionsOverCap[];
  improvements_implemented_over_cap: ImprovementsImplementedOverCap[];
  hot_memory_over_cap: HotMemoryOverCap[];
  patterns_over_cap: PatternsOverCap[];
}

/** Dormant domain reported by housekeeping_scan. */
export interface DormantDomain {
  id: string;
  last_observation: string;
}

/** Stale open action item reported by housekeeping_scan. */
export interface StaleActionItem {
  path: string;
  line: number;
  text: string;
  added: string;
  age_days: number;
}

/** Housekeeping scan envelope. */
export interface HousekeepingScan {
  since: string;
  changed_recently: string[];
  thresholds: HousekeepingThresholds;
  dormant_domains: DormantDomain[];
  stale_action_items: StaleActionItem[];
}

/** Parameters for domain_summary. */
export interface DomainSummaryParams {
  domain: string;
  since?: string;
}

/** One parsed observation line. */
export interface RecentObservation {
  domain: string;
  path: string;
  line: number;
  date: string;
  tags: string[];
  text: string;
}

/** Domain summary envelope. */
export interface DomainSummaryResult {
  domain: string;
  path: string;
  label: string;
  hot_memory: string;
  open_action_count: number;
  completed_action_count_since: number;
  recent_observations: RecentObservation[];
  files_present: string[];
  last_activity: string;
  since: string;
}

/** Parameters for recent_observations. */
export interface RecentObservationsParams {
  since?: string;
  by_tag?: string;
  domain?: string;
}

/** Recent observations aggregate envelope. */
export interface RecentObservationsResult {
  since: string;
  entries: RecentObservation[];
  by_domain: Record<string, number>;
  by_tag: Record<string, number>;
}

/** Parameters for cluster_check. */
export interface ClusterCheckParams {
  domain?: string;
  min_cluster_size?: number;
  since?: string;
  span_days?: number;
  sample_limit?: number;
}

/** Sample observation shown inside a cluster. */
export interface SampleObservation {
  date: string;
  domain: string;
  path: string;
  line: number;
  text: string;
}

/** Tag cluster from cluster_check. */
export interface TagCluster {
  tag: string;
  count: number;
  spans_days: number;
  domains: string[];
  samples: SampleObservation[];
}

/** Keyword cluster from cluster_check. */
export interface KeywordCluster {
  keyword: string;
  count: number;
  spans_days: number;
  domains: string[];
  samples: SampleObservation[];
}

/** Thread candidate from cluster_check. */
export interface ThreadCandidate {
  topic: string;
  fragment_count: number;
  date_range: string;
}

/** Cluster_check envelope. */
export interface Cluster {
  by_tag: TagCluster[];
  by_keyword: KeywordCluster[];
  thread_candidates: ThreadCandidate[];
}

/** Parameters for entity_audit. */
export interface EntityAuditParams {
  domain?: string;
}

export interface EntityFormatViolation {
  path: string;
  domain?: string;
  name: string;
  lines: number;
  issue: string;
  has_detail_file: boolean;
}

export interface EntityGlacierCandidate {
  path: string;
  domain?: string;
  name: string;
  status?: string;
  last?: string;
  age_days?: number;
}

export interface EntityMissingMetadata {
  path: string;
  domain?: string;
  name: string;
  missing: string[];
}

export interface EntityTemporalViolation {
  path: string;
  domain?: string;
  name: string;
  line: number;
  text: string;
  needs: string;
}

/** Entity audit envelope. */
export interface EntityAuditResult {
  format_violations: EntityFormatViolation[];
  glacier_candidates: EntityGlacierCandidate[];
  missing_metadata: EntityMissingMetadata[];
  temporal_violations: EntityTemporalViolation[];
  total_entries: number;
  total_lines: number;
}

/** One suspected missing-link occurrence. */
export interface LinkAuditCandidate {
  source_path: string;
  line: number;
  entity_name: string;
  target_link: string;
  context: string;
}

/** Link audit envelope. */
export interface LinkAuditResult {
  candidates: LinkAuditCandidate[];
}

/** One row of the reverse wiki-link index. */
export interface LinkIndexEntry {
  target: string;
  sources: string[];
}

/** Link index envelope. */
export interface LinkIndexResult {
  links: LinkIndexEntry[];
}

/** Active scenario check row. */
export interface ScenarioEntry {
  path: string;
  check_by: string;
  status: string;
  days_until_check: number;
}

/** Scenario check envelope. */
export interface ScenarioCheckResult {
  scenarios: ScenarioEntry[];
}

/** Glacier index row. */
export interface GlacierEntry {
  path: string;
  domain?: string;
  type?: string;
  tags: string[];
  date_range?: string;
  entries?: number;
  summary?: string;
}

/** Glacier index envelope. */
export interface GlacierIndexResult {
  entries: GlacierEntry[];
  count: number;
}

/** Wiki index row. */
export interface WikiEntry {
  path: string;
  category?: string;
  title?: string;
  status?: string;
  tags: string[];
  summary?: string;
  updated?: string;
  related?: string[];
}

/** Wiki index envelope. */
export interface WikiIndexResult {
  entries: WikiEntry[];
  count: number;
}

/** Parameters for l0index. */
export interface L0IndexParams {
  domain?: string;
}

/** L0 index envelope. */
export interface L0IndexResult {
  /**
   * Newline-joined L0 header text. Go reference returns
   * `strings.Join(lines, "\n")` — a single string blob.
   * PR-2c may widen to a structured row shape if it deliberately
   * improves on the Go output; pinned to string by default.
   */
  index: string;
}
