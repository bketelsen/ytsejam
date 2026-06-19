import { extractFacts, type FactCandidate } from "./extract.ts";
export type { FactCandidate };

/**
 * Pluggable fact extraction. The pure package ships only the regex impl;
 * the server injects an LLM-backed extractor via MemorySystem.open().
 */
export interface FactExtractor {
  /** Extract durable user facts from one turn's text. Returns [] when none. */
  extract(text: string): Promise<FactCandidate[]>;
}

/** Default/offline extractor: wraps the legacy regex extractFacts. */
export class RegexFactExtractor implements FactExtractor {
  async extract(text: string): Promise<FactCandidate[]> {
    return extractFacts(text);
  }
}
