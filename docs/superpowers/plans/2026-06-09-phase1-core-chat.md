# Phase 1: Core Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running web-based personal assistant: multi-session ChatGPT-style chat UI, JSONL sessions as SSOT, sqlite session index, WebSocket streaming, editable persona, multi-provider model picker, and web/system tools.

**Architecture:** Single Node (>= 22, dev box has 26) process built on `@earendil-works/pi-agent-core` (`AgentHarness` + `JsonlSessionRepo` handle the agent loop and JSONL persistence) and `@earendil-works/pi-ai` (multi-provider LLM streaming). A Hono server exposes REST + one WebSocket and serves the built React app. An `Indexer` module owns all sqlite writes; sqlite is derived and rebuildable from JSONL. Spec: `docs/superpowers/specs/2026-06-09-personal-assistant-design.md`.

**Tech Stack:** TypeScript, Node `node:sqlite` (replaces better-sqlite3 from the spec — built into Node, no native build step, FTS5 included), Hono + `@hono/node-server` + `@hono/node-ws`, vitest, React + Vite + Tailwind + shadcn/ui, react-markdown.

**Verified API facts (from pi v0.79.1 source, clone at `/tmp/pi-research`; if gone: `git clone https://github.com/earendil-works/pi /tmp/pi-research`):**

- `@earendil-works/pi-agent-core` exports: `AgentHarness`, `JsonlSessionRepo`, `Session`, `uuidv7`, types `AgentTool`, `AgentToolResult`, `AgentMessage`, `AgentEvent`, `AgentHarnessEvent`, `JsonlSessionMetadata`, `SessionTreeEntry`. Subpath `@earendil-works/pi-agent-core/node` exports `NodeExecutionEnv`.
- `new NodeExecutionEnv({ cwd })` implements `ExecutionEnv` (FileSystem + Shell) and is valid as `JsonlSessionRepo`'s `fs` option: `new JsonlSessionRepo({ fs: env, sessionsRoot })`.
- `repo.create({ cwd })` / `repo.open(metadata)` / `repo.list({ cwd })` / `repo.delete(metadata)`. Session files land in `<sessionsRoot>/--<encoded-cwd>--/<timestamp>_<id>.jsonl`. Metadata: `{ id, createdAt, cwd, path }`.
- `Session` methods: `getMetadata()`, `getEntries()`, `buildContext() → { messages, thinkingLevel, model: {provider, modelId} | null, activeToolNames }`, `getSessionName()`, `appendSessionName(name)`, `appendMessage(msg)`, `appendModelChange(provider, modelId)`. All async.
- `new AgentHarness({ env, session, model, tools?, systemPrompt? (string or async callback), getApiKeyAndHeaders?, thinkingLevel?, streamOptions? })`. Methods: `prompt(text, {images?}) → Promise<AssistantMessage>` (rejects with code `"busy"` if not idle), `steer(text)`, `followUp(text)`, `abort()`, `waitForIdle()`, `setModel(model)` (persists a `model_change` entry when idle), `subscribe(listener)` — listener gets `AgentHarnessEvent` which is a superset of `AgentEvent` (`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start/update/end`, plus harness-own events like `save_point`). Listeners are awaited during the run — keep them fast, never call `waitForIdle()` from one.
- `AgentTool` shape: `{ name, label, description, parameters: TSchema (typebox), execute(toolCallId, params, signal?, onUpdate?) → Promise<{ content: [{type:"text",text}...], details }> }`. Throw on failure (the loop converts it to an error tool result).
- `@earendil-works/pi-ai` exports: `Type` (typebox re-export), `getProviders()`, `getModels(provider)`, `getEnvApiKey(provider)` (checks e.g. `ANTHROPIC_API_KEY`), `completeSimple(model, context, options?) → Promise<AssistantMessage>`, and faux provider test helpers: `registerFauxProvider({...}) → { getModel(), setResponses([...]), appendResponses, unregister }`, `fauxAssistantMessage(content)`, `fauxToolCall(name, args)`. The faux provider registers into the API registry so `AgentHarness`'s internal `streamSimple` works with faux models without network.
- Message shapes: user `{ role:"user", content:[{type:"text",text}], timestamp }`; assistant `{ role:"assistant", content:[ {type:"text"|"thinking"|"toolCall"...} ], stopReason, errorMessage?, usage, model, provider, ... }`; tool result `{ role:"toolResult", toolCallId, content:[...], isError?, ... }`.

**Conventions for all tasks:**

- Work on branch `feat/phase1-core-chat` (create from current branch at Task 1).
- Server source imports use explicit `.ts` extensions (Node type stripping requires them; tsconfig has `allowImportingTsExtensions`).
- Run server tests from `server/`: `npm test` (vitest). Type-check: `npm run check`.
- Commit after every task (steps include the commands).
- If an import or signature doesn't match these notes, check the actual source in `node_modules/@earendil-works/` — do not guess.

---

### Task 1: Repo scaffolding

**Files:**
- Create: `package.json`, `.gitignore`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/test/smoke.test.ts` (temporary)

- [ ] **Step 1: Create branch**

```bash
git switch -c feat/phase1-core-chat
```

- [ ] **Step 2: Root files**

`package.json`:

```json
{
  "name": "ytsejam",
  "private": true,
  "type": "module",
  "workspaces": ["server", "web"],
  "scripts": {
    "test": "npm test --workspace server",
    "check": "npm run check --workspace server",
    "build": "npm run build --workspace web",
    "dev:server": "npm run dev --workspace server",
    "dev:web": "npm run dev --workspace web"
  }
}
```

`.gitignore`:

```
node_modules/
dist/
data/
*.log
.env
```

- [ ] **Step 3: Server package**

`server/package.json`:

```json
{
  "name": "@ytsejam/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/index.ts",
    "start": "node src/index.ts",
    "test": "vitest --run",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.79.1",
    "@earendil-works/pi-ai": "0.79.1",
    "@hono/node-server": "^1.14.0",
    "@hono/node-ws": "^1.1.0",
    "hono": "^4.7.0",
    "html-to-text": "^9.0.5"
  },
  "devDependencies": {
    "@types/html-to-text": "^9.0.4",
    "@types/node": "^24.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

`server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 15000 },
});
```

- [ ] **Step 4: Smoke test**

`server/test/smoke.test.ts`:

```ts
import { expect, test } from "vitest";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pi packages load and create a JSONL session", async () => {
  const root = mkdtempSync(join(tmpdir(), "ytsejam-smoke-"));
  const env = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
  const session = await repo.create({ cwd: "chat" });
  const meta = await session.getMetadata();
  expect(meta.id).toBeTruthy();
  expect((await repo.list({ cwd: "chat" })).length).toBe(1);
});
```

- [ ] **Step 5: Install and run**

```bash
npm install
cd server && npm test
```

Expected: 1 test passes. If the `JsonlSessionRepo` constructor or `create` signature errors, read `node_modules/@earendil-works/pi-agent-core/dist/index.d.ts` and adjust the smoke test (and note the corrected signature for later tasks).

- [ ] **Step 6: Type-check and commit**

```bash
cd server && npm run check
cd .. && git add -A && git commit -m "chore: scaffold workspaces and verify pi packages"
```

---

### Task 2: Config module

**Files:**
- Create: `server/src/config.ts`, `server/test/config.test.ts`

- [ ] **Step 1: Failing test**

`server/test/config.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("requires auth token", () => {
    expect(() => loadConfig({})).toThrow(/YTSEJAM_AUTH_TOKEN/);
  });

  test("applies defaults and overrides", () => {
    const cfg = loadConfig({
      YTSEJAM_AUTH_TOKEN: "secret",
      YTSEJAM_PORT: "4000",
      YTSEJAM_DATA_DIR: "/tmp/x",
    });
    expect(cfg.authToken).toBe("secret");
    expect(cfg.port).toBe(4000);
    expect(cfg.dataDir).toBe("/tmp/x");
    expect(cfg.defaultModel).toContain("/");
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest --run test/config.test.ts` → fails (module not found).

- [ ] **Step 3: Implement**

`server/src/config.ts`:

```ts
import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  authToken: string;
  /** "provider/modelId", must exist in the pi-ai catalog */
  defaultModel: string;
  webDistDir: string;
  /** generate session titles with the LLM after the first exchange */
  generateTitles: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const authToken = env.YTSEJAM_AUTH_TOKEN;
  if (!authToken) throw new Error("YTSEJAM_AUTH_TOKEN is required");
  return {
    port: Number(env.YTSEJAM_PORT ?? 3000),
    dataDir: path.resolve(env.YTSEJAM_DATA_DIR ?? "./data"),
    authToken,
    defaultModel: env.YTSEJAM_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6",
    webDistDir: path.resolve(env.YTSEJAM_WEB_DIST ?? "../web/dist"),
    generateTitles: env.YTSEJAM_GENERATE_TITLES !== "false",
  };
}
```

Note: if `anthropic/claude-sonnet-4-6` is not in the installed catalog, pick the newest Anthropic Sonnet id from `getModels("anthropic")` (check in Task 4's test) and use that id here.

- [ ] **Step 4: Run, verify PASS** — same command, 2 tests pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: server config from environment"`

---

### Task 3: Persona store and system prompt composition

**Files:**
- Create: `server/src/persona.ts`, `server/test/persona.test.ts`

- [ ] **Step 1: Failing test**

`server/test/persona.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeSystemPrompt, PersonaStore } from "../src/persona.ts";

describe("PersonaStore", () => {
  test("creates default persona on first load, then round-trips edits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "persona-"));
    const store = new PersonaStore(dir);
    const initial = await store.load();
    expect(initial).toContain("personal assistant");
    await store.save("# Persona\nYou are Jeeves.");
    expect(await store.load()).toBe("# Persona\nYou are Jeeves.");
  });
});

describe("composeSystemPrompt", () => {
  test("persona first, then harness section with date and data dir", () => {
    const prompt = composeSystemPrompt("You are Jeeves.", {
      dataDir: "/data",
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(prompt.indexOf("Jeeves")).toBeLessThan(prompt.indexOf("2026-06-09"));
    expect(prompt).toContain("/data");
    expect(prompt).toContain("web_search");
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

`server/src/persona.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PERSONA = `# Persona

Your name is Pi. You are a thoughtful, direct personal assistant. You are
candid, concise, and you get things done without ceremony. Address the user
plainly, admit uncertainty, and prefer doing work over describing work.
`;

export class PersonaStore {
  constructor(private readonly personaDir: string) {}

  get filePath(): string {
    return path.join(this.personaDir, "persona.md");
  }

  async load(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await this.save(DEFAULT_PERSONA);
      return DEFAULT_PERSONA;
    }
  }

  async save(content: string): Promise<void> {
    await fs.mkdir(this.personaDir, { recursive: true });
    await fs.writeFile(this.filePath, content, "utf8");
  }
}

export function composeSystemPrompt(persona: string, opts: { dataDir: string; now?: Date }): string {
  const now = opts.now ?? new Date();
  return `${persona.trim()}

---

## Environment

- Current date: ${now.toISOString().slice(0, 10)}
- You run as a service on the user's private server. Files you create with tools live under ${opts.dataDir} unless an absolute path is given.

## Tool guidance

- Use web_search to find current information and web_fetch to read pages. Cite source URLs when you rely on them.
- bash, read, write, edit, ls, grep, and find operate directly on the server with the user's permissions. Be careful with destructive commands; never run them speculatively.
- Format responses in markdown.`;
}
```

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: persona store and system prompt composition"`

---

### Task 4: Model catalog helpers

**Files:**
- Create: `server/src/models.ts`, `server/test/models.test.ts`

- [ ] **Step 1: Failing test**

`server/test/models.test.ts`:

```ts
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { listAvailableModels, resolveModel } from "../src/models.ts";

describe("resolveModel", () => {
  test("resolves catalog models by provider/id", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-sonnet-4-6");
  });

  test("throws a helpful error for unknown refs", () => {
    expect(() => resolveModel("nope/nothing")).toThrow(/Unknown model/);
    expect(() => resolveModel("garbage")).toThrow(/provider\/modelId/);
  });
});

describe("listAvailableModels", () => {
  test("only lists providers that have API keys in env", () => {
    const models = listAvailableModels({ env: {} });
    expect(models).toEqual([]);
  });
});
```

Note: if the first test fails because `claude-sonnet-4-6` isn't in the catalog, run `node -e 'import("@earendil-works/pi-ai").then(m => console.log(m.getModels("anthropic").map(x => x.id)))'`, pick the newest Sonnet id, and update this test AND the Task 2 default.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

`server/src/models.ts`:

```ts
import { getEnvApiKey, getModels, getProviders, type Model } from "@earendil-works/pi-ai";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  ref: string; // "provider/id"
}

export type ModelResolver = (ref: string) => Model<any>;

export function resolveModel(ref: string): Model<any> {
  const slash = ref.indexOf("/");
  if (slash <= 0) throw new Error(`Model ref must be "provider/modelId", got: ${ref}`);
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const providers = getProviders() as string[];
  const model = providers.includes(provider)
    ? (getModels(provider as any) as Model<any>[]).find((m) => m.id === modelId)
    : undefined;
  if (!model) throw new Error(`Unknown model: ${ref}`);
  return model;
}

export function listAvailableModels(opts?: { env?: Record<string, string | undefined> }): ModelInfo[] {
  // getEnvApiKey reads process.env; allow injecting an empty env for tests
  const hasKey = (provider: string) =>
    opts?.env ? Object.keys(opts.env).length > 0 : getEnvApiKey(provider) !== undefined;
  return (getProviders() as string[])
    .filter(hasKey)
    .flatMap((p) =>
      (getModels(p as any) as Model<any>[]).map((m) => ({
        provider: p,
        id: m.id,
        name: m.name,
        ref: `${p}/${m.id}`,
      })),
    );
}
```

- [ ] **Step 4: Run, verify PASS.** (The faux import in the test file is unused here — remove it if the linter complains.)

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: model catalog resolution and availability listing"`

---

### Task 5: Event bus

**Files:**
- Create: `server/src/events.ts`, `server/test/events.test.ts`

- [ ] **Step 1: Failing test**

`server/test/events.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { EventBus, type ServerEvent } from "../src/events.ts";

describe("EventBus", () => {
  test("delivers events to subscribers until unsubscribed", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    bus.emit({ type: "session_deleted", sessionId: "a" });
    unsub();
    bus.emit({ type: "session_deleted", sessionId: "b" });
    expect(seen).toEqual([{ type: "session_deleted", sessionId: "a" }]);
  });

  test("a throwing subscriber does not break others", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => seen.push(e));
    bus.emit({ type: "session_deleted", sessionId: "a" });
    expect(seen.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

`server/src/events.ts`:

```ts
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SessionRow } from "./indexer.ts";

