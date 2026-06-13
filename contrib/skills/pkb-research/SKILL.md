---
name: pkb-research
description: Maintain a long-running research file for a single question — ingest sources one at a time over days or weeks, keep a living synthesis that always answers the question given everything seen so far. Use when the user says "research", "start researching X", "add this to my research on X", "what do we know about X so far", or feeds a URL/file with a research framing.
triggers: [research, pkb-research, synthesis, ingest source, add to research, what do we know, living document, long-running research, /pkb-research]
---

# PKB Research

A long-running research file is a **standing answer to one question**, refined every time a new source is added. There is no session, no open/close — only the question, the sources, and the current best answer.

## Storage layout (cog wiki tier)

For a question with slug `<slug>` (kebab-cased from the question, trimmed of stopwords, ≤6 words):

```
wiki/research/<slug>/
├── index.md          # question, sources list, append-only timeline
├── synthesis.md      # current best answer — REWRITTEN every add/resynthesize
└── sources/
    └── NNN-<source-slug>.md   # one file per source, 001-, 002-, ...
```

All writes via `cog_write` / `cog_append`. All reads via `cog_read` / `cog_search`.

## Verbs

The skill exposes four verbs. Pick the one that matches the user's intent. If ambiguous, ask.

### `start <question>`

Idempotent. If `wiki/research/<slug>/index.md` exists, just `cog_read` it and report current state. Otherwise create:

- `index.md` with frontmatter `title`, `question`, `slug`, `created`, `updated`, `tags: [research]`, sections `## Question`, `## Sources` (empty), `## Timeline` (empty).
- `synthesis.md` with frontmatter and body: `## Question`, `## Current answer` ("_No sources ingested yet._").

Report path and slug to the user.

### `add <url-or-path-or-text> [to <slug-or-question>]`

The main loop. Resolve target research file by slug or fuzzy match on question; if none given and exactly one was touched recently, use it; otherwise ask.

1. **Detect source type:** `http(s)://` → url (use `web_fetch`); existing file path → file (use `read`); else → raw text.
2. **Dedupe.** For url/path, compute the source key (full URL or absolute path). `cog_search` the slug's `sources/` directory for the key. If found, tell the user "already ingested as `<NNN-slug>`" and SKIP to step 6 (resynthesize) only if they confirm; otherwise stop.
3. **Capture.** Fetch/read content. Compute next ordinal `NNN` (zero-padded, scan existing `sources/`). Derive `<source-slug>` from title or URL path.
4. **Write source file** `wiki/research/<slug>/sources/NNN-<source-slug>.md`:
   - Frontmatter: `source_url` or `source_path` or `source_type: text`, `fetched_at`, `title`, `source_id: NNN`.
   - Body: `## Extracted content` (verbatim, trimmed of nav/boilerplate for URLs), then `## Notes` (your 3–8 line read of what this source contributes to the question — what's new, what conflicts, what's weak).
5. **Append to hub timeline** under `## Timeline` heading: `### NNN — <title>` line, source key, one-sentence takeaway.
6. **Rewrite synthesis** (`resynthesize` step below).
7. Report to user: source NNN added, synthesis updated, one-paragraph delta ("what changed in the answer").

### `resynthesize [<slug-or-question>]`

Rewrite `synthesis.md` without ingesting anything new. Use when the user has been thinking, or wants a fresh pass after several adds.

1. `cog_read` `index.md` for the question.
2. `cog_read` every file in `sources/` (in ordinal order).
3. Construct the synthesis as **the current best answer to the question, given the sources, with explicit uncertainty.** Cite source IDs inline like `[001]`, `[003]`. Sections: `## Question`, `## Current answer`, `## What we don't know`, `## Sources` (numbered list with one-line descriptions).
4. `cog_write` `synthesis.md` with bumped `updated` field.
5. `cog_append` `index.md` under `## Timeline`: `### resynthesized <date>` with a one-line note.

### `show [<slug-or-question>]`

`cog_read` and print `synthesis.md` (the answer). If user asks for sources or timeline, read `index.md` instead.

## Synthesis principles (from Korg)

- **Answer the question.** The synthesis is not a summary of sources, it is an evolving answer.
- **Surface uncertainty.** If sources conflict or evidence is thin, say so explicitly. Don't smooth it over.
- **Cite.** Every claim should trace to a source ID. Unsourced claims are flagged as inference.
- **Rewrite, don't append.** Synthesis is regenerated whole each time — never patched.
- **Push back on weak sources.** If something reads like marketing or noise, note it in that source's `## Notes` and weight it accordingly.

## Slug derivation

Lowercase, strip punctuation, drop stopwords (`a, an, the, of, for, to, in, on, is, are, what, how, why, do, does`), join remaining words with `-`, cap at 6 words. Example: `"What is the best way to deploy bootc images?"` → `best-way-deploy-bootc-images`.

If slug collides with an existing one, append `-2`, `-3`, etc.

## Notes

- Source files are write-once. Re-ingesting a URL replaces nothing — it's a duplicate (skip unless user explicitly wants a re-fetch, in which case write `NNN-<slug>-v2.md`).
- The synthesis lives forever. There is no archive verb. If the question is resolved, the user just stops adding.
- For large URLs, prefer `delegate` to a subagent for fetch + initial extract so the main thread stays free — the subagent returns the extracted text and notes, this skill writes the source file.
