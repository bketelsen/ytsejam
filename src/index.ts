/**
 * LTM — long-term memory for ytsejam sessions.
 *
 * Typical use:
 *   const mem = MemorySystem.open({ storeDir });
 *   await mem.ingestSessionDir(sessionsDir);
 *   const context = await mem.composeContext(latestUserMessage);
 */

export { MemorySystem, type MemorySystemOptions } from "./api/memory-system.ts";
export { HashEmbedder, type Embedder, cosine, tokenize } from "./embedding/embedder.ts";
export { CachedEmbedder } from "./embedding/cached-embedder.ts";
export {
  LocalEmbedder,
  type LocalEmbedderOptions,
  type FeatureExtractionPipeline,
  type PipelineFactory,
} from "./embedding/local-embedder.ts";
export { promoteFacts } from "./retrieval/promote.ts";
export { VectorIndex } from "./embedding/vector-index.ts";
export { Bm25Index } from "./retrieval/lexical.ts";
export { Retriever, packToBudget } from "./retrieval/retriever.ts";
export { EpisodicStore } from "./episodic/store.ts";
export { retention, ageDays } from "./episodic/decay.ts";
export { scoreSalience } from "./episodic/salience.ts";
export { chunkText } from "./episodic/chunk.ts";
export { consolidate, extractiveSummary, type Summarizer } from "./episodic/consolidate.ts";
export { SemanticStore, effectiveStrength } from "./semantic/store.ts";
export { PreferenceGraph, USER_NODE } from "./semantic/graph.ts";
export { extractFacts, extractEntities, normalizeObject } from "./semantic/extract.ts";
export { readSessionFile, listSessionFiles, activeBranch, messageText } from "./session/reader.ts";
export { IngestPipeline, type IngestReport } from "./pipeline/ingest.ts";
export { JsonlLog } from "./store/jsonl-log.ts";
export * from "./types.ts";
export type * from "./session/format.ts";