export type ServerEvent =
  | { type: "agent"; sessionId: string; event: AgentEvent }
  | { type: "session_meta"; session: SessionRow & { running: boolean } }
  | { type: "session_deleted"; sessionId: string };

export class EventBus {
  private listeners = new Set<(event: ServerEvent) => void>();

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("event listener failed", err);
      }
    }
  }
}
```

(`./indexer.ts` doesn't exist yet — create it in the next task before running `npm run check`; vitest will still pass this task's test because the import is type-only.)

- [ ] **Step 4: Run, verify PASS** (this test file only).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: in-process event bus"`

---

### Task 6: SQLite Indexer

**Files:**
- Create: `server/src/indexer.ts`, `server/test/indexer.test.ts`

- [ ] **Step 1: Failing test**

`server/test/indexer.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Indexer, type SessionRow } from "../src/indexer.ts";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "idx-")), "index.db");
}

const row: SessionRow = {
  id: "s1",
  path: "/data/sessions/--chat--/x_s1.jsonl",
  title: null,
  createdAt: "2026-06-09T10:00:00Z",
  updatedAt: "2026-06-09T10:00:00Z",
  preview: "",
  unread: false,
};

describe("Indexer", () => {
  test("upsert, touch, title, unread, list ordering, delete", () => {
    const idx = new Indexer(tempDb());
    idx.upsertSession(row);
    idx.upsertSession({ ...row, id: "s2", updatedAt: "2026-06-09T11:00:00Z" });
    idx.touchSession("s1", "2026-06-09T12:00:00Z", "hello there");
    idx.setTitle("s1", "Greetings");
    idx.setUnread("s1", true);

    const sessions = idx.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]); // newest updated first
    expect(sessions[0]).toMatchObject({ title: "Greetings", preview: "hello there", unread: true });

    idx.deleteSession("s1");
    expect(idx.listSessions().map((s) => s.id)).toEqual(["s2"]);
    expect(idx.getSession("s1")).toBeUndefined();
  });

  test("reset clears all rows for rebuild", () => {
    const path = tempDb();
    const idx = new Indexer(path);
    idx.upsertSession(row);
    idx.reset();
    expect(idx.listSessions()).toEqual([]);
  });

  test("reopening keeps data; stale schema version forces empty start", () => {
    const path = tempDb();
    const a = new Indexer(path);
    a.upsertSession(row);
    a.close();
    const b = new Indexer(path);
    expect(b.listSessions().length).toBe(1);
    b.setSchemaVersionForTest(0);
    b.close();
    const c = new Indexer(path);
    expect(c.listSessions()).toEqual([]);
    expect(c.wasReset).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

`server/src/indexer.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

export interface SessionRow {
  id: string;
  path: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
  unread: boolean;
}

export class Indexer {
  private db: DatabaseSync;
  /** true when the constructor wiped a stale/corrupt index — caller should rebuild from JSONL */
  public wasReset = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    try {
      const version = this.readSchemaVersion();
      if (version !== SCHEMA_VERSION) {
        this.recreateSchema();
        this.wasReset = version !== null; // fresh db is not a "reset"
      }
    } catch {
      this.recreateSchema();
      this.wasReset = true;
    }
  }

  private readSchemaVersion(): number | null {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .all();
    if (tables.length === 0) return null;
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  }

  private recreateSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS meta;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        unread INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX sessions_updated ON sessions(updated_at DESC);
    `);
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, path, title, created_at, updated_at, preview, unread)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path=excluded.path, title=excluded.title,
           created_at=excluded.created_at, updated_at=excluded.updated_at,
           preview=excluded.preview, unread=excluded.unread`,
      )
      .run(row.id, row.path, row.title, row.createdAt, row.updatedAt, row.preview, row.unread ? 1 : 0);
  }

  touchSession(id: string, updatedAt: string, preview: string): void {
    this.db
      .prepare("UPDATE sessions SET updated_at=?, preview=? WHERE id=?")
      .run(updatedAt, preview, id);
  }

  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, id);
  }

  setUnread(id: string, unread: boolean): void {
    this.db.prepare("UPDATE sessions SET unread=? WHERE id=?").run(unread ? 1 : 0, id);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as any;
    return r ? this.toRow(r) : undefined;
  }

  listSessions(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[]).map(
      (r) => this.toRow(r),
    );
  }

  reset(): void {
    this.recreateSchema();
  }

  close(): void {
    this.db.close();
  }

  /** test hook for simulating stale schema */
  setSchemaVersionForTest(version: number): void {
    this.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
  }

  private toRow(r: any): SessionRow {
    return {
      id: r.id,
      path: r.path,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      preview: r.preview,
      unread: r.unread === 1,
    };
  }
}
```

- [ ] **Step 4: Run, verify PASS.** Also run `npm run check` now (clears Task 5's forward reference).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sqlite session index with schema-version reset"`

---

### Task 7: Shell and file tools

**Files:**
- Create: `server/src/tools/shell.ts`, `server/src/tools/files.ts`, `server/test/tools.test.ts`

- [ ] **Step 1: Failing tests**

