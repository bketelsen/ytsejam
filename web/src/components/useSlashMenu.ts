import { useEffect, useMemo, useState } from "react";
import type { SkillSummary } from "../lib/types";
import {
  acceptSlash,
  slashMenuState,
  type RankedSkill,
  type SlashMenuState,
} from "./slashMenu";

export type { RankedSkill, SlashMenuState };

export interface UseSlashMenu extends SlashMenuState {
  activeIndex: number;
  setActiveIndex: (n: number) => void;
  /** Build the new draft to commit when the user accepts a row. */
  accept: (name: string) => string;
}

/**
 * React adapter over the pure slashMenuState derivation. Owns the
 * activeIndex state and clamps it when the items list shrinks (e.g. user
 * types another char that narrows the matches).
 */
export function useSlashMenu(
  draft: string,
  skills: SkillSummary[],
): UseSlashMenu {
  const state = useMemo(() => slashMenuState(draft, skills), [draft, skills]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  useEffect(() => {
    if (state.items.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex > state.items.length - 1) {
      setActiveIndex(state.items.length - 1);
    }
  }, [state.items.length, activeIndex]);
  return { ...state, activeIndex, setActiveIndex, accept: acceptSlash };
}
