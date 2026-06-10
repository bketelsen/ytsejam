import type { CogClient, SessionBrief } from "./client.ts";

/**
 * Session-start memory injection: one session_brief RPC rendered as the
 * "## Memory (cog)" system-prompt section. The conventions text is a
 * faithful port of the original cog CLAUDE.md, rewritten to the cog_*
 * tool vocabulary (persona section omitted — persona.md owns voice).
 */

export const COG_CONVENTIONS = `You have persistent memory across sessions, served by the cog daemon through the cog_* tools. Paths are relative to the memory root (e.g. "personal/observations.md"). Write immediately — don't wait to save something worth remembering.

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
7. ALWAYS write to a domain's *path* from the Domains table below, never its id — the daemon rejects id-as-path writes
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
  /** per-fetch cap so a hung daemon can't stall session start; default 1500ms */
  timeoutMs?: number;
}

export class CogBriefProvider {
  private cached?: { section: string; at: number };
  private lastGood?: SessionBrief;

  private readonly client: CogClient;
  private readonly role: string;
  private readonly opts: BriefProviderOptions;

  constructor(client: CogClient, role: string, opts: BriefProviderOptions = {}) {
    this.client = client;
    this.role = role;
    this.opts = opts;
  }

  /** Render the "## Memory (cog)" prompt section. Never throws. */
  async promptSection(): Promise<string> {
    const ttl = this.opts.ttlMs ?? 60_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.section;

    let section: string;
    try {
      const brief = await this.fetchBrief();
      this.lastGood = brief;
      section = renderSection(brief);
    } catch {
      section = this.lastGood
        ? renderSection(this.lastGood, "(memory snapshot may be stale — daemon unreachable)")
        : renderUnavailable(this.client.socketPath);
    }
    this.cached = { section, at: Date.now() };
    return section;
  }

  private fetchBrief(): Promise<SessionBrief> {
    const timeoutMs = this.opts.timeoutMs ?? 1_500;
    return Promise.race([
      this.client.sessionBrief(this.role),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("session_brief fetch cap exceeded")), timeoutMs),
      ),
    ]);
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

function renderUnavailable(socketPath: string): string {
  return `## Memory (cog)

The cog memory daemon is unreachable (socket: ${socketPath}). cog_* tools will fail until it is back. If the user asks about remembered context, say memory is temporarily unavailable. Everything else works normally.`;
}