`server/test/tools.test.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBashTool, runCommand } from "../src/tools/shell.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/tools/files.ts";

const dir = () => mkdtempSync(join(tmpdir(), "tools-"));

describe("bash tool", () => {
  test("captures stdout+stderr and exit code", async () => {
    const result = await runCommand("echo out; echo err >&2; exit 3", { cwd: dir(), timeoutMs: 5000 });
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.exitCode).toBe(3);
  });

  test("kills on timeout", async () => {
    const result = await runCommand("sleep 10", { cwd: dir(), timeoutMs: 200 });
    expect(result.output).toContain("[timed out");
  });

  test("tool wrapper returns text content", async () => {
    const tool = createBashTool(dir());
    const r = await tool.execute("t1", { command: "echo hi" });
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect((r.content[0] as any).text).toContain("hi");
  });
});

describe("file tools", () => {
  test("write then read round-trips", async () => {
    const d = dir();
    const write = createWriteTool(d);
    const read = createReadTool(d);
    await write.execute("t1", { path: "a/b.txt", content: "hello" });
    const r = await read.execute("t2", { path: join(d, "a/b.txt") });
    expect((r.content[0] as any).text).toContain("hello");
  });

  test("edit replaces a unique occurrence and rejects ambiguous ones", async () => {
    const d = dir();
    writeFileSync(join(d, "f.txt"), "one two two");
    const edit = createEditTool(d);
    await edit.execute("t1", { path: join(d, "f.txt"), oldText: "one", newText: "ONE" });
    expect(readFileSync(join(d, "f.txt"), "utf8")).toBe("ONE two two");
    await expect(
      edit.execute("t2", { path: join(d, "f.txt"), oldText: "two", newText: "TWO" }),
    ).rejects.toThrow(/2 times/);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement shell tool**

`server/src/tools/shell.ts`:

```ts
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export const MAX_TOOL_OUTPUT = 50_000;

export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) output += `\n[timed out after ${opts.timeoutMs}ms]`;
      resolve({ output: truncate(output), exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: String(err), exitCode: null });
    });
  });
}

const bashParams = Type.Object({
  command: Type.String({ description: "Shell command, run with bash -c" }),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Max runtime in seconds (default 120)" })),
});

export function createBashTool(cwd: string): AgentTool<typeof bashParams> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command on the server. Returns combined stdout/stderr and the exit code. Output is truncated at 50k chars.",
    parameters: bashParams,
    execute: async (_id, params) => {
      const { output, exitCode } = await runCommand(params.command, {
        cwd,
        timeoutMs: (params.timeoutSeconds ?? 120) * 1000,
      });
      return {
        content: [{ type: "text", text: `exit code: ${exitCode}\n${output}` }],
        details: { exitCode },
      };
    },
  };
}
```

- [ ] **Step 4: Implement file tools**

`server/src/tools/files.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { truncate } from "./shell.ts";

function resolve(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

const readParams = Type.Object({ path: Type.String() });

export function createReadTool(cwd: string): AgentTool<typeof readParams> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a text file. Relative paths resolve against the data directory.",
    parameters: readParams,
    execute: async (_id, params) => {
      const text = await fs.readFile(resolve(cwd, params.path), "utf8");
      return { content: [{ type: "text", text: truncate(text) }], details: {} };
    },
  };
}

const writeParams = Type.Object({ path: Type.String(), content: Type.String() });

export function createWriteTool(cwd: string): AgentTool<typeof writeParams> {
  return {
    name: "write",
    label: "Write file",
    description: "Write a text file, creating parent directories. Overwrites existing files.",
    parameters: writeParams,
    execute: async (_id, params) => {
      const target = resolve(cwd, params.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, params.content, "utf8");
      return { content: [{ type: "text", text: `Wrote ${target}` }], details: {} };
    },
  };
}

const editParams = Type.Object({
  path: Type.String(),
  oldText: Type.String({ description: "Exact text to replace; must occur exactly once" }),
  newText: Type.String(),
});

export function createEditTool(cwd: string): AgentTool<typeof editParams> {
  return {
    name: "edit",
    label: "Edit file",
    description: "Replace an exact unique text occurrence in a file.",
    parameters: editParams,
    execute: async (_id, params) => {
      const target = resolve(cwd, params.path);
      const text = await fs.readFile(target, "utf8");
      const count = text.split(params.oldText).length - 1;
      if (count === 0) throw new Error(`oldText not found in ${target}`);
      if (count > 1) throw new Error(`oldText occurs ${count} times in ${target}; provide more context`);
      await fs.writeFile(target, text.replace(params.oldText, params.newText), "utf8");
      return { content: [{ type: "text", text: `Edited ${target}` }], details: {} };
    },
  };
}

const lsParams = Type.Object({ path: Type.Optional(Type.String()) });

export function createLsTool(cwd: string): AgentTool<typeof lsParams> {
  return {
    name: "ls",
    label: "List directory",
    description: "List directory entries. Defaults to the data directory.",
    parameters: lsParams,
    execute: async (_id, params) => {
      const target = resolve(cwd, params.path ?? ".");
      const entries = await fs.readdir(target, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return { content: [{ type: "text", text: truncate(lines.join("\n") || "(empty)") }], details: {} };
    },
  };
}
```

- [ ] **Step 5: Run, verify PASS.** `npx vitest --run test/tools.test.ts`

If `tool.execute("t1", {...})` fails type-check because `AgentTool.execute` expects more arguments, the extra args (`signal`, `onUpdate`) are optional — pass only the first two.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: bash and file tools"`

---

### Task 8: Search tools (grep/find) and web tools

**Files:**
- Create: `server/src/tools/search.ts`, `server/src/tools/web.ts`, `server/src/tools/index.ts`, `server/test/web-tools.test.ts`

- [ ] **Step 1: Implement search tools** (thin wrappers over `runCommand`; covered by bash tests, no dedicated test)

`server/src/tools/search.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runCommand } from "./shell.ts";

const grepParams = Type.Object({
  pattern: Type.String({ description: "Regex pattern (grep -E)" }),
  path: Type.String({ description: "File or directory to search" }),
});

export function createGrepTool(cwd: string): AgentTool<typeof grepParams> {
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents recursively with line numbers.",
    parameters: grepParams,
    execute: async (_id, params) => {
      const { output } = await runCommand(
        `grep -rnE -- ${JSON.stringify(params.pattern)} ${JSON.stringify(params.path)} | head -200`,
        { cwd, timeoutMs: 30_000 },
      );
      return { content: [{ type: "text", text: output || "(no matches)" }], details: {} };
    },
  };
}

const findParams = Type.Object({
  namePattern: Type.String({ description: "Filename glob, e.g. *.md" }),
  path: Type.String({ description: "Directory to search" }),
});

export function createFindTool(cwd: string): AgentTool<typeof findParams> {
  return {
    name: "find",
    label: "Find files",
    description: "Find files by name pattern.",
    parameters: findParams,
    execute: async (_id, params) => {
      const { output } = await runCommand(
        `find ${JSON.stringify(params.path)} -name ${JSON.stringify(params.namePattern)} | head -200`,
        { cwd, timeoutMs: 30_000 },
      );
      return { content: [{ type: "text", text: output || "(no matches)" }], details: {} };
    },
  };
}
```

- [ ] **Step 2: Failing web tool tests**

`server/test/web-tools.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createWebFetchTool, createWebSearchTool } from "../src/tools/web.ts";

const fakeFetch = (body: string, contentType: string) =>
  (async () =>
    new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;

describe("web_fetch", () => {
  test("converts html to readable text", async () => {
    const tool = createWebFetchTool(fakeFetch("<html><body><h1>Title</h1><p>Para</p><script>x()</script></body></html>", "text/html"));
    const r = await tool.execute("t1", { url: "https://example.com" });
    const text = (r.content[0] as any).text;
    expect(text).toContain("Title");
    expect(text).toContain("Para");
    expect(text).not.toContain("x()");
  });

  test("passes plain text through", async () => {
    const tool = createWebFetchTool(fakeFetch("plain body", "text/plain"));
    const r = await tool.execute("t1", { url: "https://example.com" });
    expect((r.content[0] as any).text).toContain("plain body");
  });
});

describe("web_search", () => {
  test("fails clearly without BRAVE_API_KEY", async () => {
    const tool = createWebSearchTool(fetch, {});
    await expect(tool.execute("t1", { query: "x" })).rejects.toThrow(/BRAVE_API_KEY/);
  });

  test("maps brave results", async () => {
    const body = JSON.stringify({
      web: { results: [{ title: "T", url: "https://u", description: "D" }] },
    });
    const tool = createWebSearchTool(fakeFetch(body, "application/json"), { BRAVE_API_KEY: "k" });
    const r = await tool.execute("t1", { query: "x" });
    const text = (r.content[0] as any).text;
    expect(text).toContain("T");
    expect(text).toContain("https://u");
  });
});
```

- [ ] **Step 3: Run, verify FAIL.**

- [ ] **Step 4: Implement web tools**

`server/src/tools/web.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { convert } from "html-to-text";
import { truncate } from "./shell.ts";

const fetchParams = Type.Object({ url: Type.String({ description: "URL to fetch" }) });

export function createWebFetchTool(fetchFn: typeof fetch = fetch): AgentTool<typeof fetchParams> {
  return {
    name: "web_fetch",
    label: "Fetch web page",
    description: "Fetch a URL and return its readable text content.",
    parameters: fetchParams,
    execute: async (_id, params) => {
      const res = await fetchFn(params.url, {
        headers: { "user-agent": "ytsejam/1.0" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${params.url}`);
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = contentType.includes("html")
        ? convert(body, {
            wordwrap: false,
            selectors: [
              { selector: "script", format: "skip" },
              { selector: "style", format: "skip" },
              { selector: "nav", format: "skip" },
              { selector: "a", options: { ignoreHref: false } },
            ],
          })
        : body;
      return { content: [{ type: "text", text: truncate(text, 30_000) }], details: { url: params.url } };
    },
  };
}

const searchParams = Type.Object({
  query: Type.String(),
  count: Type.Optional(Type.Number({ description: "Result count, default 8, max 20" })),
});

