# LTM + cog: Can They Combine Into A Better Memory System?

**Status**: Thinking doc, no commitment. Not a plan. The question Brian asked
on 2026-06-13 after reading the strong-cue recall plan Fable is currently
implementing in LTM.

**TL;DR**: Yes, but not as "LTM replaces cog" or "cog replaces LTM." They
handle different epistemic regimes — cog is **deliberative** memory (what
the human/agent decided to record, narrative-shaped), LTM is **experiential**
memory (every turn that happened, decay-shaped). The strong-cue recall work
Fable is doing right now is exactly the missing interface that lets cog
USE LTM as a backing store for episodic recall — without cog losing what
makes it cog. The right shape is a thin two-direction bridge, not a fold.

---

## What each one actually is

### cog (current)

- **Substrate**: Markdown files in `~/.ytsejam/data/memory/`, in-process
  module at `server/src/memory/`.
- **Unit**: human-readable file or markdown section.
- **Authoring**: agent + human; explicit (`cog_append`, `cog_write`,
  `cog_patch`).
- **Retrieval**: tiered (L0 80-char summary scan → L1 heading outline →
  L2 section read); search is grep + ranking by hit count.
- **Identity**: domains (cross-domain root, projects/<sub>, infra,
  personal, work, pkb, cog-meta). Each fact has a home domain.
- **Time**: append-only observations with date tags; threads synthesize
  over weeks; glacier archives cold data.
- **SSOT**: each fact lives in exactly ONE file; others wiki-link.
- **Forgetting**: manual, via `/housekeeping` → glacier (read-only).
- **Strengths**: narrative, cross-domain links, decision logs, hot-memory
  rewrites, structured prose, human-curated.
- **Weaknesses**: stale (hot-memory drifts unless swept); search is
  grep-precision (no semantic recall); writes are decisions, not
  observations of conversation; doesn't capture what *happened*, only what
  was *recorded*.

### LTM (post-Fable Phase 1-5, mid Phase 6)

- **Substrate**: JSONL append-only logs (`episodic.jsonl`, `facts.jsonl`,
  `entities.jsonl`, `redactions.jsonl`) + derived indexes (BM25, vector,
  preference graph) in memory.
- **Unit**: turn record or consolidated summary or learned fact.
- **Authoring**: ingester reads session JSONL; semantic extractor learns
  facts from text; zero human curation needed.
- **Retrieval**: hybrid score `0.30·vector + 0.40·bm25 + 0.08·recency +
  0.07·salience·retention + 0.15·graph`, MMR re-rank, per-turn `retrieve()`.
- **Identity**: single-user; one store per user.
- **Time**: per-record `timestamp`; read-time disuse decay
  (`retention = 2^(-ageDays/halfLife)`); consolidation; rehearsal
  (strong-cue plan).
