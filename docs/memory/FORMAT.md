# Memory on-disk format

On-disk format spec for ytsejam memory.

Status: **PR-1a active spec** — primitive I/O reads and writes this tree directly. The format is intentionally markdown-first: files are grep-able, patch-able, and git-versioned. Future code should preserve these invariants unless a later memory-format PR explicitly changes this document.

## Store root and path rules

The memory root is resolved by `server/src/memory/store/paths.ts`:

1. `YTSEJAM_MEMORY_DIR`, if set.
2. `${YTSEJAM_DATA_DIR}/memory`, if `YTSEJAM_DATA_DIR` is set.
3. The ytsejam default data memory directory.
4. During the fold migration window only, the legacy live store is used if the default does not exist and the legacy store does. A deprecation warning is logged.

All API paths are POSIX-style relative paths under the root. Absolute paths and any `..` traversal are rejected. `.git/` is never scanned by list/search/stats/L0 operations.

## Known file types

- `*/hot-memory.md` — L0 header + free-form hot context.
- `*/observations.md` — append-only observations in `- YYYY-MM-DD [tags]: text` format.
- `*/action-items.md` — action items in `- [ ] task | due: | pri: | added:` format.
- `*/entities.md` — compact 3-line entries under `### Name` headings.
- `*/INDEX.md` — generated or curated domain index files. Whole-file `write` is allowed.
- `cog-meta/patterns.md` — distilled, timeless operating patterns. Update with append/patch, not whole-file write.
- `cog-meta/improvements.md` — improvement backlog and implemented items. Update with append/patch, not whole-file write.
- `cog-meta/self-observations.md` — Cog's self-observations. Update with append/patch.
- `cog-meta/scenario-calibration.md` — calibration notes. Whole-file `write` is allowed.
- `cog-meta/scenarios/*.md` — active scenario assumptions with YAML frontmatter. Whole-file `write` is allowed for direct children.
- `cog-meta/reflect-cursor.md` — reflection cursor/checkpoint. Whole-file `write` is allowed.
- `cog-meta/foresight-nudge.md` — foresight nudge state. Whole-file `write` is allowed.
- `cog-meta/evolve-log.md` — evolve run log. Whole-file `write` is allowed.
- `cog-meta/evolve-observations.md` — evolve observations. Whole-file `write` is allowed.
- `cog-meta/scorecard.md` — scorecard state. Whole-file `write` is allowed.
- `wiki/**/index.md` — wiki pages with YAML frontmatter + body.
- `glacier/**/*.md` — read-only archive files with YAML frontmatter.
- `domains.yml` — domain manifest. Whole-file `write` is allowed.
- `link-index.md` — generated reverse wiki-link index. Whole-file `write` is allowed.
- `glacier/index.md` — generated glacier catalog. Whole-file `write` is allowed.
- `wiki/index.md` — generated wiki catalog; covered by `*/INDEX.md` only if uppercase, so use generated-index code in later PRs rather than primitive `write` unless the allow-list is deliberately extended.

## L0 headers

Every ordinary domain markdown file should start with a one-line L0 summary:

```md
<!-- L0: summary (max 80 chars) -->
```

Rules:

- The L0 comment is line 1 for hot/canonical domain files.
- The summary is short, human-readable, and stable enough to be used in an index.
- The primitive outline operation reports L0 as `{ level: 0, text, line }`.
- The L0 index scans only the first line of each file and emits `path: summary`.
- Wiki files use YAML frontmatter instead of L0 as their primary metadata; see `docs/memory/WIKI-TIER.md`.

## Observations

Observation files are append-oriented. Each non-blank appended line to a path ending in `observations.md` must match:

```md
- YYYY-MM-DD [tags]: text
```

Examples:

```md
- 2026-06-12 [insight, memory]: Primitive store now runs in-process.
- 2026-06-12 [health]: Slept well; energy stable.
```

Rules:

- Date is ISO `YYYY-MM-DD`.
- Tags live inside one bracket pair and are comma-separated when multiple tags are present.
- Text after `:` is required.
- Blank lines are ignored for validation.
- HTML comments and fenced code blocks are skipped by higher-level observation scanners.

## Action items

Action item files use markdown checkboxes plus pipe-separated metadata:

```md
- [ ] task | due:YYYY-MM-DD | pri:high | added:YYYY-MM-DD | done:YYYY-MM-DD
```

Rules:

- Open items start with `- [ ] `.
- Completed items use `- [x] ` or `- [X] `.
- The task text is the first pipe segment.
- Recognized metadata keys are `due`, `pri`/`priority`, `added`, and `done`.
- Dates are ISO `YYYY-MM-DD` when present.
- Scanners ignore checkbox-looking lines inside HTML comments and fenced code blocks.

## Entity registries

Entity files are compact registries. Each entity entry should fit in at most three non-blank, non-comment lines:

```md
### Name (relation)
fact one | fact two | [[wiki:optional-detail]]
status: active | last: 2026-06-12
```