export function createWebSearchTool(
  fetchFn: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): AgentTool<typeof searchParams> {
  return {
    name: "web_search",
    label: "Web search",
    description: "Search the web (Brave Search). Returns titles, URLs, and snippets.",
    parameters: searchParams,
    execute: async (_id, params) => {
      const key = env.BRAVE_API_KEY;
      if (!key) throw new Error("web_search is not configured: set BRAVE_API_KEY on the server");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(Math.min(params.count ?? 8, 20)));
      const res = await fetchFn(url, {
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      const results = data.web?.results ?? [];
      const text = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ""}`).join("\n")
        : "(no results)";
      return { content: [{ type: "text", text }], details: { count: results.length } };
    },
  };
}
```

`server/src/tools/index.ts`:

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./shell.ts";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "./files.ts";
import { createFindTool, createGrepTool } from "./search.ts";
import { createWebFetchTool, createWebSearchTool } from "./web.ts";

export function createTools(dataDir: string): AgentTool<any>[] {
  return [
    createWebSearchTool(),
    createWebFetchTool(),
    createBashTool(dataDir),
    createReadTool(dataDir),
    createWriteTool(dataDir),
    createEditTool(dataDir),
    createLsTool(dataDir),
    createGrepTool(dataDir),
    createFindTool(dataDir),
  ];
}
```

- [ ] **Step 5: Run, verify PASS** — full `npm test` and `npm run check`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: search and web tools"`

---

### Task 9: AgentManager (sessions + harness wiring)

This is the core task. `AgentManager` owns the `JsonlSessionRepo`, opens one `AgentHarness` per active session, forwards harness events to the `EventBus`, and keeps the `Indexer` in sync. Tests use the faux provider — no network.

**Files:**
- Create: `server/src/manager.ts`, `server/test/helpers.ts`, `server/test/manager.test.ts`
- Delete: `server/test/smoke.test.ts` (superseded)

- [ ] **Step 1: Test helpers**

`server/test/helpers.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type Model } from "@earendil-works/pi-ai";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { AgentManager } from "../src/manager.ts";
import { PersonaStore } from "../src/persona.ts";

export function setupFaux() {
  const faux = registerFauxProvider();
  return faux;
}

export function makeManager(faux: ReturnType<typeof registerFauxProvider>) {
  const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const fauxModel = faux.getModel() as Model<any>;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    generateTitles: false,
  });
  return { manager, indexer, bus, dataDir };
}

export { fauxAssistantMessage };
```

(If `registerFauxProvider()` requires options or `getModel()` differs, check `node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts` and adjust — the registration object exposes `getModel()`, `setResponses()`, `appendResponses()`, `unregister()`.)

- [ ] **Step 2: Failing tests**

`server/test/manager.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerEvent } from "../src/events.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("AgentManager", () => {
  test("createSession indexes a row and lists it", async () => {
    const { manager, indexer } = makeManager(faux);
    const row = await manager.createSession();
    expect(row.id).toBeTruthy();
    expect(indexer.listSessions().map((s) => s.id)).toEqual([row.id]);
  });

  test("sendMessage runs a turn, persists to JSONL, updates index, emits events", async () => {
    const { manager, indexer, bus } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    faux.setResponses([fauxAssistantMessage("Hello from faux!")]);

    const row = await manager.createSession();
    await manager.sendMessage(row.id, "hi");
    await manager.waitForIdle(row.id);

    // transcript persisted
    const messages = await manager.getMessages(row.id);
    const assistant = messages.find((m: any) => m.role === "assistant") as any;
    expect(assistant.content[0].text).toContain("Hello from faux!");

    // index updated with preview + unread
    const indexed = indexer.getSession(row.id)!;
    expect(indexed.preview).toContain("Hello from faux!");
    expect(indexed.unread).toBe(true);

    // events flowed
    const types = events.filter((e) => e.type === "agent").map((e: any) => e.event.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_end");
    expect(events.some((e) => e.type === "session_meta")).toBe(true);
  });

  test("survives reopen: a second manager instance serves the same transcript", async () => {
    const first = makeManager(faux);
    faux.setResponses([fauxAssistantMessage("persisted reply")]);
    const row = await first.manager.createSession();
    await first.manager.sendMessage(row.id, "hi");
    await first.manager.waitForIdle(row.id);

    // simulate restart: new manager + EMPTY index over the same dataDir
    first.indexer.reset();
    const { AgentManager } = await import("../src/manager.ts");
    const { PersonaStore } = await import("../src/persona.ts");
    const { EventBus } = await import("../src/events.ts");
    const { join } = await import("node:path");
    const manager2 = new AgentManager({
      dataDir: first.dataDir,
      indexer: first.indexer,
      bus: new EventBus(),
      persona: new PersonaStore(join(first.dataDir, "persona")),
      resolveModel: () => faux.getModel() as any,
      defaultModel: "faux/faux",
      tools: [],
      generateTitles: false,
    });
    await manager2.rebuildIndex();

    // KEY INVARIANT: rebuilt index matches incrementally-built state (minus volatile unread)
    const rebuilt = first.indexer.getSession(row.id)!;
    expect(rebuilt.preview).toContain("persisted reply");
    const messages = await manager2.getMessages(row.id);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
  });

  test("sendMessage while running steers instead of throwing", async () => {
    const { manager } = makeManager(faux);
    // first response waits, so the run is in-flight when we send the second message
    faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return fauxAssistantMessage("first");
      },
      fauxAssistantMessage("second"),
    ]);
    const row = await manager.createSession();
    await manager.sendMessage(row.id, "one");
    await manager.sendMessage(row.id, "two"); // should not throw "busy"
    await manager.waitForIdle(row.id);
    const messages = await manager.getMessages(row.id);
    const userTexts = messages.filter((m: any) => m.role === "user").map((m: any) => m.content[0].text);
    expect(userTexts).toEqual(["one", "two"]);
  });

  test("rename and delete update index and emit events", async () => {
    const { manager, indexer, bus } = makeManager(faux);
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const row = await manager.createSession();
    await manager.rename(row.id, "My title");
    expect(indexer.getSession(row.id)!.title).toBe("My title");
    await manager.deleteSession(row.id);
    expect(indexer.getSession(row.id)).toBeUndefined();
    expect(events.some((e) => e.type === "session_deleted")).toBe(true);
  });
});
```

Faux response factories: `setResponses` accepts `AssistantMessage | (context, options, state, model) => AssistantMessage | Promise<AssistantMessage>` — the async-function form above produces the delay.

- [ ] **Step 3: Run, verify FAIL.**

- [ ] **Step 4: Implement**

`server/src/manager.ts`:

```ts
import path from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { completeSimple, getEnvApiKey, type Model } from "@earendil-works/pi-ai";
import type { EventBus } from "./events.ts";
import type { Indexer, SessionRow } from "./indexer.ts";
import type { ModelResolver } from "./models.ts";
import type { PersonaStore } from "./persona.ts";
import { composeSystemPrompt } from "./persona.ts";

const SESSIONS_CWD = "chat";

/** AgentEvent types forwarded over the bus (harness-own events stay internal) */
const FORWARDED_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export interface AgentManagerOptions {
  dataDir: string;
  indexer: Indexer;
  bus: EventBus;
  persona: PersonaStore;
  resolveModel: ModelResolver;
  defaultModel: string;
  tools: AgentTool<any>[];
  generateTitles: boolean;
}

interface OpenSession {
  id: string;
  metadata: JsonlSessionMetadata;
  session: Session;
  harness: AgentHarness;
  running: boolean;
}

export function previewOf(message: AgentMessage): string {
  const content = (message as any).content;
  if (typeof content === "string") return content.slice(0, 200);
  if (Array.isArray(content)) {
    const text = content.find((c: any) => c.type === "text")?.text;
    if (text) return String(text).slice(0, 200);
  }
  return "";
}

export class AgentManager {
  private readonly repo: JsonlSessionRepo;
  private readonly env: NodeExecutionEnv;
  private readonly open = new Map<string, OpenSession>();

  constructor(private readonly opts: AgentManagerOptions) {
    this.env = new NodeExecutionEnv({ cwd: opts.dataDir });
    this.repo = new JsonlSessionRepo({
      fs: this.env,
      sessionsRoot: path.join(opts.dataDir, "sessions"),
    });
  }

  // ---- session lifecycle ------------------------------------------------

  async createSession(modelRef?: string): Promise<SessionRow> {
    const model = this.opts.resolveModel(modelRef ?? this.opts.defaultModel);
    const session = await this.repo.create({ cwd: SESSIONS_CWD });
    const metadata = await session.getMetadata();
    await session.appendModelChange(model.provider, model.id);
    const row: SessionRow = {
      id: metadata.id,
      path: metadata.path,
      title: null,
      createdAt: metadata.createdAt,
      updatedAt: metadata.createdAt,
      preview: "",
      unread: false,
    };
    this.opts.indexer.upsertSession(row);
    this.open.set(metadata.id, this.wire(metadata, session, model));
    this.emitMeta(metadata.id);
    return row;
  }

  private async getOrOpen(id: string): Promise<OpenSession> {
    const existing = this.open.get(id);
    if (existing) return existing;
    const metadata = (await this.repo.list({ cwd: SESSIONS_CWD })).find((m) => m.id === id);
    if (!metadata) throw new Error(`Session not found: ${id}`);
    const session = await this.repo.open(metadata);
    const context = await session.buildContext();
    const model = context.model
      ? this.opts.resolveModel(`${context.model.provider}/${context.model.modelId}`)
      : this.opts.resolveModel(this.opts.defaultModel);
    const opened = this.wire(metadata, session, model);
    this.open.set(id, opened);
    return opened;
  }

  private wire(metadata: JsonlSessionMetadata, session: Session, model: Model<any>): OpenSession {
    const harness = new AgentHarness({
      env: this.env,
      session,
      model,
      tools: this.opts.tools,
      systemPrompt: async () =>
        composeSystemPrompt(await this.opts.persona.load(), { dataDir: this.opts.dataDir }),
      getApiKeyAndHeaders: async (m: Model<any>) => {
        const apiKey = getEnvApiKey(m.provider);
        return apiKey ? { apiKey } : undefined;
      },
    });
    const opened: OpenSession = { id: metadata.id, metadata, session, harness, running: false };

    harness.subscribe((event: AgentHarnessEvent) => {
      this.onHarnessEvent(opened, event);
    });
    return opened;
  }

  private onHarnessEvent(opened: OpenSession, event: AgentHarnessEvent): void {
    if (event.type === "agent_start") opened.running = true;
    if (event.type === "agent_end") opened.running = false;

    if (event.type === "message_end") {
      const message = event.message as AgentMessage;
      const preview = previewOf(message);
      if (preview) {
        this.opts.indexer.touchSession(opened.id, new Date().toISOString(), preview);
      }
      if ((message as any).role === "assistant") {
        this.opts.indexer.setUnread(opened.id, true);
      }
      this.emitMeta(opened.id);
    }

    if (FORWARDED_EVENTS.has(event.type)) {
      this.opts.bus.emit({ type: "agent", sessionId: opened.id, event: event as any });
    }

    if (event.type === "agent_end") {
      this.emitMeta(opened.id);
      if (this.opts.generateTitles) {
        // outside the run's listener settlement to avoid reentrancy
        setTimeout(() => void this.maybeGenerateTitle(opened), 0);
      }
    }
  }

  // ---- messaging ---------------------------------------------------------

  async sendMessage(id: string, text: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    if (opened.running) {
      await opened.harness.steer(text);
      return;
    }
    opened.running = true; // set eagerly: a second sendMessage before agent_start must steer
    opened.harness.prompt(text).catch((err) => {
      // run failures already surface as assistant error messages via events;
      // this catches pre-run rejections (e.g. "busy") so they don't crash the process
      console.error(`prompt failed for session ${id}`, err);
      opened.running = false;
    });
  }

  async abort(id: string): Promise<void> {
    const opened = this.open.get(id);
    if (opened) await opened.harness.abort();
  }

  async waitForIdle(id: string): Promise<void> {
    const opened = this.open.get(id);
    if (!opened) return;
    // poll: prompt() is fire-and-forget so waitForIdle may be called pre-run
    for (let i = 0; i < 600; i++) {
      if (!opened.running) {
        await opened.harness.waitForIdle();
        if (!opened.running) return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Session ${id} did not become idle`);
  }

  isRunning(id: string): boolean {
    return this.open.get(id)?.running ?? false;
  }

  async getMessages(id: string): Promise<AgentMessage[]> {
    const opened = await this.getOrOpen(id);
    return (await opened.session.buildContext()).messages;
  }

  // ---- metadata ----------------------------------------------------------

  async rename(id: string, title: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    if (!opened.running) await opened.session.appendSessionName(title);
    this.opts.indexer.setTitle(id, title);
    this.emitMeta(id);
  }

  async setModel(id: string, modelRef: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    await opened.harness.setModel(this.opts.resolveModel(modelRef));
  }

  markRead(id: string): void {
    this.opts.indexer.setUnread(id, false);
    this.emitMeta(id);
  }

  async deleteSession(id: string): Promise<void> {
    const opened = this.open.get(id);
    if (opened) {
      if (opened.running) await opened.harness.abort();
      this.open.delete(id);
      await this.repo.delete(opened.metadata);
    } else {
      const metadata = (await this.repo.list({ cwd: SESSIONS_CWD })).find((m) => m.id === id);
      if (metadata) await this.repo.delete(metadata);
    }
    this.opts.indexer.deleteSession(id);
    this.opts.bus.emit({ type: "session_deleted", sessionId: id });
  }

  // ---- index rebuild (sqlite is derived; JSONL is SSOT) -------------------

  async rebuildIndex(): Promise<void> {
    this.opts.indexer.reset();
    for (const metadata of await this.repo.list({ cwd: SESSIONS_CWD })) {
      try {
        const session = await this.repo.open(metadata);
        const entries = await session.getEntries();
        const title = (await session.getSessionName()) ?? null;
        let preview = "";
        let updatedAt = metadata.createdAt;
        for (const entry of entries) {
          if (entry.type === "message") {
            const p = previewOf(entry.message as AgentMessage);
            if (p) preview = p;
            updatedAt = entry.timestamp;
          }
        }
        this.opts.indexer.upsertSession({
          id: metadata.id,
          path: metadata.path,
          title,
          createdAt: metadata.createdAt,
          updatedAt,
          preview,
          unread: false,
        });
      } catch (err) {
        console.error(`failed to index session ${metadata.path}`, err);
      }
    }
  }

  // ---- title generation ----------------------------------------------------

  private async maybeGenerateTitle(opened: OpenSession): Promise<void> {
    try {
      if (this.opts.indexer.getSession(opened.id)?.title) return;
      const messages = (await opened.session.buildContext()).messages;
      const firstUser = messages.find((m: any) => m.role === "user");
      if (!firstUser) return;
      const model = this.opts.resolveModel(this.opts.defaultModel);
      const result = await completeSimple(model, {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Write a title (max 6 words, no quotes, no trailing punctuation) for a conversation that starts with:\n\n${previewOf(firstUser)}`,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      });
      const title = previewOf(result).split("\n")[0]?.trim().slice(0, 80);
      if (title && !opened.running) {
        await opened.session.appendSessionName(title);
        this.opts.indexer.setTitle(opened.id, title);
        this.emitMeta(opened.id);
      }
    } catch (err) {
      console.error(`title generation failed for ${opened.id}`, err);
    }
  }

  private emitMeta(id: string): void {
    const row = this.opts.indexer.getSession(id);
    if (row) {
      this.opts.bus.emit({ type: "session_meta", session: { ...row, running: this.isRunning(id) } });
    }
  }
}
```

Implementation notes for the executor:

- `completeSimple`'s `context` parameter is `Context` from pi-ai — `{ messages }` plus optional fields; check `node_modules/@earendil-works/pi-ai/dist/types.d.ts` if the object literal above doesn't type-check (it may also need `systemPrompt`).
- `harness.steer(text)` takes plain text (it builds the user message internally).
- If `AgentHarness`'s `subscribe` listener type requires a Promise return, return `undefined` — both are accepted (`Promise<void> | void`).

- [ ] **Step 5: Run, verify PASS** — `npx vitest --run test/manager.test.ts`. Debug against actual `.d.ts` files in node_modules, not by guessing.

- [ ] **Step 6: Delete the smoke test, full check**

```bash
rm server/test/smoke.test.ts
cd server && npm test && npm run check
```

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: AgentManager wiring pi harness, JSONL sessions, index, and bus"`

---

### Task 10: REST API

**Files:**
- Create: `server/src/server.ts`, `server/test/api.test.ts`

- [ ] **Step 1: Failing integration test**

`server/test/api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  faux = setupFaux();
  const made = makeManager(faux);
  deps = {
    manager: made.manager,
    indexer: made.indexer,
    bus: made.bus,
    persona: new PersonaStore(`${made.dataDir}/persona`),
    config: {
      port: 0,
      dataDir: made.dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
    },
  };
  app = createApp(deps).app;
});
afterEach(() => faux.unregister());

const auth = { Authorization: "Bearer test-token" };

describe("auth", () => {
  test("rejects missing/wrong token", async () => {
    expect((await app.request("/api/sessions")).status).toBe(401);
    expect((await app.request("/api/sessions", { headers: { Authorization: "Bearer no" } })).status).toBe(401);
  });

  test("login validates the token", async () => {
    const ok = await app.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token: "test-token" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    const bad = await app.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token: "wrong" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(401);
  });
});

describe("sessions", () => {
  test("create, list, message, transcript, rename, mark-read, delete", async () => {
    faux.setResponses([fauxAssistantMessage("api reply")]);

    const created = await app.request("/api/sessions", { method: "POST", headers: auth });
    expect(created.status).toBe(200);
    const { session } = (await created.json()) as any;

    const list = (await (await app.request("/api/sessions", { headers: auth })).json()) as any;
    expect(list.sessions.length).toBe(1);

    const sent = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(sent.status).toBe(202);
    await deps.manager.waitForIdle(session.id);

    const transcript = (await (
      await app.request(`/api/sessions/${session.id}`, { headers: auth })
    ).json()) as any;
    expect(transcript.messages.some((m: any) => m.role === "assistant")).toBe(true);
    expect(transcript.session.unread).toBe(true);

    await app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed", unread: false }),
    });
    const after = (await (await app.request("/api/sessions", { headers: auth })).json()) as any;
    expect(after.sessions[0]).toMatchObject({ title: "Renamed", unread: false });

    const del = await app.request(`/api/sessions/${session.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect(((await (await app.request("/api/sessions", { headers: auth })).json()) as any).sessions).toEqual([]);
  });

  test("404 for unknown session", async () => {
    const res = await app.request("/api/sessions/nope", { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("persona and models", () => {
  test("persona round-trip", async () => {
    const get = await app.request("/api/persona", { headers: auth });
    expect(((await get.json()) as any).content).toContain("personal assistant");
    await app.request("/api/persona", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Persona\nJeeves." }),
    });
    const get2 = await app.request("/api/persona", { headers: auth });
    expect(((await get2.json()) as any).content).toBe("# Persona\nJeeves.");
  });

  test("models endpoint returns a list", async () => {
    const res = await app.request("/api/models", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.defaultModel).toBe("faux/faux");
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

`server/src/server.ts`:

```ts
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Config } from "./config.ts";
import type { EventBus } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import type { AgentManager } from "./manager.ts";
import { listAvailableModels } from "./models.ts";
import type { PersonaStore } from "./persona.ts";

export interface AppDeps {
  manager: AgentManager;
  indexer: Indexer;
  bus: EventBus;
  persona: PersonaStore;
  config: Config;
}

export function createApp(deps: AppDeps) {
  const { manager, indexer, persona, config } = deps;
  const app = new Hono();

  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.token !== config.authToken) return c.json({ error: "invalid token" }, 401);
    return c.json({ ok: true });
  });

  // auth for everything else under /api
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login") return next();
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
    if (token !== config.authToken) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/api/sessions", (c) => {
    const sessions = indexer
      .listSessions()
      .map((s) => ({ ...s, running: manager.isRunning(s.id) }));
    return c.json({ sessions });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await manager.createSession(body.model);
    return c.json({ session: { ...session, running: false } });
  });

  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const row = indexer.getSession(id);
    if (!row) return c.json({ error: "not found" }, 404);
    const messages = await manager.getMessages(id);
    return c.json({ session: { ...row, running: manager.isRunning(id) }, messages });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }
    await manager.sendMessage(id, body.text);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    await manager.abort(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.title === "string") await manager.rename(id, body.title);
    if (body.unread === false) manager.markRead(id);
    if (typeof body.model === "string") await manager.setModel(id, body.model);
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!indexer.getSession(id)) return c.json({ error: "not found" }, 404);
    await manager.deleteSession(id);
    return c.json({ ok: true });
  });

  app.get("/api/persona", async (c) => c.json({ content: await persona.load() }));

  app.put("/api/persona", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    await persona.save(body.content);
    return c.json({ ok: true });
  });

  app.get("/api/models", (c) =>
    c.json({ models: listAvailableModels(), defaultModel: config.defaultModel }),
  );

  // static web app (built assets); SPA fallback to index.html
  app.use("/*", serveStatic({ root: config.webDistDir }));
  app.use("/*", serveStatic({ root: config.webDistDir, path: "index.html" }));

  return { app };
}
```

Note: `serveStatic` from `@hono/node-server/serve-static` takes `root` relative to the process cwd in some versions — if static serving misbehaves in Task 12, check the installed version's docs (`node_modules/@hono/node-server/README.md`). Tests don't cover static serving.

- [ ] **Step 4: Run, verify PASS** — `npx vitest --run test/api.test.ts`, then full `npm test && npm run check`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: REST API with bearer auth"`

---

### Task 11: WebSocket endpoint and server entrypoint

**Files:**
- Modify: `server/src/server.ts`
- Create: `server/src/index.ts`, `server/test/ws.test.ts`

- [ ] **Step 1: Failing test**

`server/test/ws.test.ts`:

```ts
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/server.ts";
import { PersonaStore } from "../src/persona.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let server: ReturnType<typeof serve>;
let port: number;
let made: ReturnType<typeof makeManager>;

beforeEach(async () => {
  faux = setupFaux();
  made = makeManager(faux);
  const { app, injectWebSocket } = createApp({
    manager: made.manager,
    indexer: made.indexer,
    bus: made.bus,
    persona: new PersonaStore(`${made.dataDir}/persona`),
    config: {
      port: 0,
      dataDir: made.dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
    },
  });
  server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

afterEach(async () => {
  faux.unregister();
  await new Promise((r) => server.close(r));
});

function collect(ws: WebSocket): any[] {
  const events: any[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  return events;
}

describe("websocket", () => {
  test("rejects bad token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=wrong`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.addEventListener("close", () => resolve(true));
      ws.addEventListener("open", () => resolve(false));
    });
    expect(closed).toBe(true);
  });

  test("streams agent events for subscribed session, meta for all", async () => {
    faux.setResponses([fauxAssistantMessage("ws reply")]);
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const events = collect(ws);

    const row = await made.manager.createSession();
    ws.send(JSON.stringify({ type: "subscribe", sessionId: row.id }));
    await new Promise((r) => setTimeout(r, 50));
    await made.manager.sendMessage(row.id, "hi");
    await made.manager.waitForIdle(row.id);
    await new Promise((r) => setTimeout(r, 100));

    const agentTypes = events.filter((e) => e.type === "agent").map((e) => e.event.type);
    expect(agentTypes).toContain("message_end");
    expect(events.some((e) => e.type === "session_meta")).toBe(true);
    ws.close();
  });

  test("unsubscribed sessions only get lightweight events", async () => {
    faux.setResponses([fauxAssistantMessage("quiet reply")]);
    const ws = new WebSocket(`ws://localhost:${port}/api/ws?token=test-token`);
    await new Promise((r) => ws.addEventListener("open", r));
    const events = collect(ws);

    const row = await made.manager.createSession(); // not subscribed
    await made.manager.sendMessage(row.id, "hi");
    await made.manager.waitForIdle(row.id);
    await new Promise((r) => setTimeout(r, 100));

    const agentTypes = events.filter((e) => e.type === "agent").map((e) => e.event.type);
    expect(agentTypes).toContain("agent_start");
    expect(agentTypes).toContain("agent_end");
    expect(agentTypes).not.toContain("message_update");
    expect(events.some((e) => e.type === "session_meta")).toBe(true);
    ws.close();
  });
});
```

(Node >= 22 has a global `WebSocket` client.)

- [ ] **Step 2: Run, verify FAIL** (`injectWebSocket` doesn't exist yet).

- [ ] **Step 3: Add WS to server.ts**

In `server/src/server.ts`, add imports and the WS route; `createApp` now returns `{ app, injectWebSocket }`:

```ts
import { createNodeWebSocket } from "@hono/node-ws";
import type { ServerEvent } from "./events.ts";
```

Inside `createApp`, before the routes:

```ts
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  /** events every client gets regardless of subscription (sidebar liveness) */
  const LIGHTWEIGHT = new Set(["agent_start", "agent_end"]);

  app.get(
    "/api/ws",
    upgradeWebSocket((c) => {
      if (c.req.query("token") !== config.authToken) {
        return {
          onOpen: (_evt, ws) => ws.close(4401, "unauthorized"),
        };
      }
      let subscribed: string | null = null;
      let unsubscribeBus: (() => void) | null = null;
      return {
        onOpen: (_evt, ws) => {
          unsubscribeBus = deps.bus.subscribe((event: ServerEvent) => {
            const send =
              event.type !== "agent" ||
              event.sessionId === subscribed ||
              LIGHTWEIGHT.has(event.event.type);
            if (send) ws.send(JSON.stringify(event));
          });
        },
        onMessage: (evt) => {
          try {
            const msg = JSON.parse(String(evt.data));
            if (msg.type === "subscribe") subscribed = msg.sessionId;
            if (msg.type === "unsubscribe") subscribed = null;
          } catch {
            // ignore malformed client messages
          }
        },
        onClose: () => unsubscribeBus?.(),
      };
    }),
  );
```

And change the return to `return { app, injectWebSocket };`. The WS route must be registered BEFORE the `/api/*` auth middleware runs for it — Hono middleware applies in registration order, so register the auth middleware first and exempt `/api/ws` in it (it authenticates via its own query-token check):

```ts
    if (c.req.path === "/api/login" || c.req.path === "/api/ws") return next();
```

- [ ] **Step 4: Entrypoint**

`server/src/index.ts`:

```ts
import path from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { EventBus } from "./events.ts";
import { Indexer } from "./indexer.ts";
import { AgentManager } from "./manager.ts";
import { resolveModel } from "./models.ts";
import { PersonaStore } from "./persona.ts";
import { createApp } from "./server.ts";
import { createTools } from "./tools/index.ts";

const config = loadConfig();
const indexer = new Indexer(path.join(config.dataDir, "index.db"));
const bus = new EventBus();
const persona = new PersonaStore(path.join(config.dataDir, "persona"));
const manager = new AgentManager({
  dataDir: config.dataDir,
  indexer,
  bus,
  persona,
  resolveModel,
  defaultModel: config.defaultModel,
  tools: createTools(config.dataDir),
  generateTitles: config.generateTitles,
});

// sqlite is derived: rebuild from JSONL when missing/stale, and always
// reconcile (cheap at personal scale) so JSONL edits made offline are reflected
await manager.rebuildIndex();

const { app, injectWebSocket } = createApp({ manager, indexer, bus, persona, config });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ytsejam listening on http://localhost:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
injectWebSocket(server);
```

Note: the unconditional `rebuildIndex()` on boot makes unread flags reset on restart — acceptable for v1 and keeps the rebuild path exercised constantly (it IS the invariant).

- [ ] **Step 5: Run, verify PASS** — `npm test && npm run check`. Then boot it for real:

```bash
cd server && YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-dev node src/index.ts &
sleep 2
curl -s -X POST localhost:3000/api/login -H 'content-type: application/json' -d '{"token":"dev"}'
curl -s localhost:3000/api/sessions -H 'Authorization: Bearer dev'
kill %1
```

Expected: `{"ok":true}` and `{"sessions":[]}`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: websocket event streaming and server entrypoint"`

---

### Task 12: Web app scaffold (Vite + React + Tailwind + shadcn)

**Files:**
- Create: `web/` (Vite scaffold), `web/src/lib/api.ts`, `web/src/lib/types.ts`

- [ ] **Step 1: Scaffold**

```bash
cd /home/bjk/projects/ytsejam
npm create vite@latest web -- --template react-ts
cd web && npm install
npm install react-markdown remark-gfm
npm install tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Configure Vite** — replace `web/vite.config.ts`:

```ts
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3000", ws: true },
    },
  },
});
```

Replace `web/src/index.css` content with:

```css
@import "tailwindcss";
```

Add to `web/tsconfig.json` `compilerOptions` (shadcn needs the alias):

```json
"baseUrl": ".",
"paths": { "@/*": ["./src/*"] }
```

(If the scaffold uses `tsconfig.app.json` for source settings, add it there too.)

- [ ] **Step 3: shadcn init**

```bash
cd web
npx shadcn@latest init -y
npx shadcn@latest add button input textarea dialog select scroll-area
```

Accept defaults (style: default; base color: neutral; CSS variables: yes). If `init` complains about React 19 / Tailwind 4 compatibility prompts, accept its suggested fixes. Components land in `web/src/components/ui/`.

- [ ] **Step 4: Shared types and API client**

`web/src/lib/types.ts`:

```ts
export interface SessionRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
  unread: boolean;
  running: boolean;
}

export interface ContentBlock {
  type: string; // "text" | "thinking" | "toolCall" | "image" | ...
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface ChatMessage {
  role: string; // "user" | "assistant" | "toolResult" | custom
  content: ContentBlock[] | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
  stopReason?: string;
  timestamp?: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  ref: string;
}

export type ServerEvent =
  | { type: "agent"; sessionId: string; event: { type: string; message?: ChatMessage; [k: string]: unknown } }
  | { type: "session_meta"; session: SessionRow }
  | { type: "session_deleted"; sessionId: string };
```

`web/src/lib/api.ts`:

```ts
import type { ChatMessage, ModelInfo, SessionRow } from "./types";

const TOKEN_KEY = "ytsejam-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    setToken(null);
    window.location.reload();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const client = {
  login: async (token: string): Promise<boolean> => {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  },
  listSessions: () => api<{ sessions: SessionRow[] }>("/api/sessions"),
  createSession: (model?: string) =>
    api<{ session: SessionRow }>("/api/sessions", { method: "POST", body: JSON.stringify({ model }) }),
  getSession: (id: string) => api<{ session: SessionRow; messages: ChatMessage[] }>(`/api/sessions/${id}`),
  sendMessage: (id: string, text: string) =>
    api<{ ok: true }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  abort: (id: string) => api<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  patchSession: (id: string, patch: { title?: string; unread?: false; model?: string }) =>
    api<{ ok: true }>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (id: string) => api<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  getPersona: () => api<{ content: string }>("/api/persona"),
  savePersona: (content: string) =>
    api<{ ok: true }>("/api/persona", { method: "PUT", body: JSON.stringify({ content }) }),
  getModels: () => api<{ models: ModelInfo[]; defaultModel: string }>("/api/models"),
};
```

- [ ] **Step 5: Verify build**

```bash
cd web && npm run build
```

Expected: `dist/` produced without errors (default Vite app still renders; we replace it next task).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: web app scaffold with api client"`

---

### Task 13: App shell — login, state, WebSocket

**Files:**
- Create: `web/src/lib/ws.ts`, `web/src/useApp.ts`, `web/src/components/Login.tsx`
- Modify: `web/src/App.tsx`, `web/src/main.tsx`

- [ ] **Step 1: WebSocket client with reconnect**

`web/src/lib/ws.ts`:

```ts
import { getToken } from "./api";
import type { ServerEvent } from "./types";

export function connectWs(handlers: {
  onEvent: (event: ServerEvent) => void;
  onStatus: (connected: boolean) => void;
}): { subscribe: (sessionId: string | null) => void; close: () => void } {
  let ws: WebSocket | null = null;
  let subscribed: string | null = null;
  let closed = false;
  let retryMs = 500;

  function open() {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(getToken() ?? "")}`);
    ws.onopen = () => {
      retryMs = 500;
      handlers.onStatus(true);
      if (subscribed) ws?.send(JSON.stringify({ type: "subscribe", sessionId: subscribed }));
    };
    ws.onmessage = (e) => handlers.onEvent(JSON.parse(String(e.data)));
    ws.onclose = () => {
      handlers.onStatus(false);
      if (!closed) setTimeout(open, (retryMs = Math.min(retryMs * 2, 10_000)));
    };
  }
  open();

  return {
    subscribe(sessionId) {
      subscribed = sessionId;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(sessionId ? { type: "subscribe", sessionId } : { type: "unsubscribe" }));
      }
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
```

- [ ] **Step 2: App state hook**

`web/src/useApp.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "./lib/api";
import { connectWs } from "./lib/ws";
import type { ChatMessage, ServerEvent, SessionRow } from "./lib/types";

export interface AppState {
  sessions: SessionRow[];
  currentId: string | null;
  messages: ChatMessage[];
  streaming: ChatMessage | null;
  connected: boolean;
}

export function useApp() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;

  const refreshSessions = useCallback(async () => {
    setSessions((await client.listSessions()).sessions);
  }, []);

  const onEvent = useCallback((event: ServerEvent) => {
    if (event.type === "session_meta") {
      setSessions((prev) => {
        const rest = prev.filter((s) => s.id !== event.session.id);
        const unread = event.session.id === currentIdRef.current ? false : event.session.unread;
        return [{ ...event.session, unread }, ...rest].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
      });
      if (event.session.unread && event.session.id !== currentIdRef.current) {
        notify(event.session.title ?? "New message", event.session.preview);
      }
      if (event.session.id === currentIdRef.current && event.session.unread) {
        void client.patchSession(event.session.id, { unread: false });
      }
      return;
    }
    if (event.type === "session_deleted") {
      setSessions((prev) => prev.filter((s) => s.id !== event.sessionId));
      if (event.sessionId === currentIdRef.current) setCurrentId(null);
      return;
    }
    // agent events for the subscribed (current) session
    if (event.sessionId !== currentIdRef.current) {
      if (event.event.type === "agent_start" || event.event.type === "agent_end") {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === event.sessionId ? { ...s, running: event.event.type === "agent_start" } : s,
          ),
        );
      }
      return;
    }
    const e = event.event;
    if (e.type === "message_start" || e.type === "message_update") {
      setStreaming(e.message ?? null);
    } else if (e.type === "message_end" && e.message) {
      setStreaming(null);
      setMessages((prev) => [...prev, e.message!]);
    } else if (e.type === "agent_start" || e.type === "agent_end") {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === event.sessionId ? { ...s, running: e.type === "agent_start" } : s,
        ),
      );
      if (e.type === "agent_end") setStreaming(null);
    }
  }, []);

  useEffect(() => {
    wsRef.current = connectWs({ onEvent, onStatus: setConnected });
    void refreshSessions();
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    return () => wsRef.current?.close();
  }, [onEvent, refreshSessions]);

  const selectSession = useCallback(async (id: string | null) => {
    setCurrentId(id);
    setMessages([]);
    setStreaming(null);
    wsRef.current?.subscribe(id);
    if (id) {
      const { messages } = await client.getSession(id);
      setMessages(messages);
      void client.patchSession(id, { unread: false });
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unread: false } : s)));
    }
  }, []);

  const newSession = useCallback(
    async (model?: string) => {
      const { session } = await client.createSession(model);
      setSessions((prev) => [session, ...prev]);
      await selectSession(session.id);
      return session;
    },
    [selectSession],
  );

  const send = useCallback(
    async (text: string) => {
      let id = currentIdRef.current;
      if (!id) id = (await newSession()).id;
      setMessages((prev) => [
        ...prev,
        { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
      ]);
      await client.sendMessage(id, text);
    },
    [newSession],
  );

  return {
    sessions,
    currentId,
    messages,
    streaming,
    connected,
    selectSession,
    newSession,
    send,
    refreshSessions,
  };
}

function notify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification(title, { body });
  }
}
```

- [ ] **Step 3: Login component**

`web/src/components/Login.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client, setToken } from "@/lib/api";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await client.login(value)) {
      setToken(value);
      onLoggedIn();
    } else {
      setError(true);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-lg border border-neutral-800 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">ytsejam</h1>
        <Input
          type="password"
          placeholder="Access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="text-sm text-red-400">Invalid token</p>}
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}
```

(Adjust the import of `setToken`/`client` if your api.ts export names differ — they shouldn't.)

- [ ] **Step 4: App shell**

`web/src/App.tsx` (replace entirely; Sidebar/Chat/Settings are placeholders until the next tasks):

```tsx
import { useState } from "react";
import { Login } from "./components/Login";
import { getToken } from "./lib/api";
import { useApp } from "./useApp";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => getToken() !== null);
  if (!loggedIn) return <Login onLoggedIn={() => setLoggedIn(true)} />;
  return <Main />;
}

function Main() {
  const app = useApp();
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <aside className="w-72 shrink-0 border-r border-neutral-800 p-3">
        <p className="text-sm text-neutral-400">
          {app.connected ? "connected" : "reconnecting…"} · {app.sessions.length} sessions
        </p>
      </aside>
      <main className="flex flex-1 items-center justify-center text-neutral-500">
        chat UI coming in next task
      </main>
    </div>
  );
}
```

Also simplify `web/src/main.tsx` to render `<App />` (remove Vite demo imports and delete `web/src/App.css` plus demo assets).

- [ ] **Step 5: Manual verification**

```bash
# terminal 1
cd server && YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-dev npm run dev
# terminal 2
cd web && npm run dev
```

Open http://localhost:5173 — wrong token shows error; correct token (`dev`) shows the shell with "connected". `npm run build` in `web/` must also pass.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: web shell with login, state hook, and ws client"`

---

### Task 14: Sidebar

**Files:**
- Create: `web/src/components/Sidebar.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Implement**

`web/src/components/Sidebar.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { client } from "@/lib/api";
import type { SessionRow } from "@/lib/types";

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

export function Sidebar({
  sessions,
  currentId,
  onSelect,
  onNew,
  onDeleted,
  onOpenSettings,
}: {
  sessions: SessionRow[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  onOpenSettings: () => void;
}) {
  async function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this session?")) return;
    await client.deleteSession(id);
    onDeleted(id);
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
      <div className="flex items-center gap-2 p-3">
        <Button onClick={onNew} className="flex-1">
          New chat
        </Button>
        <Button variant="outline" onClick={onOpenSettings}>
          ⚙
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group cursor-pointer rounded-md p-2 ${
              s.id === currentId ? "bg-neutral-800" : "hover:bg-neutral-900"
            }`}
          >
            <div className="flex items-center gap-2">
              {s.running && <span className="size-2 shrink-0 animate-pulse rounded-full bg-green-400" />}
              {s.unread && !s.running && <span className="size-2 shrink-0 rounded-full bg-blue-400" />}
              <span className="flex-1 truncate text-sm">{s.title ?? "New session"}</span>
              <span className="text-xs text-neutral-500">{timeAgo(s.updatedAt)}</span>
              <button
                onClick={(e) => remove(s.id, e)}
                className="hidden text-neutral-500 hover:text-red-400 group-hover:block"
                title="Delete"
              >
                ×
              </button>
            </div>
            <p className="truncate text-xs text-neutral-500">{s.preview}</p>
          </div>
        ))}
        {sessions.length === 0 && <p className="p-2 text-sm text-neutral-600">No sessions yet</p>}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 2: Wire into App.tsx** — replace `Main`:

```tsx
function Main() {
  const app = useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <Sidebar
        sessions={app.sessions}
        currentId={app.currentId}
        onSelect={(id) => void app.selectSession(id)}
        onNew={() => void app.newSession()}
        onDeleted={() => void app.refreshSessions()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex flex-1 items-center justify-center text-neutral-500">
        chat UI coming in next task
      </main>
    </div>
  );
}
```

(Add the imports; `settingsOpen` is unused until Task 16 — keep it.)

- [ ] **Step 3: Manual verification** — with both dev servers running: create sessions via "New chat", see them listed, delete one. `npm run build` passes.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: session sidebar"`

---

### Task 15: Chat view

**Files:**
- Create: `web/src/components/Chat.tsx`, `web/src/components/Message.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Message rendering**

`web/src/components/Message.tsx`:

```tsx
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "@/lib/types";

function blocks(message: ChatMessage): ContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

export function ToolCallCard({
  call,
  result,
}: {
  call: ContentBlock;
  result: ChatMessage | undefined;
}) {
  const [open, setOpen] = useState(false);
  const resultText = result
    ? blocks(result)
        .map((b) => b.text ?? "")
        .join("\n")
    : null;
  return (
    <div className="my-1 rounded-md border border-neutral-700 bg-neutral-900 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 p-2 text-left text-neutral-300"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="font-mono">{call.name}</span>
        {!result && <span className="animate-pulse text-xs text-yellow-400">running…</span>}
        {result?.isError && <span className="text-xs text-red-400">error</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-neutral-800 p-2 font-mono text-xs">
          <pre className="overflow-x-auto whitespace-pre-wrap text-neutral-400">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {resultText && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-neutral-300">{resultText}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function Message({
  message,
  toolResults,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
}) {
  if (message.role === "toolResult") return null; // rendered inside the assistant's tool card
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser ? "bg-blue-900/60" : "bg-neutral-900"
        }`}
      >
        {message.errorMessage && (
          <p className="mb-1 rounded bg-red-950 p-2 text-sm text-red-300">
            {message.stopReason === "aborted" ? "Aborted" : `Error: ${message.errorMessage}`}
          </p>
        )}
        {blocks(message).map((b, i) => {
          if (b.type === "text" && b.text) {
            return (
              <div key={i} className="prose prose-invert prose-sm max-w-none">
                <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
              </div>
            );
          }
          if (b.type === "thinking" && b.thinking) {
            return (
              <p key={i} className="border-l-2 border-neutral-700 pl-2 text-sm italic text-neutral-500">
                {b.thinking}
              </p>
            );
          }
          if (b.type === "toolCall") {
            return <ToolCallCard key={i} call={b} result={b.id ? toolResults.get(b.id) : undefined} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
```

Markdown styling uses Tailwind's typography plugin classes; install it: `npm install @tailwindcss/typography` and add `@plugin "@tailwindcss/typography";` after the import line in `web/src/index.css`.

- [ ] **Step 2: Chat container with composer**

`web/src/components/Chat.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { Message } from "./Message";

export function Chat({
  sessionId,
  messages,
  streaming,
  running,
  onSend,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: ChatMessage | null;
  running: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  const toolResults = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) toolResults.set(m.toolCallId, m);
  }

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSend(text);
  }

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && !streaming && (
          <p className="pt-20 text-center text-neutral-600">Start a conversation</p>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} toolResults={toolResults} />
        ))}
        {streaming && <Message message={streaming} toolResults={toolResults} />}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-neutral-800 p-3">
        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={running ? "Assistant is working — messages will steer it" : "Message…"}
            rows={2}
            className="flex-1 resize-none"
          />
          {running && sessionId ? (
            <Button variant="destructive" onClick={() => void client.abort(sessionId)}>
              Stop
            </Button>
          ) : (
            <Button onClick={() => void submit()}>Send</Button>
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Wire into App.tsx** — replace the placeholder `<main>`:

```tsx
      <Chat
        sessionId={app.currentId}
        messages={app.messages}
        streaming={app.streaming}
        running={app.sessions.find((s) => s.id === app.currentId)?.running ?? false}
        onSend={app.send}
      />
```

- [ ] **Step 4: Manual verification (full loop, real provider)**

```bash
cd server && YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-dev ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY npm run dev
cd web && npm run dev
```

In the browser: send "run `echo hello` with bash and tell me the output". Verify: streaming text appears token-by-token; a collapsible `bash` tool card shows; the reply lands; the sidebar preview/title updates (title via LLM ~2s after the turn); a second session keeps its own transcript; Stop button aborts a long turn. `npm run build` passes.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: chat view with streaming, markdown, and tool cards"`

---

### Task 16: Settings (persona editor + model picker)

**Files:**
- Create: `web/src/components/Settings.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Implement**

`web/src/components/Settings.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";

export function Settings({
  open,
  onOpenChange,
  currentSessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSessionId: string | null;
}) {
  const [persona, setPersona] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    void client.getPersona().then((r) => setPersona(r.content));
    void client.getModels().then((r) => {
      setModels(r.models);
      setDefaultModel(r.defaultModel);
    });
    setSaved(false);
  }, [open]);

  async function save() {
    await client.savePersona(persona);
    setSaved(true);
  }

  async function switchModel(ref: string) {
    if (currentSessionId) await client.patchSession(currentSessionId, { model: ref });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <h3 className="mb-1 text-sm font-medium">Persona</h3>
            <Textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={12} className="font-mono text-sm" />
            <div className="mt-2 flex items-center gap-2">
              <Button onClick={() => void save()}>Save persona</Button>
              {saved && <span className="text-sm text-green-400">Saved — applies from the next turn</span>}
            </div>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Model for current session</h3>
            {currentSessionId ? (
              <select
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 p-2 text-sm"
                defaultValue=""
                onChange={(e) => e.target.value && void switchModel(e.target.value)}
              >
                <option value="" disabled>
                  Switch model… (default: {defaultModel})
                </option>
                {models.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.provider} / {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-neutral-500">Open a session to switch its model.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

(Plain `<select>` instead of shadcn Select keeps it simple; swap later if desired.)

- [ ] **Step 2: Wire into App.tsx**

```tsx
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} currentSessionId={app.currentId} />
```

- [ ] **Step 3: Manual verification** — open settings, edit persona (e.g. "always sign off with 🤖"), save, send a message, verify behavior change. Switch model on a session and verify replies still work (and the JSONL gains a `model_change` entry). `npm run build` passes.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: settings with persona editor and model picker"`

---

### Task 17: Production serving, README, final verification

**Files:**
- Create: `README.md`
- Modify: `package.json` (root)

- [ ] **Step 1: Root convenience script** — add to root `package.json` scripts:

```json
"start": "npm run build && npm run start --workspace server"
```

- [ ] **Step 2: README**

`README.md`:

```markdown
# ytsejam

Web-based personal AI assistant built on the [pi agent harness](https://github.com/earendil-works/pi).
JSONL files are the source of truth; sqlite is a derived index. Spec and plans in `docs/superpowers/`.

## Run

    npm install
    YTSEJAM_AUTH_TOKEN=<secret> ANTHROPIC_API_KEY=<key> npm start
    # open http://localhost:3000 and sign in with the token

## Configuration (env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `YTSEJAM_AUTH_TOKEN` | (required) | shared login token |
| `YTSEJAM_PORT` | `3000` | HTTP port |
| `YTSEJAM_DATA_DIR` | `./data` | JSONL sessions, persona, sqlite index |
| `YTSEJAM_DEFAULT_MODEL` | `anthropic/claude-sonnet-4-6` | `provider/modelId` |
| `YTSEJAM_GENERATE_TITLES` | `true` | LLM session titles |
| `ANTHROPIC_API_KEY` etc. | — | enables that provider in the model picker |
| `BRAVE_API_KEY` | — | enables the web_search tool |

## Development

    npm run dev:server   # API on :3000 (set YTSEJAM_AUTH_TOKEN)
    npm run dev:web      # UI on :5173, proxies /api
    npm test             # server tests (vitest, faux LLM provider, no network)
    npm run check        # typescheck
```

- [ ] **Step 3: Full verification pass** (per global quality-check preference)

```bash
npm test                       # all server tests pass
npm run check                  # clean
npm run build                  # web build succeeds
git status --short             # no unintended deletions; data/ and dist/ not tracked
# end-to-end: production mode
YTSEJAM_AUTH_TOKEN=dev YTSEJAM_DATA_DIR=/tmp/ytsejam-prod npm start &
# browser: login at :3000, send a message, restart the server,
# confirm the session list and transcript survive (rebuilt from JSONL)
```

- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: README and production start script"`

- [ ] **Step 5: Done.** Use superpowers:finishing-a-development-branch to decide merge/PR. Phase 2 (delegation) gets its own plan.

---

## Spec coverage map (phase 1 slice)

| Spec requirement | Task |
| --- | --- |
| pi packages as foundation | 1, 9 |
| Bearer-token auth (REST + WS) | 10, 11 |
| JSONL sessions SSOT (`data/sessions/`) | 9 |
| `persona/persona.md`, UI-editable, composed system prompt | 3, 16 |
| sqlite derived index, rebuildable (key invariant) | 6, 9 (rebuild test), 11 (rebuild on boot) |
| Providers via env keys, catalog-driven picker, per-session model persisted | 4, 10, 16 |
| Tools: web_search, web_fetch, bash, read, write, edit, ls, grep, find | 7, 8 |
| One WS, full deltas for subscribed session + lightweight for all | 11, 13 |
| ChatGPT-style UI: sidebar, streaming markdown, tool cards, unread badges | 14, 15 |
| Auto session titles, rename, delete | 9, 14 |
| Abort / retryable error display | 9, 15 (error block in Message) |
| Server restart: JSONL survives, tasks-interrupted handling | 11 (rebuild; task interruption is phase 2) |
| Browser notifications | 13 (on unread session_meta) |

Phase 1 explicitly defers: delegation tools/TaskManager (phase 2), memory + FTS search (phase 3), scheduler (phase 4).
