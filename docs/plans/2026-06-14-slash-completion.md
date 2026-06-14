# Slash-Command Completion Overlay — Implementation Plan

> Execute with the `develop` skill, task-by-task.

**Goal:** Add a slash-command completion overlay to the chat composer: typing `/` at the start of an empty draft opens a filterable menu of available skills; selecting one inserts `/<name> ` into the textarea. No client-side dispatch — the LLM still routes via the existing system-prompt Skills table.

**Spec:** `docs/plans/2026-06-14-slash-completion-design.md`

**Architecture:** Thin server route exposing the existing `SkillsStore.list()` over HTTP; a hand-rolled React overlay positioned above the existing `Textarea`, driven by a pure derivation hook over the draft string. No new dependencies. Server change is one route + one prop on `AppDeps`; client change is two new files + targeted edits in `Chat.tsx`, `lib/api.ts`, `lib/types.ts`.

**Tech Stack:** TypeScript, Hono (server), React + Tailwind (client), vitest (both sides).

**Worktree:** /tmp/slash-completion

**Branch:** feature/slash-completion

---

## Task 1: Server — expose SkillsStore on AppDeps and add `GET /api/skills`

**Files:**
- Modify: `server/src/server.ts` (extend `AppDeps`, add route)
- Modify: `server/src/index.ts` (pass existing `skills` instance into `createApp`)
- Create: `server/test/skills-api.test.ts`

### Step 1: Write the failing test

Create `server/test/skills-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/server.ts";
import { SkillsStore } from "../src/skills.ts";

async function seed(skillsDir: string): Promise<void> {
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, "alpha.md"),
    "---\nname: alpha\ndescription: First skill\ntriggers: [a, alpha, first]\n---\nbody\n",
  );
  await fs.writeFile(
    path.join(skillsDir, "beta.md"),
    "---\nname: beta\ndescription: Second skill\ntriggers: [b, beta]\n---\nbody\n",
  );
}

function fakeDeps(skillsStore?: SkillsStore) {
  // Minimal stubs — createApp only needs these surfaces alive enough to
  // register without throwing. The /api/skills route doesn't touch them.
  const noop = async () => {};
  return {
    manager: {} as any,
    taskManager: { list: () => [] } as any,
    scheduler: { listSchedules: () => [] } as any,
    indexer: {
      listSessions: () => [],
      listTasks: () => [],
      listSchedules: () => [],
    } as any,
    bus: { subscribe: () => () => {}, publish: noop } as any,
    persona: { load: async () => "" } as any,
    config: {
      authToken: "test-token",
      dataDir: "/tmp/unused",
      defaultModel: { provider: "x", modelId: "y" },
    } as any,
    authStore: {} as any,
    skills: skillsStore,
  };
}

async function getJson(app: Hono, path: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { headers });
  const body = res.status === 200 ? await res.json() : null;
  return { status: res.status, body };
}

describe("GET /api/skills", () => {
  it("returns the list from the injected SkillsStore", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytsejam-skills-api-"));
    await seed(path.join(dir, "skills"));
    const store = new SkillsStore(path.join(dir, "skills"));
    const { app } = createApp(fakeDeps(store));
    const { status, body } = await getJson(app, "/api/skills", "test-token");
    expect(status).toBe(200);
    expect(body.skills).toHaveLength(2);
    const names = body.skills.map((s: any) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    const alpha = body.skills.find((s: any) => s.name === "alpha");
    expect(alpha.description).toBe("First skill");
    expect(alpha.triggers).toEqual(["a", "alpha", "first"]);
  });

  it("returns 401 without a bearer token", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytsejam-skills-api-"));
    await seed(path.join(dir, "skills"));
    const store = new SkillsStore(path.join(dir, "skills"));
    const { app } = createApp(fakeDeps(store));
    const { status } = await getJson(app, "/api/skills");
    expect(status).toBe(401);
  });

  it("returns an empty array when no SkillsStore was injected", async () => {
    const { app } = createApp(fakeDeps(undefined));
    const { status, body } = await getJson(app, "/api/skills", "test-token");
    expect(status).toBe(200);
    expect(body.skills).toEqual([]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace server -- skills-api 2>&1 | tail -20
```

