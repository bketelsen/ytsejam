import type { SessionBrief } from "../memory/index.ts";
import * as memory from "../memory/index.ts";

/**
 * Session-start memory injection: one session_brief RPC rendered as the
 * "## Memory (cog)" system-prompt section. The conventions text is a
 * faithful port of the original cog CLAUDE.md, rewritten to the cog_*
 * tool vocabulary (persona section omitted — persona.md owns voice).
 */

export const COG_CONVENTIONS = `You have persistent memory across sessions, served by the in-process memory module through the cog_* tools. Paths are relative to the memory root (e.g. "personal/observations.md"). Write immediately — don't wait to save something worth remembering.

### Memory tiers

- **Hot** (\`*/hot-memory.md\`) — loaded below every conversation, <50 lines, rewrite freely
- **Warm** (domain files) — read when a domain or skill activates
- **Glacier** (\`glacier/\`) — read-only YAML-frontmattered archives, cataloged in \`glacier/index.md\`

### Retrieval protocol

Every memory file begins with \`<!-- L0: summary (max 80 chars) -->\`.
1. L0 scan — \`cog_rpc("l0index", {domain})\` to find relevant files
2. L1 — \`cog_outline(path)\` to scan section headers of long files
3. L2 — \`cog_read(path, section?)\` — read sections, not whole files, when possible

### Memory rules

1. observations.md is append-only via cog_append: \`- YYYY-MM-DD [tags]: <observation>\`
2. action-items.md: \`- [ ] task | due:YYYY-MM-DD | pri:high/med/low | added:YYYY-MM-DD\`; check off done items with cog_patch
3. entities.md: 3-line registry — \`### Name (relationship)\` / facts / \`status: | last:YYYY-MM-DD\`
4. hot-memory.md: rewrite freely, keep under 50 lines
5. SSOT: each fact lives in exactly ONE file; others reference it with \`[[domain-path/filename]]\` wiki-links, added at write time
6. Temporal validity: time-bounded facts carry \`<!-- until:YYYY-MM-DD grace:N -->\`; stable-since facts \`<!-- from:YYYY-MM-DD -->\`
7. ALWAYS write to a domain's *path* from the Domains table below, never its id — the memory store rejects id-as-path writes
8. cog-meta/patterns.md: edit in place, ≤70 lines of distilled, timeless rules

### File edit patterns

| File | Pattern |
|---|---|
| hot-memory.md | Rewrite freely |
| observations.md | Append only |
| action-items.md | Append new, check off done |
| entities.md | Edit in place (3-line max) |
| cog-meta/patterns.md | Edit in place (≤70 lines) |
| Thread files | Current State: rewrite / Timeline: append |
| glacier/* | Read-only |

### Threads

Read-optimized synthesis files, raised when a topic appears in 3+ observations across 2+ weeks. Spine: Current State → Timeline → Insights. One file forever.

### Consolidation (3 gates, run by /reflect)

1. Cluster: ≥3 entries, same tag, ≥7-day span, ≥3 distinct dates, specific tag
2. Coverage: skip if an existing pattern covers it; REPLACE when a new insight subsumes an old one
3. Synthesis: one actionable line + \`<!-- promoted:YYYY-MM-DD theme:tag -->\` audit trail

Spike: ≥5 entries in <7 days = heating topic (thread candidate, not pattern-ready).

### Glacier thresholds (run by /housekeeping)

- observations.md >50 entries → archive oldest to \`glacier/{domain-path}/observations-{tag}.md\`
- action-items.md >10 completed → \`glacier/{domain-path}/action-items-done.md\`
- glacier files need YAML frontmatter: type, domain, tags, date_range, entries, summary

### Pipeline cadence (manual — suggest to the user, never run unasked)

Weekly: /housekeeping then /reflect in the SAME session (reflect sees cleaned state). Monthly: /evolve. /foresight weekly or on demand. Anti-pattern: running every skill every day — it's theatrical; weekly + monthly is enough.`;

interface BriefProviderOptions {
  /** how long a rendered section stays fresh; default 60s */
  ttlMs?: number;
  /** per-fetch cap so a hung memory call can't stall session start; default 1500ms */
  timeoutMs?: number;
  /** how long a failure-derived section is served before retrying; default 5s */
  failureTtlMs?: number;
}

// A failed fetch is cached only briefly — a transient store problem shouldn't
// leave sessions memory-less for the full success TTL.
const FAILURE_TTL_MS = 5_000;

export class CogBriefProvider {
  private cached?: { section: string; at: number; ttl: number };
  private lastGood?: SessionBrief;
  private inflight?: Promise<string>;

  private readonly opts: BriefProviderOptions;

  constructor(opts: BriefProviderOptions = {}) {
    this.opts = opts;
  }

  /** Render the "## Memory (cog)" prompt section. Never throws. */
  promptSection(): Promise<string> {
    if (this.cached && Date.now() - this.cached.at < this.cached.ttl) {
      return Promise.resolve(this.cached.section);
    }
    // concurrent cold-cache callers share one fetch
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const ttl = this.opts.ttlMs ?? 60_000;
    let section: string;
    try {
      const brief = await this.fetchBrief();
      this.lastGood = brief;
      section = renderSection(brief);
      this.cached = { section, at: Date.now(), ttl };
    } catch {
      section = this.lastGood
        ? renderSection(this.lastGood, "(memory snapshot may be stale — memory temporarily unavailable)")
        : renderUnavailable();
      this.cached = { section, at: Date.now(), ttl: Math.min(this.opts.failureTtlMs ?? FAILURE_TTL_MS, ttl) };
    }
    return section;
  }

  private fetchBrief(): Promise<SessionBrief> {
    const timeoutMs = this.opts.timeoutMs ?? 1_500;
    let timer: NodeJS.Timeout;
    return Promise.race([
      memory.sessionBrief(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("session_brief fetch cap exceeded")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

function renderSection(brief: SessionBrief, note?: string): string {
  const parts = [`## Memory (cog)`];
  if (note) parts.push(note);
  parts.push(COG_CONVENTIONS);

  if (brief.controller_last_error) {
    parts.push(`⚠ domains.yml problem: ${brief.controller_last_error}`);
  }

  parts.push(`### Hot memory\n\n${brief.hot_memory.trim() || "(empty)"}`);
  parts.push(`### Patterns\n\n${brief.patterns.trim() || "(empty)"}`);

  const rows = brief.domains.map(
    (d) => `| ${d.id} | ${d.path} | ${d.label ?? ""} | ${(d.triggers ?? []).join(", ")} |`,
  );
  parts.push(`### Domains\n\n| id | path | label | triggers |\n|---|---|---|---|\n${rows.join("\n")}`);

  const counts = Object.entries(brief.action_counts)
    .filter(([k, v]) => k !== "_pri_high_anywhere" && typeof v === "number" && v > 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  const pri = brief.action_counts._pri_high_anywhere === true;
  if (counts || pri) {
    parts.push(
      `### Open actions\n\n${counts || "none"}${pri ? " (high-priority items present)" : ""}`,
    );
  }

  return parts.join("\n\n");
}

function renderUnavailable(): string {
  return `## Memory (cog)

Memory is temporarily unavailable. cog_* tools may fail until the in-process memory store is reachable. If the user asks about remembered context, say memory is temporarily unavailable. Everything else works normally.`;
}
