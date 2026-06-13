# LTM — Ollama Embedder (production semantic mode)

Standalone follow-up, INDEPENDENT of PLAN-FOLLOWUP.md (Tasks 1-3, in flight
with Fable). Adds an `OllamaEmbedder` to LTM so the semantic eval mode
becomes a **load-bearing, default-available** path on any host running
Ollama — rather than the current "shape-only, model integration deferred"
state of `LocalEmbedder`.

Closes the open gap from the second review:
> Semantic-eval mode is shape-only. ... the seam could regress and nobody
> would notice.

Discipline: same as PLAN.md / PLAN-FOLLOWUP.md. One PR. Commit prefix
`[OLLAMA]`. Gate is
`npm test && npm run check && npm run eval && npm run eval:ollama` (new).
Brian's environment already has Ollama 0.5+ on localhost:11434 with
`nomic-embed-text:latest` (768-dim, 137M params) and `mxbai-embed-large:latest`
(1024-dim, 334M params) pulled.

---

## Why Ollama over the shipped `LocalEmbedder` (transformers.js)

| property | `LocalEmbedder` (transformers.js + MiniLM) | `OllamaEmbedder` |
| --- | --- | --- |
| install cost | optional peerDep, ~100MB runtime + model | zero — already running |
| first-call latency | model cold-load (seconds) | server already warm |
| default dimension | 384 | 768 (nomic) / 1024 (mxbai) |
| MTEB score | ~58 | ~62 (nomic v1.5) |
| offline | yes (after download) | yes (localhost) |
| deterministic | yes | yes (greedy, no temperature) |
| works today | no (model integration deferred) | yes |
| per-call cost | CPU JS inference | HTTP localhost + GPU/CPU inference |

`LocalEmbedder` stays as the in-process option for users without an Ollama
service. `HashEmbedder` stays as the default for reproducible offline tests.
Ollama becomes the practical semantic path for local dev and the eventual
ytsejam fold.

---

## Scope

Strictly additive. No changes to:
- `HashEmbedder` (still the default; `npm test` and `npm run eval` unaffected)
- `LocalEmbedder` (the in-process seam stays)
- the `Embedder` interface
- the cache layer (`CachedEmbedder` is reused as-is)
- any threshold (the medium-band paraphrase ≥ 0.80 raise from
  `semanticThresholds()` is reused unchanged)
- the JSONL store layout (vectors are already persisted per-record;
  swapping embedders means re-ingesting, as the README already documents)

---

## Anti-goals

- **Not making Ollama a default.** The default eval must run without any
  external service.
- **Not adding Ollama to `dependencies` or `peerDependencies`.** The
  embedder uses Node's built-in `fetch` only. No SDK. If `npm i` had to
  pull an Ollama client, this would be the same kind of optional-install
  tax `LocalEmbedder` already pays.
- **Not batching in v1.** Ollama's `/api/embed` accepts arrays, but single
  calls plus `CachedEmbedder` is the simpler shape and the existing
  contract already takes a single string. Batching is a future
  optimization gated on a real latency complaint.
- **Not auto-discovering Ollama.** The user opts in via CLI flag or env
  var. Surprise network calls from a memory library are bad form.

---

## Tasks

### Task O1 — `OllamaEmbedder` adapter

**Where**
- new file `src/embedding/ollama-embedder.ts`
- new file `test/ollama-embedder.test.ts`

**Why**
The `Embedder` interface is `{dimension: number; embed(text): Promise<number[]>}`
returning a unit-norm vector. Ollama's `/api/embed` (newer endpoint, NOT
the legacy `/api/embeddings`) returns
`{model, embeddings: [[…]]}` with normalized vectors. The shape gap is one
HTTP call and a defensive re-norm. The only real design choices are
dimension discovery, error shape, and the model field name.

**Do**