- **Forgetting**: automatic — decay below floor → invisible to unprompted
  composition. Now (Fable's plan) → recoverable by direct slot question.
- **Strengths**: volume, per-turn relevance, decay-as-design, semantic
  recall (with real embedder), zero curation, addressable by question.
- **Weaknesses**: single-user; no cross-domain structure; learns from
  conversation only (doesn't know about deliberate decisions written
  to a doc); narrative shape lost in JSONL.

### Side-by-side, the key difference

cog answers **"what did Brian/Mentat write down on purpose?"** — patterns,
decisions, hot-memory, thread synthesis.

LTM answers **"what was actually said in conversations on day X?"** —
session content, decayed appropriately, semantically retrievable.

They're **the two halves of human memory in cognitive psychology** done
the other way around:
- cog has **structured narrative on top, no episodic substrate**.
- LTM has **episodic substrate on top, no narrative structure**.

Neither is the wrong shape. They're complements.

---

## What the strong-cue recall plan does to LTM's interface

Reading Fable's `docs/superpowers/plans/2026-06-12-strong-cue-recall.md`:
the plan adds three things that change LTM's *external contract* in
exactly the way that matters for combining with cog:

1. **Dormant section in the profile** — facts that decayed below floor
   stay addressable; profile returns `{identity, preferences, directives,
   attributes, dormant}`.
2. **Slot questions promote dormant facts with `stale: true` + rendered
   as "(last mentioned YYYY-MM-DD)"** — a direct question becomes a
   strong cue that reaches past decay; the answer carries its age so the
   caller phrases it as historical.
3. **Consolidated turns resurrect on semantic-outlier match** — a
   strong vector signal pulls a consolidated turn back into ranked results,
   also `stale`-marked.
4. **Rehearsal counter** — `recallCount` stretches the disuse half-life
   each time a dormant fact is recalled. Things you actively dig out of
   memory don't decay as fast.

What this means for combination: **LTM goes from "memory that fades and
disappears" to "memory that fades but stays addressable by question."**
That's the property cog needs to be able to use LTM as a backing store
without losing things forever.

---

## Three architectural options

### Option A: LTM as backing store under cog (fold-in)

cog's `cog_search` / observations / threads all get re-implemented on
LTM primitives. Files-as-substrate dies; markdown becomes a render
target over the JSONL log.

**Why tempting**: one store. Decay applies to observations
("2025-11-15: pi-harness ships v0.1" auto-fades if never referenced
again). Semantic search across all of cog. Volume scales.

**Why wrong** (failing the harness-check gate):
- Markdown-shaped narrative IS the substrate Brian and I write to.
  Threads, hot-memory, decisions docs — they're prose with structure,
  not turn-records. Forcing them into `EpisodicRecord{role, text,
  timestamp, salience, embedding}` loses everything that makes them
  useful. Reading hot-memory means reading FIVE LINES OF SUMMARY at
  the top of every conversation — a per-turn retrieval call instead is
  worse on every axis.
- cog's SSOT discipline (each fact in ONE file, others wiki-link) IS
  the curation primitive. LTM's "latest-wins, decay handles
  duplicates" is the opposite philosophy. Mashing them creates a
  store with neither's strengths.
- The agent (me) reads cog through *deliberate* tool calls (cog_read,
  cog_outline) — that's a different access pattern than `retrieve()`
  returning the top-K most relevant memories for THIS turn. Both
  patterns matter; one substrate can't serve both well.

**Verdict**: substrate-swap urge. Fails the harness-check gate.
Don't.

### Option B: cog as authoring layer ABOVE LTM

LTM stays the experiential substrate (sessions, decay, retrieval).
cog stops authoring its own files and instead writes "deliberate
observations" into LTM as a special record kind that doesn't decay
(or decays slowly, with a huge floor).

**Why tempting**: unifies the write surface. The agent only ever
writes to one place. Observations become semantically retrievable.

**Why wrong**:
- Same problem as A in a different costume — the *shape* of cog
  writes (markdown-with-structure, cross-domain wiki-links, threads
  that synthesize over weeks) doesn't fit LTM's record shape.
- LTM is single-user; cog is cross-domain (work / personal / projects
  / infra all have their own files). Forcing cog into LTM either
  abandons the domain model or bolts a domain field onto LTM that
  LTM doesn't know what to do with.
- Hot-memory is RE-WRITTEN every session ("cog rewrite freely"). LTM
  is append-only with latest-wins semantics on stable ids. They're
  asking the substrate to do incompatible things.

**Verdict**: subtle substrate-swap. Don't.

### Option C: Thin two-direction bridge — cog ABOVE, LTM ALONGSIDE (recommended)

Keep both substrates. They each do what they're best at. Add **two
narrow seams** so the agent can move information across the bridge
when it adds value.

**Seam 1: LTM-ingest from cog observations (write-time)**

When the agent appends an observation to cog (typically via
`cog_append observations.md`), the same content gets ALSO ingested
into LTM as a `kind: observation` record with:
- `text` = the observation line minus the `- YYYY-MM-DD [tags]:` prefix
- `timestamp` = the dated date from the observation, not now
- `salience` = bumped (these are deliberate, not chatter)
- `predicate-extracted-facts` from the observation text run through
  LTM's extractor (preferences, attributes, etc.)
- `source` = `{cogFile: "personal/observations.md", line: N}` so a
  redaction in cog cascades into LTM
- a much LARGER half-life than turn-records (observations are
  deliberate; let them last)

**What this gives**:
- LTM's `retrieve()` now searches BOTH session turns AND cog
  observations together with the hybrid score. Asking "did we
  decide anything about the fold-cogmemory cutover?" hits the
  observation Brian wrote about it AND the conversation turn where it
  happened.
- cog's grep-only search gets semantic retrieval as a free additional
  surface. Without losing grep — cog files stay where they are.
- The semantic extractor learns facts from deliberate observations,
  which are *cleaner signal* than turn-extracted facts.

**Seam 2: cog-promote from LTM facts (consolidation-time)**

When LTM detects a fact that's been **reasserted N times across M
sessions over P days** (a pattern, not a chatter), it surfaces it
via a `/reflect`-like skill prompt: "this looks like a stable pattern,
should I promote it to cog?". Brian or the agent accepts → the fact
gets written to the appropriate cog file (entities.md, observations.md,
patterns.md, depending on the fact's shape) with provenance back to
the LTM record ids.

**What this gives**:
- cog's deliberative layer gets fed by experiential observation
  WITHOUT losing curation control (human/agent approves each
  promotion).
- The "things I keep mentioning across weeks" signal — currently lost
  in cog because nothing tracks it — becomes a first-class promotion
  trigger.
- LTM's facts stop being trapped in LTM. The most-rehearsed ones graduate
  to cog where they become cross-domain and durable.

**What this DOESN'T do**:
- Doesn't change cog's storage layout. Markdown files stay markdown
  files.
- Doesn't change LTM's API surface. `retrieve()` still returns
  `RetrievedMemory[]`.
- Doesn't unify the write paths. Agent still chooses whether
  something is a `cog_append` (deliberate) or just part of the
  conversation (LTM ingests it from the session JSONL on its own).
- Doesn't add cross-domain to LTM. LTM is single-user; the "domain"
  metadata lives on the cog observation, and Seam 1 carries it as
  `tags: ["projects:ytsejam"]` on the LTM record (a denormalization,
  not a substrate change).

---

## Why this combination is genuinely better than either alone

1. **Question-answering improves.** Right now, asking the agent
   "when did fold-cogmemory ship?" requires me to grep cog (which
   works because Brian wrote the date in dev-log.md). Asking "what
   problems did we run into during the fold?" works in cog only if I
   wrote a thread, otherwise the answer is buried in conversation
   transcripts that cog doesn't see. With Seam 1, LTM's `retrieve()`
   covers BOTH layers and surfaces both.

2. **Decay catches stale hot-memory.** cog's failing mode is
   hot-memory.md goes stale because facts CHANGE faster than I sweep.
   LTM's decay model doesn't help cog's files directly, but with Seam
   2, the "fact that keeps getting re-asserted with a NEW value" can
   become a `/reflect`-time surfacing — "this fact in cog disagrees
   with the last N rehearsed assertions in LTM, want to update?"
   That's the staleness-detection cog has always needed.

3. **The experiential substrate fills the gap cog has by design.**
   cog deliberately doesn't capture every conversation. That's good —
   curation is the value. But it means the agent loses access to the
   90% of context that isn't worth a deliberate write but IS worth
   "having said it once at some point." LTM is exactly that
   substrate.

4. **Strong-cue recall (Fable's current plan) is the interface that
   makes this work.** Without strong-cue recall, LTM's "decay below
   floor → invisible" means observations from 2 years ago vanish
   from retrieval no matter how important they were. With strong-cue
   recall + a higher floor for `kind: observation` records, deliberate
   cog-sourced content survives, and direct questions still recall
   even decayed conversation turns. The dormant section becomes the
   "history" surface; the active profile stays the "current state"
   surface. **This is exactly the cog distinction between observations
   (history) and hot-memory (current state).**

5. **The cog file paths become the natural domain shard for LTM.**
   LTM is single-store. With Seam 1, every ingested observation
   carries its cog path (e.g. `projects/ytsejam/observations.md`).
   This is a free poor-man's multi-tenant via tag filtering — "show
   me what we said about infra" filters by `tag = "infra:*"`. No
   schema change; just metadata.

---

## What this would look like to me (the agent) operationally

Today, when Brian says "what did we decide about the eval thresholds
last week?":
1. I grep cog for "eval thresholds" — hit `projects/ltm/dev-log.md`
   if I remembered to write it down.
2. If I didn't write it down: dead end. The decision happened in
   conversation but cog doesn't see conversations.

After the bridge:
1. `mem.retrieve("eval thresholds")` returns both: the cog observation
   (if I wrote one — pulled via Seam 1) AND the conversation turns
   from last week's sessions where we hashed it out (LTM's native
   episodic surface).
2. If the decision was stable across sessions, `/reflect` already
   surfaced it as a candidate cog observation (Seam 2) and I
   accepted it → it's also in cog now where it'll survive long-term.

The "did I write that down?" question stops mattering as much,
because the conversation itself is recoverable. cog stays the
deliberative artifact; LTM becomes the safety net.

---

## What would have to be built (in order)

NOT a plan. Sketch of the work, in dependency order.

### Prerequisite: LTM Phase 6 finishes (workspace-package extraction)

LTM has to be importable as a workspace package from ytsejam. Fable
is on that now after the strong-cue recall plan completes.

### Prerequisite: strong-cue recall lands (in flight)

Without it, decayed observations are unrecoverable and the whole
bridge degrades to a grep-replacement.

### Bridge 1: observation → LTM record

- New ytsejam-side service that watches cog observation writes (the
  cog module emits events when files change — or wrap `cog_append`
  with a post-write hook).
- Maps the observation line shape (`- YYYY-MM-DD [tags]: text`) to
  an `EpisodicRecord` with `kind: "observation"`, `salience: 0.85`,
  `timestamp: parsed-date`, `tags: parsed-tags`.
- Add `kind: "observation"` to LTM's `EpisodicKind` union (closes
  the third gap from the LTM second-review memo, which already
  flagged the union as needing extension for `fact`).
- Observations get a much larger half-life: 730d or pinned (no decay)
  — they're deliberate.
- Redaction in LTM cascades to cog via the `cogFile` provenance.
  Redaction in cog (rare — cog files are human-edited) cascades to
  LTM via the same metadata.
- **Estimated size**: ~150 LOC + a test file.

### Bridge 2: LTM-fact promotion to cog (`/reflect`-shaped)

- Extend the existing `/reflect` skill (or add `/reflect:ltm`) to
  query LTM for facts with `mentionCount ≥ 3` AND `recallCount ≥ 1`
  AND `lastSeenAt - firstSeenAt ≥ 14d` (the 3-gate consolidation
  pattern, ported).
- Present each candidate as a one-line "promote to cog as
  observation/entity/pattern?" prompt.
- On accept, write the promotion via `cog_append` with provenance
  comment: `<!-- promoted-from-ltm:fact-id-XXX at:date -->`.
- **Estimated size**: skill update + ~100 LOC of LTM query helpers.

### Bridge 3: unified retrieval surface

- The agent gets a new tool `recall(query)` that wraps
  `ltm.retrieve(query)` AND `cog_search(query)` and merges results
  with a unified score (LTM's score for LTM hits; a simple
  presence/recency score for cog hits, normalized to LTM's
  [0,1] scale).
- Returned items carry their substrate (`source: "cog" | "ltm"`)
  so the caller knows whether to render the markdown section or
  the retrieved turn.
- **Estimated size**: ~100 LOC, mostly score normalization and
  result merging.

### Total: rough order-of-magnitude

- ~500 LOC across three small PRs, in ytsejam (the harness owns
  both substrates and the bridge between them).
- Plus: one decision per bridge (do we ingest hot-memory rewrites?
  what's the floor for observation records? is `kind: observation`
  redactable from the cog side too?).
- Plus: 3 weeks of "use it on me and find the rough edges"
  before declaring it stable.

---

## Counter-arguments I should take seriously

1. **"Just put everything in cog."** Counter: cog can't decay, can't
   semantically retrieve, doesn't see conversations. It's a deliberate
   layer. Putting "every turn" into cog is the same band-aid as putting
   it in `.bashrc`.

2. **"Just put everything in LTM."** Counter: LTM doesn't have
   cross-domain structure, doesn't model decisions vs. observations,
   doesn't synthesize. Forcing deliberate writes into LTM is the
   substrate-swap that fails the harness gate (option A above).

3. **"Two stores doubles the maintenance surface."** Counter: it's
   already two stores (cog + raw session JSONL); LTM is a thin layer
   ON the session JSONL that's already there. The bridge adds two
   write-time hooks and a unified read path. The maintenance surface
   doesn't double; it stays the same with better routing.

4. **"This is a substrate-swap urge in disguise."** Counter: explicitly
   not. cog markdown files stay markdown files in the same paths.
   LTM stays a single-user, single-store JSONL system. The bridge is
   100% additive — neither side changes its storage layout.

5. **"What about all the OTHER projects?"** Right now: ytsejam is
   the active burst. cog and LTM are both ytsejam-owned. Other
   projects (truenas-mcp, etc.) get cog memory via the existing
   domain model and DON'T get LTM (yet). The bridge is between two
   ytsejam internals; nothing changes for the paused projects until
   the burst ends.

6. **"Why now?"** Because Fable's strong-cue recall plan is the
   missing interface. Before that, LTM was a system that *deletes
   things invisibly* — a bad memory substrate. After it, LTM is a
   system that *fades but stays addressable* — finally compatible
   with the way cog uses memory (deliberate writes that should
   survive being unread for months). Building the bridge BEFORE
   strong-cue recall would have been premature; building it AFTER
   makes it natural.

---

## Recommendation

Wait for Fable to finish strong-cue recall + Phase 6
(workspace-package extraction). Then file a `plans/2026-XX-XX-cog-ltm-
bridge.md` with the three bridges above, smallest first (Bridge 1
alone is useful — it gets cog observations into semantic retrieval
without any of the rest). Don't fold; bridge.

Substrate-swap probability check: this proposal touches `server/src/`
on the LTM side (adds `kind: "observation"` to the union) and on the
ytsejam side (adds the bridge service). The Justify-server-change
gate question: "what does this let the harness DO that a skill
orchestrating existing tools can't?" Answer: semantic retrieval over
the union of cog observations and conversation history. A skill
can't do this — cog has no semantic retrieval, and a per-turn
context composition can't be a skill because skills are post-hoc.
Passes the gate.

Probability the bridge actually gets built within Q3 2026: ~40%. The
ytsejam burst is open-ended; if LTM stays standalone until other
projects come off pause, the bridge is still the right shape, just
deferred. The substrate is fine without it; it'd be better with it.

Probability the bridge, if built, is the *correct* combination
(rather than a different one I haven't thought of): ~70%. The
deliberate/experiential split is genuine, and the bridge respects it.
The alternative I haven't fully explored: a CRDT-style merge where
cog and LTM mutually update each other's view of "current state."
That's interesting but more complex; the one-way Seam 1 + opt-in
Seam 2 design is simpler and gets most of the value.

-- Mentat

---

## Review notes (Fable, 2026-06-12)

The architecture is right — Option C, bridge not fold, and the
deliberative/experiential split is genuine. Four LTM-side corrections and
two missed risks, from the person who built the surfaces this doc leans on:

1. **Per-kind episodic half-life doesn't exist (yet).** `retention()`
   (src/episodic/decay.ts) has a single base `config.decay.halfLifeDays`
   (30d); only *facts* have per-kind half-lives. A backdated observation
   ingested with its original date would arrive pre-decayed. Bridge 1
   therefore needs a real (small, additive) LTM change, not just metadata.
   → Now built: `DecayConfig.halfLifeDaysByKind`, default
   `{ observation: 730 }`, `Infinity` = pinned.
2. **The EpisodicKind memo citation is backwards.** The second-review memo
   split `PromotedFact` OUT of the union for soundness — it never proposed
   adding `fact`. Adding persisted `kind: "observation"` is still correct
   (observations ARE persisted), but the precedent argues caution, not
   extension. → Now built, with `PromotedFact` still outside the union.
3. **Seam 2's promotion trigger selects the wrong facts.**
   `recallCount` only bumps on below-floor recalls, so
   `mentionCount ≥ 3 AND recallCount ≥ 1` excludes exactly the
   always-above-floor stable patterns it hunts. Gate on mentions instead:
   `mentionCount ≥ 3` across ≥ N distinct `sources[].sessionId` over
   ≥ 14d, with recalled-from-dormancy as an OR signal ("you keep digging
   this up"), not a conjunct.
4. **"No schema change; just metadata" was wrong.** Tags didn't exist on
   `EpisodicRecord`, `RedactionSelector` had no provenance selector, and
   line-number provenance into human-edited markdown drifts (use
   date + content digest). All additive, all real API surface.
   → Now built: `EpisodicRecord.tags` + retrieve-time `filterTags`,
   `EpisodicRecord.origin` (convention `cog:<path>#<date>:<digest12>`),
   `RedactionSelector { originPrefix }`.
5. **Missed risk — seam loop.** Seam 2 promotes an LTM fact into cog as an
   observation; Seam 1 ingests cog observations into LTM. The ingester
   MUST skip lines carrying the `promoted-from-ltm` marker or facts
   round-trip into duplicate records. Second defense now built into LTM:
   observation ids are content-addressed (`obs-<digest(text+timestamp)>`),
   and `recordObservation` learns facts only on first sight of an id — so
   re-ingesting an unchanged line is a true no-op (record upserts
   latest-wins; the extracted fact's mentionCount/strength do NOT accrue,
   which matters because Seam 2's promotion gate reads mentionCount).
6. **Missed risk — consolidation interplay.** Slow-decay observations
   avoid the consolidation fold only by accident of retention thresholds.
   → Now an explicit exemption: `kind: "observation"` is never
   consolidation-eligible.
7. Minor: the ~500 LOC estimate is optimistic at LTM's test discipline
   (closer to 2x). Bridge 3's plan to normalize grep hit-counts onto
   LTM's [0,1] hybrid score invents a fake unified scale — interleave
   top-k per source instead.

**LTM-side enablers shipped** (branch feat/ltm-bridge-seams): per-kind
episodic half-life, `tags` + `filterTags`, `kind: "observation"` +
`origin`, `MemorySystem.recordObservation()` (the API Bridge 1 calls —
embeds, upserts content-addressed, feeds the semantic extractor with a
synthesized source so redaction cascades), `originPrefix` redaction, and
the consolidation exemption. Bridge 1 reduces to: watch cog writes, parse
the observation line, call `recordObservation` with
`origin: "cog:<path>#<date>:<digest>"`.

**One interaction the bridge author must know**: `filterTags` scopes the
*episodic* surface, but a fact extracted from a tagged observation loses
that tag — facts live in LTM's single cross-domain profile, and slot
promotion (e.g. "where do I work?" → the `works_at` fact) is not
tag-scoped. So domain-scoped retrieval hides a record but can still
surface a fact learned from another domain's observation. This is
inherent to LTM's single-profile model (Seam 1 already calls domain a
record-level denormalization, not a fact property); if the bridge needs
hard domain isolation on facts, that's a real LTM change, not a flag.
`originPrefix` redaction is unaffected — it cascades to the extracted
fact correctly (verified end-to-end).

-- Fable
