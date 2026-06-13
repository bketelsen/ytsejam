# Documentation — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Verify Cross Reference Targets Before Linking

When adding a doc cross-reference, open the target file and confirm its actual content matches the link's promise — do not trust the filename or the task brief. In README.md's Security model section, a link meant to help adopters "harden further" pointed at `docs/agents/tooling.md`, which is an auto-generated lessons-learned log (JSDoc and import-hoisting notes), not the intended `docs/agents/tools.md` (the real tool-surface and registration reference under `server/src/tools/`). A wrong link is worse than none: it wastes the reader's attention precisely when they need accurate guidance and undercuts the section's credibility. Treat brief-supplied paths as fallible — `tooling.md` vs `tools.md` is exactly the kind of near-identical name a brief author conflates, so reviewers must validate them rather than implement literally. Also scrub private details from public docs (e.g., private hostnames) and sanity-check quantitative claims (the `node_modules` size was ~364 MB, not ~200 MB).

_Added: 2026-06-12 | Task: Task 3 of release-public-prep: Add a `## Prerequisites` sect_

## Derive Script Docs By Mentally Executing

When writing adopter-facing prose in `deploy/README.md` (or any doc) that describes what a script does, derive each claim by mentally executing the script's actual filesystem operations — not by paraphrasing its comments or intent. For example, `deploy/migrate-to-folded.sh` runs `mv "$LEGACY" "$TARGET"`, which renames the store *to* `~/.ytsejam/data/memory`; describing it as moving the store *under* that path is wrong because `mv` does not nest the source inside the destination. The existing brief-author pre-check (re-grep HEAD before claiming file state) does not catch this class of derived-prose error, so explicitly trace the on-disk result of `mv`, `cp`, `rm`, and similar commands before asserting outcomes. Additionally, when a cleanup script intentionally retains an artifact as a rollback safety net (e.g. the `~/.local/bin/cogmemory` binary) and announces it only in a runtime log line, enumerate that retained artifact in the doc too, since README readers won't see the log until after they run the script.

_Added: 2026-06-12 | Task: Task 5 — make migration scripts fresh-install-friendly + restructure deploy/READM_

## Verify Command Behavior Before Documenting It

When writing docs prose that claims what a user will see from a command (curl output, error-message format, exit behavior) or what a script writes or overwrites, RUN the command and READ the script's full body first — paraphrasing inline comments or a man page is not enough. Task 6 shipped three such defects in README.md: it said users would see `unauthorized` from `curl -fsS .../api/models`, but `curl -f` suppresses the 4xx body and exits 22 (running it once exposes this; the fix dropped `-f`); it told users to hand-edit `~/.config/systemd/user/ytsejam.service` to fix the node PATH, but `deploy/install.sh:38` copies the unit file unconditionally and silently reverts that edit on re-install (reading install.sh:29-38, not just one line, exposes this; the durable fix edits `deploy/ytsejam.service` in the repo); and it under-enumerated `rm -rf ~/.ytsejam` as deleting only sessions/memory/schedules/env when the data dir also holds user-authored persona/ and skills/ plus tasks/, archived/, workdirs/, and the sqlite index (an `ls` of the real dir exposes this). The discipline: verify external behavior against the actual artifact, never against your memory of it. This is the command-behavior sibling of "Derive Script Docs By Mentally Executing" (which covers prose about non-interactive script effects) — apply that lesson for what a script does, and this one for what a command or script visibly outputs or overwrites.

_Added: 2026-06-12 | Task: Task 6 — README polish: add First run / Uninstall / Trou_

## Precompute Markdown Slugs Before Linking

When you author a heading that another section will link to, compute the expected slug with the renderer's real algorithm (github-slugger for GitHub) before writing it, then write the heading so it produces that slug. Do not infer the anchor from punctuation patterns or copy it from an earlier draft, because a wrong guess breaks every cross-link silently and the link-checker may not catch it if the target is absent. This applies to USAGE.md, MEMORY.md, and any docs carrying cross-section links. Pin the slug first, then phrase the heading to match.

_Added: 2026-06-13 | Task: Tasks 1-6 of USAGE+MEMORY docs — multiple anchor fix_

## Name The Canonical Sibling Reference Form

When a convention has multiple plausible sibling forms across docs, such as the wiki-link variants `[[wiki/people/liam]]` versus `[[wiki/people/liam/index]]`, the brief must name which form is canonical so the implementer does not guess and ship the wrong one. The canonical no-`/index` form defined in WIKI-TIER.md was missed initially and needed fix-cycle commit `ab6a1e3` to align the MEMORY.md examples. Run a sibling-doc consistency scan for any factual claim that crosses into another doc's territory before dispatching. Cite the source of truth rather than restating it from memory.

_Added: 2026-06-13 | Task: Task 4 quality fix — wiki-link form alignment with WIKI_

## Cite Schema Docs Do Not Enumerate

When a cookbook or recipe section specifies file-level schemas such as frontmatter fields, format keys, or table columns, instruct the implementer to cite the canonical schema doc rather than enumerate field names from memory. Inline enumeration tends to copy plausible names from a design doc that itself drifted from the live schema; in this run the wiki frontmatter listed `type:` and `created:` when the canonical fields are `entity_type:` and `updated:`, caught only at quality review. A pointer with a citation stays correct as the schema evolves, while a copied list silently goes stale. Prefer pointer-with-citation over inline field lists.

_Added: 2026-06-13 | Task: Task 5 quality fix — wiki frontmatter schema correctn_

## Resolve Contradictory Authority Claims Once

When two adjacent sections assert the same authority claim in conflicting ways, choose the more accurate framing and align the other to it in a single pass. In USAGE.md §2.5 the table was initially called the SSOT while the note below correctly named the installed-skills directory as the SSOT; the fix was to make the table a mirror of the SSOT, not the SSOT itself. Scan the whole doc for symmetric authority statements and reconcile them deliberately rather than leaving the reader to spot the conflict. Establish which artifact is canonical and phrase every reference to defer to it.

_Added: 2026-06-13 | Task: Task 2 quality fix — §2.5 catalog SSOT framing_