Expected: FAIL with `/api/skills` route not found (likely a 404 turning into a body parse error, OR `createApp` rejecting the new `skills` prop on `AppDeps` if vitest is strict about it). Either failure mode is acceptable.

### Step 3: Extend AppDeps in `server/src/server.ts`

Find the `AppDeps` interface (around line 18–28) and add the optional `skills` field next to `workdirs`:

```ts
  /** Optional: when supplied, exposes POST /api/sessions/:id/cwd. */
  workdirs?: WorkdirStore;
  /** Optional: when supplied, exposes GET /api/skills. */
  skills?: SkillsStore;
}
```

Add the import at the top of the file:

```ts
import type { SkillsStore } from "./skills.ts";
```

### Step 4: Add the route

In `server/src/server.ts`, find a clean spot among the GET routes (after `/api/persona` or `/api/models` looks natural). Add:

```ts
  app.get("/api/skills", async (c) => {
    const skills = deps.skills ? await deps.skills.list() : [];
    return c.json({ skills });
  });
```

Auth: confirm the file's existing bearer-token middleware covers `/api/*` paths (it does — every `/api/*` route except `/api/login` is behind the middleware). The new route inherits the same protection automatically; no extra wiring needed. If the test in Step 1 sees 200-without-token, audit the middleware — DON'T paper over it in the route.

### Step 5: Wire the existing skills instance into createApp in `server/src/index.ts`

Find the call (around line 211):

```ts
const { app, injectWebSocket } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs });
```

Add `skills`:

```ts
const { app, injectWebSocket } = createApp({ manager, taskManager, scheduler, indexer, bus, persona, config, authStore, workdirs, skills });
```

(The `skills` const is already declared earlier at line 47.)

### Step 6: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace server -- skills-api 2>&1 | tail -20
```

Expected: all 3 tests PASS.

### Step 7: Run the full server suite to confirm no regression

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm run check && env -u NODE_ENV npm test --workspace server 2>&1 | tail -10
```

Expected: typecheck passes, full server suite passes (existing skill tests + new ones).

### Step 8: Commit

```bash
git add server/src/server.ts server/src/index.ts server/test/skills-api.test.ts
git commit -m "feat(server): expose GET /api/skills from SkillsStore"
```

---

## Task 2: Client — types and API client method

**Files:**
- Modify: `web/src/lib/types.ts` (add `SkillSummary`)
- Modify: `web/src/lib/api.ts` (add `listSkills`)
- Create: `web/test/api-skills.test.ts`

### Step 1: Write the failing test

Create `web/test/api-skills.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { client, setToken } from "../src/lib/api";

beforeEach(() => {
  setToken("test-token");
});

describe("client.listSkills", () => {
  it("GETs /api/skills with bearer auth and returns the parsed body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [
            { name: "alpha", description: "A", triggers: ["a"] },
            { name: "beta", description: "B", triggers: ["b"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await client.listSkills();
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0].name).toBe("alpha");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
    fetchMock.mockRestore();
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- api-skills 2>&1 | tail -20
```

Expected: FAIL with `client.listSkills is not a function`.

### Step 3: Add the `SkillSummary` type

In `web/src/lib/types.ts`, add (alongside the other exported interfaces):

```ts
export interface SkillSummary {
  name: string;
  description: string;
  triggers: string[];
}
```

### Step 4: Add the `listSkills` client method

In `web/src/lib/api.ts`:

1. Add `SkillSummary` to the existing type import from `./types`:
   ```ts
   import type { ChatMessage, LtmHealth, ModelInfo, ScheduleRow, SessionRow, SkillSummary, TaskRow } from "./types";
   ```