Rules:

- Heading level is `###`.
- The name is free text; relation in parentheses is recommended when it clarifies the edge.
- Facts are pipe-separated, terse, and current.
- Metadata line should include `status:` and `last:`.
- Longer detail belongs in a wiki page linked from the facts line, not in the registry block.

## Temporal markers

Temporal comments mark content that is intentionally time-bound:

```md
<!-- until:YYYY-MM-DD grace:N -->
<!-- from:YYYY-MM-DD -->
```

Rules:

- `until` means the statement should be reviewed or removed after the date; `grace` is an optional number of days.
- `from` marks content that should become active on or after the date.
- Markers should sit adjacent to the line or section they qualify.
- Higher-level audits may flag expired markers; primitive I/O preserves them verbatim.

## Whole-file write allow-list

Primitive `write(path, content)` is intentionally narrow. Use `append` and `patch` for canonical memory content. Whole-file writes are allowed only for:

- `*/INDEX.md`
- `link-index.md`
- `glacier/index.md`
- `domains.yml`
- `cog-meta/scenario-calibration.md`
- `cog-meta/scenarios/*.md` (direct children only)
- `cog-meta/reflect-cursor.md`
- `cog-meta/foresight-nudge.md`
- `cog-meta/evolve-log.md`
- `cog-meta/evolve-observations.md`
- `cog-meta/scorecard.md`

Additionally, if `domains.yml` declares a domain id whose storage path is different, writes and appends that use the id as the first path segment are rejected. Example: if domain `dakota` lives at `projects/dakota`, `dakota/INDEX.md` is invalid and `projects/dakota/INDEX.md` is the intended path.

`move(from, to)` applies the same destination allow-list as `write` and rejects existing destinations.

## Wiki frontmatter

Wiki pages are long-form, durable reference pages. They live under `wiki/**/index.md` and use YAML frontmatter followed by markdown body. The canonical detailed rules are in `docs/memory/WIKI-TIER.md`.

Minimum conventions:

```md
---
title: Page title
category: project|person|concept|reference
status: active|draft|archived
tags: [tag-one, tag-two]
updated: YYYY-MM-DD
related: [wiki/other/index.md]
---

# Page title
```

Rules:

- Frontmatter keys should be lowercase snake/kebab-compatible names.
- `tags` and `related` are YAML arrays.
- Wiki pages may be linked from compact entity entries when the entity needs more than three lines.

## Glacier YAML frontmatter

Glacier files are archive records. They are read-mostly and indexed from YAML frontmatter:

```md
---
type: observation-log|decision|transcript|archive
domain: domain-id
tags: [tag]
date_range: YYYY-MM-DD..YYYY-MM-DD
entries: 42
summary: One sentence summary.
---
```

Rules:

- `tags` is always treated as an array by indexers.
- `entries` is numeric when present.
- `summary` is short enough to display in generated catalogs.
- `glacier/index.md` is generated and can be overwritten by primitive `write`.

## domains.yml schema

`domains.yml` declares canonical domain ids and paths:

```yaml
version: 1
domains:
  - id: personal
    path: personal
    label: Personal
    type: domain
    triggers: [personal, me]
    files: [hot-memory, action-items, observations, entities]
    subdomains:
      - id: work-example
        path: work/example
        label: Example Work
        files: [hot-memory, observations]
```

Rules:

- `version` is optional but should be `1` when present.
- `domains` is a list.
- `id` is globally unique across top-level domains and subdomains.
- `path` is relative to the memory root, with no absolute paths and no `..` components.
- `files` contains bare basenames without `.md` and without slashes.
- `subdomains` repeat the same shape.
- Domain paths, not ids, are the source of truth for write targets.

## Primitive operation semantics

- `read` returns UTF-8 content; missing files return empty content with `found: false`.
- `append` ensures exactly enough newline separation at EOF and ensures appended text ends with a newline.
- Section append inserts under the named markdown heading before the next same-or-shallower heading; missing headings are errors.
- `patch` replaces an exact text occurrence only when it appears exactly once.
- `outline` returns all `##` and deeper ATX headings plus any L0 header.
- `list` returns sorted `.md` paths relative to root.
- `search(query)` performs case-insensitive literal substring search across all `.md` files. It matches the Go reference `strings.Contains(strings.ToLower(line), strings.ToLower(query))`: regex metacharacters are matched literally and never throw, so `search("(a|b)")` looks for the literal string `(a|b)`, not regex alternation.
- `stats` returns counts and RFC3339 modified timestamps.
- `git` runs inside the memory root and returns trimmed command output.

## References

- `docs/memory/RPC-CONSOLIDATION.md` — envelope shapes and consolidated RPC semantics.
- `docs/memory/WIKI-TIER.md` — wiki frontmatter rules.
- `server/data/reference/cog-skills/skills/cog/SKILL.md` and sibling `SKILL.md` files — format conventions agents are taught.
