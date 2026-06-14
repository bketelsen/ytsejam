# Documentation — Project Lessons

Rules learned from fix cycles. Cap: 30 entries — prune oldest if exceeded.

> Structural / "how the docs are organized" notes (not lessons) belong in
> [`OVERVIEW.md`](OVERVIEW.md) § Subsystem docs and in the relevant subsystem
> doc itself. This file is an append-only log of `## <Title>` lesson sections
> captured by `contrib/skills/lessons/SKILL.md`.

## Verify Cross Reference Targets Before Linking

When adding a doc cross-reference, open the target file and confirm its actual content matches the link's promise — do not trust the filename or the task brief. Near-identical names (`tooling.md` vs `tools.md`) are the exact kind of conflation a brief author makes; a wrong link is worse than none — it wastes reader attention precisely when accurate guidance is needed. Sanity-check quantitative claims against reality too.

(seen in: README.md Security section linked to docs/agents/tooling.md — a lessons log — when intent was docs/agents/tools.md, the tool-surface reference)

_Added: 2026-06-12 | Task: Release-public-prep Task 3_

## Verify External Behavior Against The Artifact Not Your Memory

Whether the artifact is a command (curl output, exit code), a script (`mv`/`cp`/`rm` semantics), or a config file the deploy unconditionally overwrites — run it, read it end-to-end, `ls` the real directory. Paraphrasing inline comments, man pages, or your memory of the artifact ships defects the brief-author pre-check (re-grep HEAD) doesn't catch, because the wrong claim is in derived prose, not in a code identifier. For scripts that retain artifacts as rollback safety nets, enumerate the retained item in the doc — README readers won't see the runtime log line.

(seen in: README.md said `curl -fsS ... /api/models` would print `unauthorized`; `-f` suppresses 4xx bodies and exits 22. Said hand-edit `~/.config/systemd/user/ytsejam.service`; `deploy/install.sh` re-copies the unit unconditionally. Under-enumerated `rm -rf ~/.ytsejam`. Said `migrate-to-folded.sh` moves the store "under" `~/.ytsejam/data/memory`; `mv` renames it TO that path.)

_Added: 2026-06-12 | Task: Release-public-prep Tasks 5–6 (merged from 2 entries)_

## Precompute Markdown Slugs Before Linking

When you author a heading that another section will link to, compute the expected slug with the renderer's real algorithm (github-slugger for GitHub) before writing it, then write the heading so it produces that slug. Do not infer the anchor from punctuation patterns or copy it from an earlier draft, because a wrong guess breaks every cross-link silently and the link-checker may not catch it if the target is absent. This applies to USAGE.md, MEMORY.md, and any docs carrying cross-section links. Pin the slug first, then phrase the heading to match.

_Added: 2026-06-13 | Task: Tasks 1-6 of USAGE+MEMORY docs — multiple anchor fix_

## Name The Canonical Sibling Reference Form In The Brief

When a convention has multiple plausible sibling forms (e.g. `[[wiki/people/liam]]` vs `[[wiki/people/liam/index]]`), the brief must name which form is canonical so the implementer doesn't guess and ship the wrong one. Run a sibling-doc consistency scan for any factual claim that crosses into another doc's territory before dispatching; cite the source of truth rather than restating it from memory.

(seen in: WIKI-TIER.md canonical no-`/index` form missed in MEMORY.md examples; fix-cycle commit ab6a1e3 to align)

_Added: 2026-06-13 | Task: Task 4 quality fix — wiki-link form alignment with WIKI_

## Cite Schema Docs Do Not Enumerate

When a cookbook or recipe section specifies file-level schemas such as frontmatter fields, format keys, or table columns, instruct the implementer to cite the canonical schema doc rather than enumerate field names from memory. Inline enumeration tends to copy plausible names from a design doc that itself drifted from the live schema; in this run the wiki frontmatter listed `type:` and `created:` when the canonical fields are `entity_type:` and `updated:`, caught only at quality review. A pointer with a citation stays correct as the schema evolves, while a copied list silently goes stale. Prefer pointer-with-citation over inline field lists.

_Added: 2026-06-13 | Task: Task 5 quality fix — wiki frontmatter schema correctn_

## Reconcile Conflicting Authority Claims In One Pass

When two adjacent sections assert the same authority claim in conflicting ways, choose the more accurate framing and align the other to it in a single pass — don't leave the reader to spot the conflict. Scan the whole doc for symmetric authority statements and reconcile them deliberately. Establish which artifact is canonical and phrase every reference to defer to it.

(seen in: USAGE.md §2.5 — table called the SSOT while the note below correctly named the installed-skills directory as SSOT; fix made the table a mirror)

_Added: 2026-06-13 | Task: Task 2 quality fix — §2.5 catalog SSOT framing_
