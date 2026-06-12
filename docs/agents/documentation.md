# Documentation — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Verify Cross Reference Targets Before Linking

When adding a doc cross-reference, open the target file and confirm its actual content matches the link's promise — do not trust the filename or the task brief. In README.md's Security model section, a link meant to help adopters "harden further" pointed at `docs/agents/tooling.md`, which is an auto-generated lessons-learned log (JSDoc and import-hoisting notes), not the intended `docs/agents/tools.md` (the real tool-surface and registration reference under `server/src/tools/`). A wrong link is worse than none: it wastes the reader's attention precisely when they need accurate guidance and undercuts the section's credibility. Treat brief-supplied paths as fallible — `tooling.md` vs `tools.md` is exactly the kind of near-identical name a brief author conflates, so reviewers must validate them rather than implement literally. Also scrub private details from public docs (e.g., the `snosi` hostname) and sanity-check quantitative claims (the `node_modules` size was ~364 MB, not ~200 MB).

_Added: 2026-06-12 | Task: Task 3 of release-public-prep: Add a `## Prerequisites` sect_
