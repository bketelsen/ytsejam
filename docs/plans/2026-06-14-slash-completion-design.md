# Slash-Command Completion Overlay — Design

> Source of truth for the implementation plan at `2026-06-14-slash-completion.md`.
> Approved conversationally 2026-06-14 (Brian + Mentat). v1 = Tier 1 only.

## Goal

When the user types `/` at the **start** of an empty composer in the chat UI,
open a positioned overlay listing the available skills, filterable by name
prefix or trigger substring. Selecting one inserts `/<name> ` into the
textarea. No client-side dispatch — the LLM still interprets the slash via the
existing system-prompt routing table (`SkillsStore.promptSection()`).

## Non-goals (deferred)

1. UI-action commands (`/new`, `/archive`, `/cwd`, `/model`, etc.) — different
   surface, mixing them blurs the model.
2. Path/file completion (`@-mention` style).
3. Wiki-link completion for `[[…]]`.
4. Per-skill argument completion — skills are zero-arg by convention.
5. Fuzzy ranking (Fuse.js, Levenshtein). Prefix + substring over ~29 entries
   is enough.
6. Recently-used / pinned ordering — yagni until the menu feels long.
7. Removing or shortening the Skills table in the system prompt — kept as-is.

## Design decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| D1 | Trigger only when `/` is at composer offset 0 AND the draft starts with `/` (single-token slash). | Matches Claude.ai. Single-skill-per-turn is the dominant pattern; avoids `/` inside prose. |
| D2 | Filter predicate: `name.startsWith(q)` OR `triggers.some(t => t.includes(q))`. Both case-insensitive. | Triggers are lowercase by convention; substring on triggers lets `/memory` surface `reflect`/`housekeeping`/`evolve`. |
| D3 | Ranking: name-prefix matches first, then trigger-substring matches; alphabetical inside each bucket. | Predictable, no fuzzy black box. |
| D4 | Source of truth: `GET /api/skills` returning `{skills: SkillSummary[]}` — thin wrapper over the existing `SkillsStore.list()`. | Same call that already feeds `promptSection()`, so overlay and prompt-table can never disagree within a request. |
| D4a | Intentional overlay/prompt-table divergence (added 2026-06-15 by approval-mode T13): `/api/skills` appends synthetic `yolo` and `careful` entries to the `SkillsStore.list()` result; `promptSection()` does NOT include them. | These are per-turn approval-mode prefix overrides parsed by `approval/prefix.ts` and stripped before agent dispatch — NOT loadable skills (no SKILL.md). Surfacing them in the overlay is correct (user-discoverable slash command); surfacing them in the system-prompt Skills table would tell the model `skill("yolo")` is a valid call, causing a `SkillsStore.load("yolo")` failure. Do NOT "unify" by injecting these into `promptSection()`. |
| D5 | Client fetches the list ONCE per session mount; held in a ref. No keystroke roundtrips. No revalidation. | ~29 entries; skills edits are rare and Brian-initiated. Reload to refresh. Flag for v2 if it bites. |
| D6 | Hand-rolled overlay (positioned `<div>`) — no new dependency. | One surface, ~80 LOC. `cmdk` adds a 5KB dep for one feature. |
| D7 | Inserted text is `/<name> ` (trailing space). User can keep typing additional context. | Existing skills are zero-arg, but trailing space matches normal typing and doesn't force the user to add it. |
| D8 | Keyboard: ↑/↓ navigate, Enter/Tab insert, Esc dismiss, click also inserts. | Standard combobox semantics. |
| D9 | Visible-reason cue: when a row matches via trigger (not name), render the matching trigger in the row as `match: <trigger>`. | Brian asked for "searchable triggers" — showing the matched token answers "why is `reflect` in the list when I typed `/memory`?". |
| D10 | Overlay is rendered inside `Chat.tsx`, positioned above the textarea (composer is at the bottom of the viewport; opening above keeps it above the OS keyboard on mobile). | Already-known pattern, matches the cwd button popout shape. |
| D11 | No new API for "skill metadata changed" event. Reload-to-refresh is the contract. | Skill edits happen via `/cog` setup or file edits, both human-initiated. |

## Architecture

```
+------------------------+    GET /api/skills    +-------------------+
|  web/src/components    | --------------------> |  server/src/      |
|  Chat.tsx              |                       |  server.ts        |
|   ├ SlashOverlay.tsx   | <-------------------- |   (route)         |
|   └ useSlashMenu.ts    |  {skills: [...]}      |                   |
+------------------------+                       |  uses             |
                                                 |  SkillsStore.list |
                                                 +-------------------+
```

Server changes:
1. `AppDeps.skills?: SkillsStore` (new, optional like `workdirs`).
2. `GET /api/skills` returns `{skills: SkillSummary[]}` — copy of what
   `promptSection()` consumes; empty array if no `SkillsStore` was injected.
3. `src/index.ts` passes the existing `skills` instance into `createApp`.

