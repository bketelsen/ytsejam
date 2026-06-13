/**
 * Salience heuristics: how intrinsically worth remembering a chunk is,
 * scored in [0, 1] at ingest time. User turns matter more than assistant
 * turns; statements of preference/identity and entity-dense turns matter
 * most; filler ("thanks!", "ok") matters least.
 */

import type { TurnRole } from "../types.ts";

const PREFERENCE_MARKERS =
  /\b(i (really )?(prefer|like|love|hate|dislike|enjoy|use|always|never|want|need)|my (name|favorite|favourite)|call me|from now on|please (always|never)|i'd rather|i am a|i'm a|i work)\b/i;

const FILLER_WORDS = new Set(
  "ok okay thanks thank you got it cool nice yes no sure hmm lol great perfect awesome please yep nope alright".split(" "),
);

function isFiller(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.length > 0 && words.length <= 4 && words.every((w) => FILLER_WORDS.has(w));
}

export function entityDensity(text: string): number {
  const caps = text.match(/\b[A-Z][a-zA-Z0-9]+\b/g) ?? [];
  const code = text.match(/`[^`]+`/g) ?? [];
  const words = text.split(/\s+/).length;
  return Math.min(1, (caps.length + code.length) / Math.max(8, words));
}

/**
 * A declarative first-person sentence ("I picked up my old Telecaster…") is
 * a self-disclosure — far more durable than a task request ("Can you help me
 * debug…?"). True when any non-question sentence references the speaker.
 */
export function hasSelfDisclosure(text: string): boolean {
  for (const sentence of text.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    if (sentence.trim().endsWith("?")) continue;
    if (/\b(i|my|we|our)\b/i.test(sentence) && !/\b(can|could|would|will) you\b/i.test(sentence)) {
      return true;
    }
  }
  return false;
}

export function scoreSalience(text: string, role: TurnRole): number {
  const trimmed = text.trim();
  if (!trimmed || isFiller(trimmed)) return 0.05;

  let score = role === "user" ? 0.45 : role === "summary" ? 0.5 : 0.25;

  if (PREFERENCE_MARKERS.test(trimmed)) score += 0.3;
  if (role === "user" && hasSelfDisclosure(trimmed)) score += 0.15;
  score += 0.15 * entityDensity(trimmed);

  // Substance bonus: very short turns rarely carry durable information.
  const words = trimmed.split(/\s+/).length;
  if (words < 5) score -= 0.15;
  else if (words > 30) score += 0.05;

  return Math.max(0.05, Math.min(1, score));
}