2. Add the method near `listSchedules` / `listTasks` (keep alphabetical-ish grouping):
   ```ts
   listSkills: () => api<{ skills: SkillSummary[] }>("/api/skills"),
   ```

### Step 5: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- api-skills 2>&1 | tail -20
```

Expected: PASS.

### Step 6: Commit

```bash
git add web/src/lib/types.ts web/src/lib/api.ts web/test/api-skills.test.ts
git commit -m "feat(web): add SkillSummary type + client.listSkills"
```

---

## Task 3: Client — `useSlashMenu` hook (pure derivation)

**Files:**
- Create: `web/src/components/useSlashMenu.ts`
- Create: `web/test/useSlashMenu.test.ts`

### Step 1: Write the failing test

Create `web/test/useSlashMenu.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlashMenu } from "../src/components/useSlashMenu";
import type { SkillSummary } from "../src/lib/types";

const SKILLS: SkillSummary[] = [
  { name: "reflect", description: "Reflect", triggers: ["reflect", "memory", "consolidate"] },
  { name: "ship", description: "Ship", triggers: ["ship", "ship it"] },
  { name: "review", description: "Review", triggers: ["review", "code review"] },
  { name: "housekeeping", description: "HK", triggers: ["housekeeping", "memory", "archive"] },
];

