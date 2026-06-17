import type { L0IndexParams, L0IndexResult } from "../types.ts";
import { l0Index as storeL0Index } from "../store/outline.ts";
import { controller } from "./common.ts";
import { validateParams } from "./params.ts";

/**
 * L0 index envelope. Delegates to the Go-faithful store helper, which
 * matches Go's `store.L0Index`: walks all non-`.tmp` files (NOT just `.md`)
 * and extracts the `<!-- L0: ... -->` header line.
 */
export async function l0index(params: L0IndexParams = {}): Promise<L0IndexResult> {
  validateParams(params as Record<string, unknown>, ["domain"]);
  const domain = params.domain ? controller().find(params.domain) : undefined;
  const prefix = domain?.path ?? params.domain;
  const index = await storeL0Index(prefix);
  return { index };
}
