/**
 * Live smoke test against a real Ollama service — NOT hermetic, so gated
 * behind LTM_OLLAMA_LIVE=1 and skipped by default `npm test`.
 *
 *   LTM_OLLAMA_LIVE=1 npm test
 *
 * Requires Ollama on localhost:11434 (or OLLAMA_BASE_URL) with
 * `nomic-embed-text:latest` pulled.
 */

import { describe, expect, it } from "vitest";
import { OllamaEmbedder } from "../src/embedding/ollama-embedder.ts";

describe.skipIf(process.env.LTM_OLLAMA_LIVE !== "1")(
  "ollama live smoke (LTM_OLLAMA_LIVE=1)",
  () => {
    it("embeds against real nomic-embed-text and returns a 768-dim unit vector", async () => {
      const embedder = await OllamaEmbedder.create({
        model: "nomic-embed-text:latest",
        baseUrl: process.env.OLLAMA_BASE_URL,
      });
      expect(embedder.dimension).toBe(768);
      const v = await embedder.embed("hello world");
      expect(v).toHaveLength(768);
      const sumSquares = v.reduce((s, x) => s + x * x, 0);
      expect(Math.abs(sumSquares - 1)).toBeLessThan(1e-9);
    });
  },
);