describe("useSlashMenu", () => {
  it("is closed for an empty draft", () => {
    const { result } = renderHook(() => useSlashMenu("", SKILLS));
    expect(result.current.open).toBe(false);
  });

  it("is closed for a draft that doesn't start with /", () => {
    const { result } = renderHook(() => useSlashMenu("hello", SKILLS));
    expect(result.current.open).toBe(false);
  });

  it("opens on bare '/' and lists all skills alphabetically", () => {
    const { result } = renderHook(() => useSlashMenu("/", SKILLS));
    expect(result.current.open).toBe(true);
    expect(result.current.items.map((i) => i.skill.name)).toEqual([
      "housekeeping",
      "reflect",
      "review",
      "ship",
    ]);
  });

  it("name-prefix matches rank above trigger-substring matches", () => {
    const { result } = renderHook(() => useSlashMenu("/re", SKILLS));
    // name-prefix: reflect, review (alpha)
    // trigger-substring: (none for "re")
    expect(result.current.items.map((i) => i.skill.name)).toEqual(["reflect", "review"]);
  });

  it("surfaces trigger-substring matches with reason and matchedTrigger", () => {
    const { result } = renderHook(() => useSlashMenu("/memory", SKILLS));
    // name-prefix: (none)
    // trigger-substring: housekeeping, reflect (both have "memory")
    expect(result.current.items.map((i) => i.skill.name)).toEqual(["housekeeping", "reflect"]);
    expect(result.current.items[0].reason).toBe("trigger");
    expect(result.current.items[0].matchedTrigger).toBe("memory");
  });

  it("is case-insensitive", () => {
    const { result } = renderHook(() => useSlashMenu("/REF", SKILLS));
    expect(result.current.items.map((i) => i.skill.name)).toEqual(["reflect", "review"]);
  });

  it("closes once the draft contains whitespace", () => {
    const { result } = renderHook(() => useSlashMenu("/ref hello", SKILLS));
    expect(result.current.open).toBe(false);
  });

  it("closes on newline", () => {
    const { result } = renderHook(() => useSlashMenu("/ref\n", SKILLS));
    expect(result.current.open).toBe(false);
  });

  it("activeIndex starts at 0 and clamps when items shrink", () => {
    const { result, rerender } = renderHook(({ d }) => useSlashMenu(d, SKILLS), {
      initialProps: { d: "/" },
    });
    expect(result.current.activeIndex).toBe(0);
    act(() => result.current.setActiveIndex(3));
    expect(result.current.activeIndex).toBe(3);
    rerender({ d: "/re" }); // items shrinks to 2; activeIndex clamps to 1
    expect(result.current.activeIndex).toBe(1);
  });

  it("accept() returns '/<name> ' for the given skill name", () => {
    const { result } = renderHook(() => useSlashMenu("/re", SKILLS));
    expect(result.current.accept("reflect")).toBe("/reflect ");
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- useSlashMenu 2>&1 | tail -20
```

Expected: FAIL with module not found.

### Step 3: Implement the hook

Create `web/src/components/useSlashMenu.ts`:

```ts
import { useEffect, useMemo, useState } from "react";
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
  activeIndex: number;
  setActiveIndex: (n: number) => void;
  /** Build the new draft to commit when the user accepts a row. */
  accept: (name: string) => string;
}

/**
 * Pure derivation of slash-menu state from the composer draft.
 *
 * Open contract: draft starts with "/" and contains no whitespace or
 * newline. The user is in command-selection mode while typing the slash
 * token; once they type a space the menu closes (whatever follows is the
 * skill's argument body, not a filter).
 */
export function useSlashMenu(draft: string, skills: SkillSummary[]): SlashMenuState {
  const open = draft.startsWith("/") && !/\s/.test(draft);
  const query = open ? draft.slice(1).toLowerCase() : "";

  const items = useMemo<RankedSkill[]>(() => {
    if (!open) return [];
    if (query === "") {
      return [...skills]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ skill: s, reason: "all" as const }));
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
    return [...prefix.sort(byName), ...trigger.sort(byName)];
  }, [open, query, skills]);

  const [activeIndex, setActiveIndex] = useState(0);

  // Clamp activeIndex when items shrink (e.g. user types another char).
  useEffect(() => {
    if (items.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex > items.length - 1) setActiveIndex(items.length - 1);
  }, [items.length, activeIndex]);

  const accept = (name: string) => `/${name} `;

  return { open, items, activeIndex, setActiveIndex, accept };
}
```

### Step 4: Verify `@testing-library/react` is already a devDep

```bash
cd /tmp/slash-completion && grep -E '"@testing-library/react"' web/package.json
```

Expected: a line. If MISSING, add it:

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm install --workspace web --save-dev @testing-library/react
```

(The existing `web/test/Chat.test.tsx` and similar tests will tell us — if they use it, it's there.)

### Step 5: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- useSlashMenu 2>&1 | tail -30
```

Expected: all 10 tests PASS.

### Step 6: Commit

```bash
git add web/src/components/useSlashMenu.ts web/test/useSlashMenu.test.ts
# only if the install step ran:
git add web/package.json web/package-lock.json 2>/dev/null || true
git commit -m "feat(web): add useSlashMenu derivation hook"
```

---

## Task 4: Client — `SlashOverlay` presentational component

**Files:**
- Create: `web/src/components/SlashOverlay.tsx`
- Create: `web/test/SlashOverlay.test.tsx`

### Step 1: Write the failing test

Create `web/test/SlashOverlay.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SlashOverlay } from "../src/components/SlashOverlay";
import type { RankedSkill } from "../src/components/useSlashMenu";

const ITEMS: RankedSkill[] = [
  {
    skill: { name: "reflect", description: "Reflect on memory", triggers: ["reflect"] },
    reason: "name",
  },
  {
    skill: { name: "housekeeping", description: "Housekeeping", triggers: ["memory"] },
    reason: "trigger",
    matchedTrigger: "memory",
  },
];

describe("SlashOverlay", () => {
  it("renders each item with name and description", () => {
    render(<SlashOverlay items={ITEMS} activeIndex={0} onSelect={() => {}} onActiveChange={() => {}} />);
    expect(screen.getByText("reflect")).toBeInTheDocument();
    expect(screen.getByText("Reflect on memory")).toBeInTheDocument();
    expect(screen.getByText("housekeeping")).toBeInTheDocument();
  });

  it("renders 'match: <trigger>' for trigger-reason rows", () => {
    render(<SlashOverlay items={ITEMS} activeIndex={0} onSelect={() => {}} onActiveChange={() => {}} />);
    expect(screen.getByText(/match:\s*memory/i)).toBeInTheDocument();
  });

  it("marks the active row with data-active=true", () => {
    render(<SlashOverlay items={ITEMS} activeIndex={1} onSelect={() => {}} onActiveChange={() => {}} />);
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveAttribute("data-active", "false");
    expect(rows[1]).toHaveAttribute("data-active", "true");
  });

  it("fires onSelect(name) on click", () => {
    const onSelect = vi.fn();
    render(<SlashOverlay items={ITEMS} activeIndex={0} onSelect={onSelect} onActiveChange={() => {}} />);
    fireEvent.mouseDown(screen.getByText("reflect"));
    expect(onSelect).toHaveBeenCalledWith("reflect");
  });

  it("fires onActiveChange(i) on row mouseenter", () => {
    const onActiveChange = vi.fn();
    render(<SlashOverlay items={ITEMS} activeIndex={0} onSelect={() => {}} onActiveChange={onActiveChange} />);
    fireEvent.mouseEnter(screen.getAllByRole("option")[1]);
    expect(onActiveChange).toHaveBeenCalledWith(1);
  });

  it("renders nothing when items is empty", () => {
    const { container } = render(
      <SlashOverlay items={[]} activeIndex={0} onSelect={() => {}} onActiveChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- SlashOverlay 2>&1 | tail -15
```

Expected: FAIL with module not found.

### Step 3: Implement the component

Create `web/src/components/SlashOverlay.tsx`:

```tsx
import type { RankedSkill } from "./useSlashMenu";

export interface SlashOverlayProps {
  items: RankedSkill[];
  activeIndex: number;
  onSelect: (name: string) => void;
  onActiveChange: (index: number) => void;
}

/**
 * Positioned listbox shown above the composer when the user is typing a
 * slash command. Stateless and presentational — useSlashMenu owns the
 * filtering/ranking, Chat owns the open state and keyboard wiring.
 *
 * mouseDown (not click) is used for selection so the textarea doesn't lose
 * focus between mousedown and click — the textarea blur path would close
 * the menu before click fires.
 */
export function SlashOverlay({ items, activeIndex, onSelect, onActiveChange }: SlashOverlayProps) {
  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="pointer-events-auto absolute bottom-full left-0 right-0 z-20 mb-2 max-h-48 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      {items.map((item, i) => {
        const active = i === activeIndex;
        return (
          <div
            key={item.skill.name}
            role="option"
            aria-selected={active}
            data-active={active}
            className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm ${
              active ? "bg-accent" : ""
            }`}
            onMouseDown={(e) => {
              // mousedown not click: see comment above.
              e.preventDefault();
              onSelect(item.skill.name);
            }}
            onMouseEnter={() => onActiveChange(i)}
          >
            <span className="font-medium">{item.skill.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.skill.description}
            </span>
            {item.reason === "trigger" && item.matchedTrigger && (
              <span className="shrink-0 text-xs text-muted-foreground">
                match: {item.matchedTrigger}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

### Step 4: Run test to verify it passes

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- SlashOverlay 2>&1 | tail -20
```

Expected: all 6 tests PASS.

### Step 5: Commit

```bash
git add web/src/components/SlashOverlay.tsx web/test/SlashOverlay.test.tsx
git commit -m "feat(web): add SlashOverlay listbox component"
```

---

## Task 5: Client — wire overlay into the composer in `Chat.tsx`

**Files:**
- Modify: `web/src/components/Chat.tsx`
- Create: `web/test/Chat.slash.test.tsx`

### Step 1: Write the failing test

Create `web/test/Chat.slash.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Chat } from "../src/components/Chat";

// The Chat component pulls these via props/hooks; mock the api client surface
// it touches. Mirror the shape used by the existing Chat tests in this
// workspace — adapt if Chat.test.tsx (if present) uses a different harness.
vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    client: {
      ...actual.client,
      listSkills: vi.fn().mockResolvedValue({
        skills: [
          { name: "reflect", description: "Reflect", triggers: ["reflect", "memory"] },
          { name: "ship", description: "Ship", triggers: ["ship"] },
        ],
      }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function renderChat() {
  // The Chat component's prop surface is what App passes; check Chat.tsx for
  // the actual signature and adapt this minimal harness. If Chat takes more
  // props than listed, supply no-op stubs.
  return render(
    <Chat
      sessionId="s1"
      messages={[]}
      streaming={null}
      toolResults={{}}
      tasks={{}}
      cwd={undefined}
      onSetCwd={() => {}}
      running={false}
    />,
  );
}

describe("Chat slash-command overlay", () => {
  beforeEach(() => {
    // localStorage may need a token for the api client.
    localStorage.setItem("ytsejam-token", "test");
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("does not render the overlay for empty draft", async () => {
    renderChat();
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: /slash commands/i })).toBeNull();
    });
  });

  it("opens the overlay when the user types '/'", async () => {
    renderChat();
    const textarea = screen.getByPlaceholderText(/message/i);
    fireEvent.change(textarea, { target: { value: "/" } });
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /slash commands/i })).toBeInTheDocument();
    });
    // both skills visible
    expect(screen.getByText("reflect")).toBeInTheDocument();
    expect(screen.getByText("ship")).toBeInTheDocument();
  });

  it("Enter while overlay is open accepts the active item and does NOT send", async () => {
    const { client } = await import("../src/lib/api");
    renderChat();
    const textarea = screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/" } });
    await waitFor(() => screen.getByRole("listbox"));
    // activeIndex starts at 0; with alpha-sorted ["reflect","ship"], reflect wins
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/reflect ");
    expect((client.sendMessage as any).mock.calls).toHaveLength(0);
  });

  it("Esc closes the overlay without changing the draft", async () => {
    renderChat();
    const textarea = screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/re" } });
    await waitFor(() => screen.getByRole("listbox"));
    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(textarea.value).toBe("/re");
  });

  it("typing a space closes the overlay (back to plain message mode)", async () => {
    renderChat();
    const textarea = screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/reflect now" } });
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });
});
```

NOTE for the implementer: if `Chat.tsx`'s prop signature differs from the renderChat() stub above (e.g. it pulls `useApp()` internally rather than receiving props), adapt the harness to match. If a `web/test/Chat.test.tsx` already exists, copy its render pattern — that's the source of truth for how this codebase tests `Chat`.

### Step 2: Run test to verify it fails

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- Chat.slash 2>&1 | tail -20
```

Expected: FAIL — overlay not rendered, Enter still calls sendMessage, etc.

### Step 3: Wire the hook + overlay into `web/src/components/Chat.tsx`

Three edits, all inside the existing component:

**(a) Imports** — add near the existing imports:

```ts
import { useEffect, useState } from "react"; // (extend existing react import; some hooks may already be imported)
import { client } from "@/lib/api";
import type { SkillSummary } from "@/lib/types";
import { SlashOverlay } from "./SlashOverlay";
import { useSlashMenu } from "./useSlashMenu";
```

(Adjust path aliases to match existing convention in `Chat.tsx` — looks like `@/components/...` is in use.)

**(b) Skills load + slash menu state** — add inside the component body, near the other `useState` calls (the existing component already has `draft`, `setDraft`, and a `client` import is likely already present):

```ts
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    let alive = true;
    client.listSkills()
      .then((r) => { if (alive) setSkills(r.skills); })
      .catch(() => { /* overlay is opt-in; silently degrade */ });
    return () => { alive = false; };
  }, []);

  const slash = useSlashMenu(draft, skills);
```

**(c) Textarea wrapper + keyboard interception** — find the existing `<Textarea>` block (around line 127) and wrap it in a `relative` div so the overlay can position over it; extend `onKeyDown` to handle slash keys when `slash.open`:

```tsx
          <div className="relative">
            {slash.open && (
              <SlashOverlay
                items={slash.items}
                activeIndex={slash.activeIndex}
                onSelect={(name) => setDraft(slash.accept(name))}
                onActiveChange={slash.setActiveIndex}
              />
            )}
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (slash.open) {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    slash.setActiveIndex(
                      (slash.activeIndex + 1) % Math.max(slash.items.length, 1),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    slash.setActiveIndex(
                      (slash.activeIndex - 1 + slash.items.length) %
                        Math.max(slash.items.length, 1),
                    );
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && slash.items.length > 0) {
                    e.preventDefault();
                    setDraft(slash.accept(slash.items[slash.activeIndex].skill.name));
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    // Clear the leading "/" so the overlay closes — preserve the rest.
                    // (Per design: Esc closes without changing the draft. We close
                    // the overlay by NOT clearing the draft — the only way to close
                    // while keeping draft.startsWith("/") is to track an explicit
                    // dismiss flag. Simplest: append a space so the open predicate
                    // closes. Trade-off documented in design D-?, revisit if it's
                    // weird in practice.)
                    setDraft(draft + " ");
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={running ? "Assistant is working — messages will steer it" : "Message…"}
              rows={2}
              className="w-full resize-none"
            />
          </div>
```

**IMPLEMENTER STOP-on-bug-signal:** the Esc trade-off above is awkward (appending a space mutates the draft visibly). If the test for Esc fails because of this, STOP and report — the cleaner fix is a small dismiss-flag state in `useSlashMenu` (`dismissed: boolean`, reset on draft change), and the hook's `open` becomes `… && !dismissed`. Do not silently rewrite the hook; surface the choice.

### Step 4: Run the Chat.slash test

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web -- Chat.slash 2>&1 | tail -25
```

Expected: all 5 tests PASS. If the Esc test fails because the draft test asserts `"/re"` but the implementation made it `"/re "`, this is the STOP signal above — report and ask.

### Step 5: Run the full web suite + typecheck to confirm no regression

```bash
cd /tmp/slash-completion && env -u NODE_ENV npm run build --workspace web 2>&1 | tail -10
cd /tmp/slash-completion && env -u NODE_ENV npm test --workspace web 2>&1 | tail -15
```

Expected: build green, full web suite green.

### Step 6: Commit

```bash
git add web/src/components/Chat.tsx web/test/Chat.slash.test.tsx
git commit -m "feat(web): wire slash-command overlay into composer"
```

---

## Task 6: Full gate + manual smoke

**Files:** none — verification only.

### Step 1: Full gate

```bash
cd /tmp/slash-completion && bash scripts/gate.sh 2>&1 | tail -20
```

Expected: `=== gate: PASSED ===`.

### Step 2: Document the manual smoke checklist for ship

Print (do not commit) the following so the ship/review pass knows what a human must eyeball on the dev instance at :3000 (or :9873 prod after deploy):

```
Manual smoke (dev instance, http://localhost:3000):
  1. Open a session, focus the composer.
  2. Type "/" → overlay appears above the textarea listing all skills alphabetically.
  3. Type "re" → list narrows to "reflect", "review" (name-prefix bucket).
  4. Type "mem" → list shows trigger-substring matches with "match: memory" tag.
  5. Press ↓ → highlight moves; ↑ → wraps back.
  6. Press Enter → "/<active-name> " inserted; overlay closes; cursor at end; NO send.
  7. Press Enter again (empty selection mode) → message sends as normal.
  8. Type "/", press Esc → overlay closes; verify what's left in the textarea matches the design's Esc behavior (the awkward space-trick OR the dismiss-flag, depending on which Task 5 landed on).
  9. Verify no layout shift in the composer when the overlay opens (overlay is absolute-positioned).
 10. Resize window narrow → overlay should fit composer width, no horizontal scrollbar.
```

### Step 3: No commit — handoff to ship

---

## Post-plan handoff

After all tasks pass and the gate is green: invoke the `ship` skill. It will route the per-task report tails to cog memory, update CHANGELOG, and present the merge/PR options.