Client changes:
1. `web/src/lib/api.ts` — add `listSkills(): Promise<{skills: SkillSummary[]}>`.
2. `web/src/lib/types.ts` — add `SkillSummary` (mirrors server type).
3. `web/src/components/SlashOverlay.tsx` — new presentational component:
   props `{skills, query, activeIndex, onSelect, onActiveChange}`, renders
   the filtered/ranked list, no state of its own.
4. `web/src/components/useSlashMenu.ts` — new hook:
   `useSlashMenu(draft, skills) → {open, items, activeIndex, setActiveIndex, accept(name): string}`.
   Pure derivation of open/filter/rank from the draft. `accept` returns the
   new draft string (`/<name> `).
5. `web/src/components/Chat.tsx` — wire the hook + overlay into the existing
   textarea: fetch skills on mount, intercept ↑/↓/Enter/Tab/Esc only when
   `open` is true, render `<SlashOverlay/>` positioned above the textarea.

## Filtering & ranking algorithm

```ts
function filterAndRank(skills: SkillSummary[], q: string): RankedSkill[] {
  if (q === "") return skills.map(s => ({ skill: s, reason: "all" })).sort(byName);
  const lower = q.toLowerCase();
  const prefix: RankedSkill[] = [];
  const trigger: RankedSkill[] = [];
  for (const s of skills) {
    if (s.name.toLowerCase().startsWith(lower)) {
      prefix.push({ skill: s, reason: "name" });
      continue;
    }
    const t = s.triggers.find(t => t.toLowerCase().includes(lower));
    if (t) trigger.push({ skill: s, reason: "trigger", matchedTrigger: t });
  }
  return [...prefix.sort(byName), ...trigger.sort(byName)];
}
```

`q` is the substring after the leading `/`, e.g. draft `"/ref"` → `q = "ref"`.
Open state: `draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")`
— once the user types whitespace, the menu closes (they're past command
selection).

## Keyboard contract

| Key | When `open` | When closed |
|---|---|---|
| `↓` | move activeIndex down (wrap) | default textarea |
| `↑` | move activeIndex up (wrap) | default textarea |
| `Enter` | accept active item, prevent send | send (existing) |
| `Tab` | accept active item, prevent blur | default tab |
| `Esc` | close overlay, draft unchanged | default |
| any other | default textarea (re-filters via draft change) | default |

## Visual

- Overlay: absolute-positioned card above the textarea, max-height ~12rem
  with scroll, mirrors width of the composer's inner column.
- Row: `<name>` bold, `<description>` truncated to one line muted, optional
  `match: <trigger>` tag right-aligned in muted small text.
- Active row: `bg-accent` (existing token).
- No animation needed.

## Testing strategy

`web/` uses `node:test` with `.mjs` files registered explicitly in `web/test/run.mjs`. No vitest, no `@testing-library/react`. Tests are either source-grep contract tests (read the source file, regex-assert structural facts) or pure-logic behavior tests (direct `.ts` import via Node 22+'s type-stripping, exercise the function). The slash-completion overlay test plan respects this:

Server:
1. `test/skills-api.test.ts` — boot an app with `setupFaux()` + `makeManager()` (canonical harness) seeded with two skill files, assert `GET /api/skills` returns them with the right shape.
2. Same file: 401 when no auth token.
3. Same file: empty array when `AppDeps.skills` is undefined.

Client (all `.mjs`, `node:test`):
1. `test/api-skills.test.mjs` — source-grep `lib/types.ts` and `lib/api.ts` for the `SkillSummary` interface and `client.listSkills` shape.
2. `test/slash-menu.test.mjs` — direct `.ts` import of `components/slashMenu.ts`, behaviorally exercise the pure `slashMenuState(draft, skills)` derivation across all the open/closed/rank/case-sensitivity cases. Source-grep `useSlashMenu.ts` for the wrapper structure.
3. `test/slash-overlay.test.mjs` — source-grep `components/SlashOverlay.tsx` for the props shape, role attributes, mouseDown/mouseEnter wiring, and the trigger-match cue.
4. `test/chat-slash.test.mjs` — source-grep `components/Chat.tsx` for the imports, the skills fetch, the `useSlashMenu(draft, skills)` invocation, the guarded `<SlashOverlay/>` render, and the keystroke interception keys.

End-to-end behavior (real keystrokes through React) is covered by Task 6's manual smoke checklist. This combination is necessary-not-sufficient by itself; the manual pass is what makes the feature "shipped." This matches Brian's prevailing pattern in this repo (cf. health-icon.test.mjs, message-error-boundary.test.mjs).

## Risks

1. **Mobile keyboards** can swallow arrow keys. Mitigation: click + Enter
   still work. Not blocking — Brian uses this on desktop primarily.
2. **iOS Safari composing input** (IME). Existing send already checks
   `e.nativeEvent.isComposing`; we'll honor the same flag before accepting.
3. **Stale skill list** after `/cog` adds a domain. Documented: reload the
   page. v2 candidate: emit a `skills-changed` event from the SkillsStore on
   write paths.

## Out-of-scope reminder

No removal of the system-prompt Skills table. No new dependency. No
client-side command dispatch. No file/wiki completion.
