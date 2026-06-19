import type { ProfileSummary } from "ltm";
import type { RecallResult, RecallHit } from "./recall.ts";

export interface MemorySectionDeps {
  profile: () => ProfileSummary | undefined;
  recall: (query: string, opts?: { filterTags?: string[] }) => Promise<RecallResult>;
  activeProjectTag: (sessionId: string) => string | null;
}

function renderProfile(p: ProfileSummary | undefined): string | undefined {
  if (!p) return undefined;
  const lines: string[] = [];
  const add = (label: string, items?: { predicate: string; object: string }[]) => {
    for (const i of items ?? []) lines.push(`- ${label}: ${i.predicate} ${i.object}`);
  };
  add("identity", p.identity);
  add("preference", p.preferences);
  add("directive", p.directives);
  add("attribute", p.attributes);
  return lines.length ? `What you know about the user:\n${lines.join("\n")}` : undefined;
}

const MAX_HITS = 6;

export async function buildMemorySection(
  deps: MemorySectionDeps,
  sessionId: string,
  query: string,
): Promise<string | undefined> {
  const tag = deps.activeProjectTag(sessionId);
  const profileBlock = renderProfile(deps.profile());
  let recallBlock: string | undefined;
  try {
    const r = await deps.recall(query, tag ? { filterTags: [tag] } : undefined);
    const hits = r.hits.slice(0, MAX_HITS).map((h: RecallHit) => `- (${h.from}) ${h.text}`);
    if (hits.length) recallBlock = `Relevant memory:\n${hits.join("\n")}`;
  } catch {
    /* best-effort: recall failures don't surface to caller */
  }
  const parts = [profileBlock, recallBlock].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}
