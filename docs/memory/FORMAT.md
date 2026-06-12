# Memory on-disk format

On-disk format spec for ytsejam memory.

Status: **STUB** — to be filled during PR-1a as we port primitive I/O.

## Known file types

- `*/hot-memory.md` — L0 header + free-form hot context.
- `*/observations.md` — append-only observations in `- YYYY-MM-DD [tags]: text` format.
- `*/action-items.md` — action items in `- [ ] task | due: | pri: | added:` format.
- `*/entities.md` — compact 3-line entries under `### Name` headings.
- `cog-meta/patterns.md` — distilled, timeless operating patterns.
- `cog-meta/improvements.md` — improvement backlog and implemented items.
- `cog-meta/self-observations.md` — Cog's self-observations.
- `wiki/**/index.md` — wiki pages with YAML frontmatter + body.
- `glacier/**/*.md` — read-only archive files with YAML frontmatter.
- `domains.yml` — domain manifest.
- `link-index.md` — reverse wiki-link index.
- `glacier/index.md` — generated glacier catalog.
- `wiki/index.md` — generated wiki catalog.

## L0 headers

Every domain `.md` file's line 1 is `<!-- L0: summary (max 80 chars) -->`.
Wiki uses YAML frontmatter instead.

## References

- `docs/memory/RPC-CONSOLIDATION.md` — envelope shapes and consolidated RPC semantics.
- `docs/memory/WIKI-TIER.md` — wiki frontmatter rules.
- `server/data/reference/cog-skills/skills/cog/SKILL.md` and sibling `SKILL.md` files — format conventions agents are taught.
