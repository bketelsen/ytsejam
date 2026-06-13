/**
 * On-disk embedding cache (PLAN.md Task 4.1). Wraps any Embedder with a
 * SHA-256-keyed JSON file cache so a paid/slow embedder costs once per
 * distinct text — re-runs of the eval (or re-ingests) hit the cache.
 *
 * The cache key namespaces by embedder identity + dimension so two models
 * never serve each other's vectors. Files live two-level-fanned under
 * cacheDir (<aa>/<hash>.json) to keep directories listable.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Embedder } from "./embedder.ts";

export class CachedEmbedder implements Embedder {
  readonly dimension: number;
  private readonly inner: Embedder;
  private readonly cacheDir: string;
  private readonly namespace: string;
  /** In-memory layer above the disk cache. */
  private readonly memo = new Map<string, number[]>();

  constructor(inner: Embedder, cacheDir: string, namespace = "default") {
    this.inner = inner;
    this.dimension = inner.dimension;
    this.cacheDir = cacheDir;
    this.namespace = namespace;
  }

  private keyFor(text: string): string {
    return crypto
      .createHash("sha256")
      .update(`${this.namespace}:${this.dimension}:${text}`)
      .digest("hex");
  }

  private pathFor(key: string): string {
    return path.join(this.cacheDir, key.slice(0, 2), `${key}.json`);
  }

  async embed(text: string): Promise<number[]> {
    const key = this.keyFor(text);
    const memoized = this.memo.get(key);
    if (memoized) return memoized;

    const filePath = this.pathFor(key);
    try {
      const cached = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
      if (Array.isArray(cached) && cached.length === this.dimension) {
        this.memo.set(key, cached);
        return cached;
      }
    } catch {
      // miss or corrupt entry — recompute and overwrite
    }

    const vector = await this.inner.embed(text);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(vector));
    fs.renameSync(tmp, filePath);
    this.memo.set(key, vector);
    return vector;
  }
}
