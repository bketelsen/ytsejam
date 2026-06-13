/**
 * Type-soundness tests for the EpisodicKind union (PLAN-FOLLOWUP Task 3).
 *
 * These tests are mostly compile-time proofs, enforced by `npm run check`
 * (tsc type-checks test/): EpisodicKind in types.ts must be the truth —
 * exactly the set of kinds that can appear in episodic.jsonl — and promoted
 * profile facts (kind: "fact") must be a distinct, retrieval-only type that
 * the compiler rejects at persist boundaries. tsc reports unused
 * @ts-expect-error directives as errors, so each directive below is itself
 * an assertion that the marked line genuinely fails to type-check.
 */

import { describe, expect, it } from "vitest";
import type { EpisodicRecord, PromotedFact, SemanticFact } from "../src/index.ts";

function episodic(kind: EpisodicRecord["kind"]): EpisodicRecord {
  return {
    id: `rec-${kind}`,
    kind,
    sessionId: "s1",
    role: "user",
    text: "hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    salience: 0.5,
    accessCount: 0,
    state: "active",
  };
}

const fact: SemanticFact = {
  id: "fact-identity-name-brian-p",
  kind: "identity",
  predicate: "name",
  object: "Brian",
  objectNorm: "brian",
  polarity: 1,
  strength: 0.9,
  mentionCount: 1,
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  sources: [{ sessionId: "s1", entryId: "e1" }],
  state: "active",
};

describe("EpisodicKind soundness (FOLLOWUP 3)", () => {
  it("a switch over EpisodicRecord.kind is exhaustive with exactly turn | consolidated | observation", () => {
    // Compile-time proof the union is closed: this only type-checks while
    // every EpisodicKind arm is handled, because the default branch demands
    // that r.kind has narrowed to never.
    const label = (r: EpisodicRecord): string => {
      switch (r.kind) {
        case "turn":
          return "turn";
        case "consolidated":
          return "consolidated";
        case "observation":
          return "observation";
        default: {
          const unreachable: never = r.kind;
          return unreachable;
        }
      }
    };
    expect(label(episodic("turn"))).toBe("turn");
    expect(label(episodic("consolidated"))).toBe("consolidated");
    expect(label(episodic("observation"))).toBe("observation");
  });

  it("narrowing is real: a switch missing an arm fails the never check", () => {
    const partial = (r: EpisodicRecord): string => {
      switch (r.kind) {
        case "turn":
          return "turn";
        default: {
          // @ts-expect-error — the "consolidated" arm is missing, so r.kind
          // narrows to "consolidated" here, not never. If tsc ever flags this
          // directive as unused, the union has collapsed to a single member.
          const unreachable: never = r.kind;
          return String(unreachable);
        }
      }
    };
    expect(partial(episodic("turn"))).toBe("turn");
  });

  it('kind: "fact" is not constructible as an EpisodicRecord', () => {
    // @ts-expect-error — "fact" is not an EpisodicKind; promoted facts are PromotedFact.
    const bad: EpisodicRecord = { ...episodic("turn"), kind: "fact" };
    void bad;
  });

  it("PromotedFact is a distinct shape the compiler keeps out of persist paths", () => {
    const promoted: PromotedFact = {
      id: `fact/${fact.id}`,
      kind: "fact",
      fact,
      sessionId: "s1",
      entryId: "e1",
      role: "summary",
      text: "The user's name is Brian.",
      timestamp: fact.lastSeenAt,
      salience: fact.strength,
      accessCount: 0,
    };

    // @ts-expect-error — a PromotedFact must never flow into code typed
    // EpisodicRecord (store upserts, consolidation, doctor inspection).
    const asEpisodic: EpisodicRecord = promoted;
    expect(asEpisodic.kind).toBe("fact");

    // Runtime discrimination over the retrieval union works on `kind`.
    const discriminate = (record: EpisodicRecord | PromotedFact): string =>
      record.kind === "fact" ? record.fact.predicate : record.kind;
    expect(discriminate(promoted)).toBe("name");
    expect(discriminate(episodic("turn"))).toBe("turn");
  });
});
