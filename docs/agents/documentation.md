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