1. Implement `OllamaEmbedder implements Embedder`:
   - Constructor `private` so callers go through `OllamaEmbedder.create()`
     (same pattern as `LocalEmbedder.create()`).
   - `create({ model, baseUrl?, dimension? })`:
     - `baseUrl` default `http://localhost:11434`.
     - If `dimension` omitted, **probe once** by embedding the string
       `"dimension probe"` and reading `embeddings[0].length`. Trust no
       configuration the wire can disagree with.
     - On a probe HTTP error, throw with the URL, model, status, and
       Ollama's error body verbatim — semantic mode failures must point at
       the actual cause.
   - `embed(text)`:
     - POST `${baseUrl}/api/embed` with `{model, input: text}` and
       `Content-Type: application/json`.
     - Read `body.embeddings[0]`.
     - Defensive L2-renormalize before returning (cheap; the index assumes
       unit vectors and the legacy endpoint returns un-normalized data —
       belt-and-suspenders).
     - On HTTP non-2xx OR a missing/empty `embeddings[0]`: throw with
       `{model, status, body}` context.
   - Expose `readonly modelName: string` so `CachedEmbedder` can namespace
     the cache directory by it (same convention as `LocalEmbedder.modelName`).

2. Use the **newer `/api/embed` endpoint** (returns
   `{embeddings: [[…]]}`), NOT the legacy `/api/embeddings` (returns
   `{embedding: [...]}` un-normalized). Comment the choice so the next
   person doesn't "simplify" it back.

3. Test (`test/ollama-embedder.test.ts`) via `globalThis.fetch` mocking —
   no live Ollama in unit tests:
   - probe sets `dimension` from the wire (not the constructor option)
   - second `embed()` reuses the discovered dimension; no second probe
   - HTTP 500 throws with the URL, model, status, and body in the message
   - missing `embeddings[0]` throws with a clear contract-violation message
   - returned vector is unit-norm (sum-of-squares ≈ 1 within 1e-9)
   - `CachedEmbedder` wrapping it cache-hits on repeat calls (use the
     existing `countingEmbedder` pattern but wrap Ollama instead — proves
     the adapter is composable, not just shaped)

4. **Live smoke test** in a separate test file gated behind an env var
   (e.g. `LTM_OLLAMA_LIVE=1`) so it runs only when the developer opts in.
   Asserts a real embed of "hello world" against
   `nomic-embed-text:latest` returns a 768-dim unit-norm vector. NOT run
   by default `npm test` — the standard suite must stay hermetic.

**Done when**
- `src/embedding/ollama-embedder.ts` exports `OllamaEmbedder` matching the
  `Embedder` interface.
- All five mocked tests pass.
- `LTM_OLLAMA_LIVE=1 npm test` on Brian's host hits real Ollama and
  passes.
- `npm run check` clean.

---

### Task O2 — wire Ollama into the eval CLI

**Where**
- `src/eval/run.ts`
- `package.json` (one new script)

**Why**
`run.ts` already accepts `--semantic` which swaps in `LocalEmbedder` + a
raised medium-band paraphrase threshold (`semanticThresholds()`). Adding
Ollama is the same shape: select the embedder, reuse the threshold raise.

**Do**

1. Add CLI flags:
   - `--ollama` (boolean) — opt in
   - `--ollama-model <name>` (default `nomic-embed-text:latest`)
   - `--ollama-url <url>` (default `http://localhost:11434`, or env
     `OLLAMA_BASE_URL`)
2. When `--ollama` is present:
   - construct `OllamaEmbedder` via `create()`
   - wrap in `CachedEmbedder` namespaced by `ollama.modelName`
   - apply the **same** medium-band paraphrase threshold raise to 0.80
     that `--semantic` uses (i.e. extract the raise into a helper, or
     keep two call sites with a shared constant — refactor only if it
     reads cleanly)
3. **Reject `--semantic` and `--ollama` simultaneously** — exits 2 with a
   message ("pick one embedder mode"). One source of truth per run.
4. Add `npm run eval:ollama` to `package.json`:
   ```json
   "eval:ollama": "node src/eval/run.ts --ollama"
   ```
5. **Re-baseline thresholds in the same commit** if measured semantic
   medium-band paraphrase recall lands above the planned 0.80 floor.
   Discipline carried from PLAN.md: thresholds are "measured minus 5pp"
   so a future regression fails loudly. Run all three bands; record the
   short/medium/long paraphrase recall@5 + MRR for the README table
   (next task).

