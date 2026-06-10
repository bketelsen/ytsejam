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
  /** rename requested while running; flushed to JSONL on agent_end (JSONL is SSOT) */
  pendingTitle?: string;
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
  private readonly opts: AgentManagerOptions;
  private readonly repo: JsonlSessionRepo;
  private readonly env: NodeExecutionEnv;
  private readonly open = new Map<string, OpenSession>();
  private readonly opening = new Map<string, Promise<OpenSession>>();

  constructor(opts: AgentManagerOptions) {
    this.opts = opts;
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

  private getOrOpen(id: string): Promise<OpenSession> {
    const existing = this.open.get(id);
    if (existing) return Promise.resolve(existing);
    // de-dup concurrent opens: a second getOrOpen must not build a second harness
    let inflight = this.opening.get(id);
    if (!inflight) {
      inflight = this.openSession(id).finally(() => this.opening.delete(id));
      this.opening.set(id, inflight);
    }
    return inflight;
  }

  private async openSession(id: string): Promise<OpenSession> {
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
      // flush a rename that arrived mid-run: index already has it, JSONL (SSOT) does not yet
      const pending = opened.pendingTitle;
      if (pending !== undefined) {
        opened.pendingTitle = undefined;
        // async flush outside the awaited listener path
        setTimeout(() => {
          if (this.open.get(opened.id) !== opened) return; // closed or deleted
          void opened.session
            .appendSessionName(pending)
            .catch((err) => console.error(`failed to flush pending title for ${opened.id}`, err));
        }, 0);
      }
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
    if (opened.running) {
      // defer the JSONL write to agent_end; index + emit immediately for a snappy UI
      opened.pendingTitle = title;
    } else {
      await opened.session.appendSessionName(title);
    }
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
      if (this.open.get(opened.id) !== opened) return; // closed or deleted
      if (this.opts.indexer.getSession(opened.id)?.title) return;
      if (opened.pendingTitle !== undefined) return; // a user rename is pending; don't override
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
      if (this.open.get(opened.id) !== opened) return; // deleted/closed while completing
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
