import type { L0IndexParams, L0IndexResult } from "../types.ts";
import { l0Index as storeL0Index } from "../store/outline.ts";
import { validateParams } from "./params.ts";

/**
 * L0 index envelope. Delegates to the Go-faithful store helper, which
 * matches Go's `store.L0Index`: walks all non-`.tmp` files (NOT just `.md`)
 * and extracts the `<!-- L0: ... -->` header line.
 */
export async function l0index(params: L0IndexParams = {}): Promise<L0IndexResult> {
  validateParams(params as Record<string, unknown>, ["domain"]);
  const index = await storeL0Index(params.domain);
  return { index };
}
