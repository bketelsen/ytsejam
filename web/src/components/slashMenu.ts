import type { SkillSummary } from "../lib/types";

export type MatchReason = "name" | "trigger" | "all";

export interface RankedSkill {
  skill: SkillSummary;
  reason: MatchReason;
  /** Set when reason === "trigger". The first trigger that matched. */
  matchedTrigger?: string;
}

export interface SlashMenuState {
  open: boolean;
  items: RankedSkill[];
}

/**
 * Pure derivation of slash-menu state from the composer draft.
 *
 * Open contract: draft starts with "/" and contains no whitespace. The user
 * is in command-selection mode while typing the slash token; once they type
 * a space or newline the menu closes (whatever follows is the skill's
 * argument body, not a filter).
 */
export function slashMenuState(
  draft: string,
  skills: SkillSummary[],
): SlashMenuState {
  const open = draft.startsWith("/") && !/\s/.test(draft);
  if (!open) return { open: false, items: [] };
  const query = draft.slice(1).toLowerCase();
  if (query === "") {
    const items: RankedSkill[] = [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ skill: s, reason: "all" }));
    return { open: true, items };
  }
  const prefix: RankedSkill[] = [];
  const trigger: RankedSkill[] = [];
  for (const s of skills) {
    if (s.name.toLowerCase().startsWith(query)) {
      prefix.push({ skill: s, reason: "name" });
      continue;
    }
    const t = s.triggers.find((t) => t.toLowerCase().includes(query));
    if (t) trigger.push({ skill: s, reason: "trigger", matchedTrigger: t });
  }
  const byName = (a: RankedSkill, b: RankedSkill) =>
    a.skill.name.localeCompare(b.skill.name);
  return { open: true, items: [...prefix.sort(byName), ...trigger.sort(byName)] };
}

/** Build the new draft to commit when the user accepts a row. */
export function acceptSlash(name: string): string {
  return `/${name} `;
}