**Done when**
- `npm run eval:ollama` runs end-to-end on Brian's host against the live
  Ollama service, all three bands pass, exit code 0.
- `--semantic` + `--ollama` combined exits 2 with a clear message.
- Per-band measured paraphrase recall numbers are captured in the PR
  description for the README update.

---

### Task O3 — README + commands

**Where**
- `README.md`
- nothing else

**Why**
The maturity table currently says `LocalEmbedder: seam only — shape-tested,
model integration deferred to the ytsejam fold plan`. Ollama makes
semantic eval a **working** mode, not a deferred one. The README has to
reflect that or the gap stays masked.

**Do**

1. **Embedders table** — add a row:
   | mode | embedder | properties |
   | --- | --- | --- |
   | ollama (optional) | `OllamaEmbedder` (`http://localhost:11434`, e.g. `nomic-embed-text`) | real paraphrase similarity via local Ollama service; zero install if Ollama already running; 768-dim default |

2. **Commands block** — add `npm run eval:ollama`.

3. **Per-band eval table** — add a "with Ollama" column or a second table
   showing the new short/medium/long paraphrase recall numbers. The
   `HashEmbedder` table stays — readers need to see the lift the
   real embedder delivers.

4. **Maturity table** — flip the `LocalEmbedder` row from "seam only" to
   "shape-tested; Ollama path is the working semantic mode", and add an
   `OllamaEmbedder` row labeled `stable, mocked-fetch tested, live-smoke
   gated on env var`.

5. One paragraph in the "Embedders" section: "If you already run Ollama
   locally with an embedding model pulled (e.g.
   `ollama pull nomic-embed-text`), `npm run eval:ollama` swaps the
   default `HashEmbedder` for the live model, raises the medium-band
   paraphrase recall threshold to 0.80, and caches embeddings on disk so
   re-runs are free. No additional install."

**Done when**
- README presents Ollama as a first-class semantic mode.
- Per-band measured numbers from Task O2 are in the README.
- The "When NOT to use this" section is unchanged (Ollama is opt-in,
  doesn't change concurrency / multi-tenant / streaming limits).

---

## Ordering

O1 → O2 → O3. Each task is one commit; the whole follow-up is one PR
because the three tasks form one coherent feature (a working semantic
mode). If review wants them split, O1 can land alone (it's pure
addition); O2+O3 can land together later.

Do NOT mix this PR with PLAN-FOLLOWUP Tasks 1-3 — those are touching
different files and have different decision points. Keep merge fronts
narrow.

---

## Risk + mitigation

- **`nomic-embed-text` doesn't clear 0.80 medium-band paraphrase**
  (~15% prior; nomic comfortably outscores MiniLM and Phase 4 already
  hits 75% on short via slot-aware promotion). Fallback: try
  `mxbai-embed-large` (1024-dim, also pulled on Brian's host). If
  neither clears 0.80, lower the threshold to measured-minus-5pp in
  Task O2 and document why in the commit body — the discipline is
  honest measurement, not aspirational thresholds.
- **Ollama API changes endpoint name**. Comment locks in `/api/embed`
  (the newer endpoint) explicitly with a note about why not
  `/api/embeddings`. If Ollama deprecates it, that's a one-line fix
  caught immediately by the live smoke test.
- **Network flakes on localhost** (vanishingly rare). The error path
  surfaces the actual cause; user retries; cache means a partial run
  resumes cheaply.

---

## Out of scope (future)

- **Production embedder via remote API** (OpenAI, Voyage, Cohere). Same
  pattern as `OllamaEmbedder` — different endpoint, different auth.
  Defer until the ytsejam fold plan needs it; ytsejam already has a
  pi-ai catalog that may want to be the surface.
- **Batched embedding calls.** `/api/embed` accepts arrays; calling per
  text wastes connection setup. Worth it only if benchmarking shows
  >20% of ingest time in HTTP overhead.
- **Reranker integration.** Ollama can host rerankers too
  (`bge-reranker-v2-m3`, etc.) — they'd plug into the retrieval layer,
  not the embedder. Out of scope for the seam-fixing intent here.
