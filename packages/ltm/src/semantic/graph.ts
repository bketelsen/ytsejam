/**
 * Preference graph, derived on load — never persisted. Nodes are the user
 * plus entity norms; edges come from semantic facts (user → entity) and from
 * entity co-occurrence within episodic records. Deriving rather than storing
 * means redaction can't leave stale edges behind.
 *
 * Retrieval uses one round of spreading activation: query entities light up,
 * energy flows across edges, and episodic records mentioning activated
 * entities get a graph boost.
 */

import type { EpisodicRecord, GraphEdge, SemanticFact } from "../types.ts";
import { extractEntities } from "./extract.ts";

export const USER_NODE = "__user__";

const FACT_RELATION: Record<string, GraphEdge["relation"]> = {
  prefers: "prefers",
  uses: "uses",
  works_at: "works_on",
  works_on: "works_on",
};

export class PreferenceGraph {
  /** node -> neighbor -> weight */
  private adjacency = new Map<string, Map<string, number>>();
  /** episodic record id -> entity norms mentioned in it */
  private recordEntities = new Map<string, string[]>();
  /** entity norm -> episodic record ids mentioning it */
  private entityRecords = new Map<string, Set<string>>();

  static build(facts: SemanticFact[], records: EpisodicRecord[]): PreferenceGraph {
    const graph = new PreferenceGraph();

    for (const fact of facts) {
      if (fact.state !== "active" || fact.supersededBy || !fact.objectNorm) continue;
      const relation = FACT_RELATION[fact.predicate];
      if (!relation) continue;
      const weight = fact.strength * (fact.polarity > 0 ? 1 : 0.6);
      graph.addEdge(USER_NODE, fact.objectNorm, weight);
    }

    for (const record of records) {
      if (record.state !== "active" || !record.text) continue;
      const norms = [
        ...new Set(extractEntities(record.text).map((e) => e.key)),
      ];
      graph.recordEntities.set(record.id, norms);
      for (const norm of norms) {
        let set = graph.entityRecords.get(norm);
        if (!set) {
          set = new Set();
          graph.entityRecords.set(norm, set);
        }
        set.add(record.id);
      }
      for (let i = 0; i < norms.length; i++) {
        for (let j = i + 1; j < norms.length; j++) {
          graph.addEdge(norms[i], norms[j], 0.1);
        }
      }
    }

    return graph;
  }

  private addEdge(a: string, b: string, weight: number): void {
    if (a === b) return;
    this.bump(a, b, weight);
    this.bump(b, a, weight);
  }

  private bump(from: string, to: string, weight: number): void {
    let neighbors = this.adjacency.get(from);
    if (!neighbors) {
      neighbors = new Map();
      this.adjacency.set(from, neighbors);
    }
    neighbors.set(to, Math.min(1, (neighbors.get(to) ?? 0) + weight));
  }

  neighbors(node: string): Map<string, number> {
    return this.adjacency.get(node) ?? new Map();
  }

  /**
   * One-hop spreading activation from the query's entities. Returns
   * record id -> boost in [0, 1].
   */
  activate(queryText: string): Map<string, number> {
    const seeds = new Set(extractEntities(queryText).map((e) => e.key));
    const energy = new Map<string, number>();
    for (const seed of seeds) {
      energy.set(seed, Math.max(energy.get(seed) ?? 0, 1));
      for (const [neighbor, weight] of this.neighbors(seed)) {
        if (neighbor === USER_NODE) continue;
        energy.set(neighbor, Math.max(energy.get(neighbor) ?? 0, 0.5 * weight));
      }
    }

    const boosts = new Map<string, number>();
    for (const [norm, level] of energy) {
      const records = this.entityRecords.get(norm);
      if (!records) continue;
      for (const id of records) {
        boosts.set(id, Math.min(1, (boosts.get(id) ?? 0) + level * 0.5));
      }
    }
    return boosts;
  }

  entitiesOf(recordId: string): string[] {
    return this.recordEntities.get(recordId) ?? [];
  }
}
