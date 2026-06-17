import path from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  estimateContextTokens,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type JsonlSessionMetadata,
  type Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  completeSimple,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ApprovalCoordinator } from "./approval/coordinator.ts";
import { extractTurnOverride } from "./approval/prefix.ts";
import { deriveApprovalMode } from "./approval/session-entry.ts";
import type { ApprovalMode, SetApprovalModeEntry } from "./approval/types.ts";
import { wrapToolWithApproval, type ApprovalContext } from "./approval/wrap-tool.ts";
import type { EventBus } from "./events.ts";
import type { Indexer, SessionRow } from "./indexer.ts";
import type { ModelResolver } from "./models.ts";
import { makeApiKeyResolver, resolveApiKey } from "./pi-auth.ts";
import type { PiAuthStore } from "./pi-auth.ts";
import type { PersonaStore } from "./persona.ts";
import { composeSystemPrompt } from "./persona.ts";
import { memoryRoot } from "./memory/index.ts";
import type { LtmIngestSink } from "./memory/ltm-ingest-sink.ts";
import { createSessionCwdTools } from "./tools/index.ts";
import {
  appendDevLogLine,
  appendSessionCompactionJsonl,
  buildCompactionEvent,
  buildSurrenderAgentMessage,
  classifyOverflow,
  compactionEnabled,
  computeReserveTokens,
  decideCompaction,
  estimateKeptSetTokens,
  formatDevLogLine,
  REACTIVE_RETRY_PROMPT,
  runCompactionIfPending,
  runInlineCompactionInLoop,
  serializeJsonRecord,
  toOpenedForCompaction,
  type CompactionEntryPoint,
  type CompactionWiringState,
  type RunCompactionResult,
} from "./compaction.ts";

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
  /** extra tools built per session (e.g. delegation tools that need the session id) */
  sessionTools?: (sessionId: string) => AgentTool<any>[];
  /**
   * Resolve the working directory the cwd-bearing tools (bash/file/search)
   * should be bound against for a session. Defaults to dataDir when omitted
   * (preserves the pre-workdir behavior).
   */
  resolveWorkdir?: (sessionId: string) => string;
  /**
   * Whether a session is currently archived (soft-deleted). The flag is SSOT
   * outside the indexer — index.db is rebuilt from JSONL on boot and so the
   * archived column can't be authoritative; the caller passes a lookup that
   * reads the per-session sidecar. Defaults to false when omitted.
   */
  isArchived?: (sessionId: string) => boolean;
  /**
   * Persist a change to a session's archived state into the same SSOT that
   * `isArchived` reads from. Called by archiveSession/unarchiveSession so the
   * manager doesn't need a direct ArchiveStore dependency (parallels the read
   * hook). When omitted, archive/unarchive only update the derived index and
   * emit events — useful for tests that don't care about persistence.
   */
  markArchived?: (sessionId: string, archived: boolean) => void;
  /**
   * Optional: load AGENTS.md/CLAUDE.md ancestor-chain context for a
   * resolved workdir. Returned text is injected into the system prompt
   * under "## Project context files". Returns "" or undefined to skip.
   */
  loadContextFiles?: (cwd: string) => Promise<string>;
  generateTitles: boolean;
  authStore: PiAuthStore;
  /** renders the "## Memory (cog)" system-prompt section from session_brief */
  cogBrief?: { promptSection(): Promise<string> };
  /** renders the "## Skills" routing-table system-prompt section */
  skills?: { promptSection(): Promise<string> };
  /** Approval prompt coordinator, plumbed now for gated-tool integration. */
  approvalCoordinator?: ApprovalCoordinator;
  /**
   * Optional LTM ingest hook fired fire-and-forget when a chat session
   * settles at agent_end. Lazy getter (not a direct ref) because the
   * managers are constructed before the LTM store is opened at boot;
   * the thunk re-reads the live ref each call, so it also correctly
   * returns null after shutdown detaches LTM via attachLtm(null).
   */
  ltm?: () => LtmIngestSink | null;
}

interface OpenSession {
  id: string;
  metadata: JsonlSessionMetadata;
  session: Session<JsonlSessionMetadata>;
  harness: AgentHarness;
  running: boolean;
  compacting: boolean;
  /** Mutated per-turn; wrapped tools read via closure to resolve effective mode. */
  currentEffectiveMode: { value: ApprovalMode };
  /** rename requested while running; flushed to JSONL on agent_end (JSONL is SSOT) */
  pendingTitle?: string;
  compaction?: CompactionWiringState;
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

const TITLE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
];
const TITLE_WORD_CAP = 12;

function stripTrailingTitlePunctuation(s: string): string {
  return s.replace(/[.,;:]$/, "");
}

function sanitizeTitle(s: string): string {
  let title = s;
  for (const [open, close] of TITLE_QUOTE_PAIRS) {
    if (title.length >= open.length + close.length && title.startsWith(open) && title.endsWith(close)) {
      title = title.slice(open.length, title.length - close.length).trim();
      break;
    }
  }

  title = stripTrailingTitlePunctuation(title);

  const words = title.match(/\S+/g) ?? [];
  if (words.length > TITLE_WORD_CAP) {
    title = stripTrailingTitlePunctuation(words.slice(0, TITLE_WORD_CAP).join(" "));
  }

  return title;
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

  private wrapTools(
    baseTools: AgentTool<any>[],
    sessionId: string,
    effectiveModeRef: { value: ApprovalMode },
  ): AgentTool<any>[] {
    if (!this.opts.approvalCoordinator) return baseTools;
    const ctx: ApprovalContext = {
      sessionId,
      coordinator: this.opts.approvalCoordinator,
      effectiveMode: () => effectiveModeRef.value,
    };
    return baseTools.map((tool) => wrapToolWithApproval(tool, ctx));
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
      archived: this.opts.isArchived?.(metadata.id) ?? false,
      approvalMode: "yolo",
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
    const metadata = (await this.repo.list({ cwd: SESSIONS_CWD })).find(
      (m) => m.id === id,
    );
    if (!metadata) throw new Error(`Session not found: ${id}`);
    const session = await this.repo.open(metadata);
    const context = await session.buildContext();
    const model = this.resolveSessionModel(id, context.model);
    const opened = this.wire(metadata, session, model);
    this.open.set(id, opened);
    return opened;
  }

  /**
   * Resolve the model an opened session should run on. A session's transcript
   * pins the model it last used (context.model, derived from the last
   * assistant message / model_change). When that pinned model has vanished
   * from the catalog — e.g. a github-copilot entry disabled upstream —
   * resolveModel throws "Unknown model:". That must NOT brick the session:
   * fall back to the default so the transcript stays openable, and let the
   * user re-pick via setModel. A default that itself fails to resolve is a
   * genuine misconfiguration and is allowed to throw.
   */
  private resolveSessionModel(
    id: string,
    pinned: { provider: string; modelId: string } | null,
  ): Model<any> {
    if (!pinned) return this.opts.resolveModel(this.opts.defaultModel);
    const pinnedRef = `${pinned.provider}/${pinned.modelId}`;
    try {
      return this.opts.resolveModel(pinnedRef);
    } catch (err) {
      console.warn(
        `[manager] session ${id}: pinned model ${pinnedRef} no longer ` +
          `resolves (${(err as Error).message}); falling back to default ` +
          `${this.opts.defaultModel}`,
      );
      return this.opts.resolveModel(this.opts.defaultModel);
    }
  }

  private wire(
    metadata: JsonlSessionMetadata,
    session: Session<JsonlSessionMetadata>,
    model: Model<any>,
  ): OpenSession {
    const sessionCwd =
      this.opts.resolveWorkdir?.(metadata.id) ?? this.opts.dataDir;
    const currentEffectiveMode = { value: "yolo" as ApprovalMode };
    const sessionRow = this.opts.indexer.getSession(metadata.id);
    if (sessionRow?.approvalMode) currentEffectiveMode.value = sessionRow.approvalMode;
    const baseTools = [
      ...this.opts.tools,
      ...createSessionCwdTools(sessionCwd),
      ...(this.opts.sessionTools?.(metadata.id) ?? []),
    ];
    const harness = new AgentHarness({
      env: this.env,
      session,
      model,
      tools: this.wrapTools(baseTools, metadata.id, currentEffectiveMode),
      systemPrompt: async () => {
        // prompt sections must never block or break a session
        // resolve the workdir fresh each turn so a mid-session change picks up
        // new AGENTS.md ancestry without reopening
        const liveCwd =
          this.opts.resolveWorkdir?.(metadata.id) ?? this.opts.dataDir;
        const [persona, cogSection, skillsSection, contextFiles] =
          await Promise.all([
            this.opts.persona.load(),
            this.opts.cogBrief?.promptSection().catch(() => undefined),
            this.opts.skills?.promptSection().catch(() => undefined),
            this.opts.loadContextFiles?.(liveCwd).catch(() => ""),
          ]);
        return composeSystemPrompt(persona, {
          dataDir: this.opts.dataDir,
          cogSection,
          skillsSection,
          contextFiles,
        });
      },
      getApiKeyAndHeaders: makeApiKeyResolver(this.opts.authStore),
    });
    const opened: OpenSession = {
      id: metadata.id,
      metadata,
      session,
      harness,
      running: false,
      compacting: false,
      currentEffectiveMode,
    };

    // Catch + swallow: a compaction-bookkeeping bug must not kill the user's
    // turn. Errors are still console.error'd inside onHarnessEvent.
    harness.subscribe((event: AgentHarnessEvent) =>
      this.onHarnessEvent(opened, event).catch((err) =>
        console.error(
          `agent event handler failed for session ${opened.id}`,
          err,
        ),
      ),
    );

    // Inner-loop proactive compaction: fires once per turn before the LLM call.
    // Uses pi-agent-core's pure compaction functions (via runInlineCompactionInLoop)
    // to bypass harness.compact()'s phase==="idle" guard. Issue #70 PR 2.
    //
    // Blanket try/catch is MANDATORY: hook errors propagate via normalizeHookError
    // and abort the autonomous run. Any failure must degrade to "preserve original
    // context, fall back to reactive backstop at agent_end."
    harness.on("context", async (event) => {
      try {
        // Kill-switch: compaction disabled at boot
        if (!opened.compaction) return undefined;
        // Cheap no-op: nothing pending → don't even fetch the branch
        if (!opened.compaction.pendingCompaction) return undefined;
        // Fetch the current branch (the messages pi would send to the LLM)
        const branchEntries = await opened.session.getBranch();
        const result = await this.runPendingInlineCompactionInLoop(
          opened,
          branchEntries,
          "inner_loop",
        );
        if (result.ok && result.newMessages) {
          return { messages: result.newMessages };
        }
        if (result.surrendered) {
          return {
            messages: [...event.messages, buildSurrenderAgentMessage(opened, 0)],
          };
        }
        return undefined;
      } catch (err) {
        console.error(
          `[compaction] inner-loop hook failed for session ${opened.metadata.id}:`,
          err,
        );
        return undefined;
      }
    });

    // Compaction wiring (no-op if YTSEJAM_COMPACTION_ENABLED=false at boot)
    if (compactionEnabled()) {
      opened.compaction = {
        pendingCompaction: null,
        reactiveRetryAttempted: false,
      };
    }
    return opened;
  }

  private async onHarnessEvent(
    opened: OpenSession,
    event: AgentHarnessEvent,
  ): Promise<void> {
    if (event.type === "agent_start") opened.running = true;
    if (event.type === "agent_end") opened.running = false;

    if (event.type === "message_end") {
      this.recordMessageEnd(opened, event.message as AgentMessage);
    }

    if (FORWARDED_EVENTS.has(event.type)) {
      this.opts.bus.emit({
        type: "agent",
        sessionId: opened.id,
        event: event as any,
      });
    }

    if (event.type === "turn_end") {
      await this.handleCompactionTurnEnd(opened, event);
    }

    if (event.type === "session_compact" && opened.compaction) {
      opened.compaction.lastCompactionDetails = event.compactionEntry;
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
            .catch((err) =>
              console.error(
                `failed to flush pending title for ${opened.id}`,
                err,
              ),
            );
        }, 0);
      }
      this.emitMeta(opened.id);
      if (this.opts.generateTitles) {
        // outside the run's listener settlement to avoid reentrancy
        setTimeout(() => void this.maybeGenerateTitle(opened), 0);
      }
      setTimeout(() => {
        void this.opts.ltm
          ?.()
          ?.ingestSessionFile(opened.metadata.path)
          .catch((err) =>
            console.error(
              `failed to ingest session ${opened.id} into LTM`,
              err,
            ),
          );
      }, 0);
      if (opened.compaction?.pendingCompaction?.trigger === "reactive") {
        // Reactive overflow recovery runs at agent_end, not turn_end, because:
        //   (1) harness.compact() requires phase === "idle" — the agent_end
        //       handler runs AFTER phase has been set to idle (see pi's
        //       handleAgentEvent in agent-loop.js).
        //   (2) turn_end's listener still runs while the agent is mid-loop;
        //       calling compact() from there would throw "busy".
        // The retry uses setTimeout(0) to leave the awaited listener settlement
        // before calling prompt(), avoiding pi's reentrancy guard.
        opened.compaction.lastCompactionDetails = undefined;

        this.markCompactionStart(opened, "reactive");
        let endStatus: "succeeded" | "surrendered" | "failed" = "failed";
        try {
          const result = await runCompactionIfPending(
            toOpenedForCompaction({
              session: opened.session,
              metadata: opened.metadata,
              harness: opened.harness,
              compaction: opened.compaction,
            }),
            this.repo,
          );
          if (result.fired) {
            await this.recordCompactionEvent(
              opened,
              result,
              opened.compaction.lastCompactionDetails,
              "reactive_path",
            );
            opened.compaction.lastCompactionDetails = undefined;
          }
          endStatus = result.succeeded ? "succeeded" : "surrendered";
          if (!result.succeeded) {
            await this.emitCompactionSurrender(opened);
          } else {
            setTimeout(() => {
              if (this.open.get(opened.id) !== opened) return; // closed or deleted
              opened.running = true;
              opened.harness.prompt(REACTIVE_RETRY_PROMPT).catch((err) => {
                console.error(
                  `reactive retry prompt failed for session ${opened.id}`,
                  err,
                );
                opened.running = false;
              });
            }, 0);
          }
        } finally {
          this.markCompactionEnd(opened, endStatus);
        }
      }
    }
  }

  private async handleCompactionTurnEnd(
    opened: OpenSession,
    event: AgentHarnessEvent,
  ): Promise<void> {
    if (!opened.compaction || event.type !== "turn_end") return;
    const msg = event.message as AssistantMessage;
    const model = opened.harness.getModel();

    if (msg.stopReason === "error") {
      if (classifyOverflow(msg, model)) {
        if (opened.compaction.reactiveRetryAttempted) {
          opened.compaction.pendingCompaction = null;
          opened.compaction.reactiveRetryAttempted = false;
          await this.emitCompactionSurrender(opened);
          return;
        }
        opened.compaction.reactiveRetryAttempted = true;
        opened.compaction.pendingCompaction = {
          trigger: "reactive",
          reason: "isContextOverflow",
          tokensBefore: 0,
          budget: model.contextWindow - computeReserveTokens(model),
        };
      }
      return;
    }

    opened.compaction.reactiveRetryAttempted = false;
    try {
      const messages = (await opened.session.buildContext()).messages;
      const decision = decideCompaction(messages, opened.harness.getModel());
      if (decision.shouldFire) {
        opened.compaction.pendingCompaction = {
          trigger: "proactive",
          reason: decision.reason,
          tokensBefore: decision.tokensBefore,
          budget: decision.budget,
        };
      }
    } catch (err) {
      console.error("[compaction] turn_end decision failed:", err);
    }
  }

  private async runPendingCompactionAtIdle(
    opened: OpenSession,
    entryPoint: CompactionEntryPoint,
  ): Promise<boolean> {
    if (!opened.compaction?.pendingCompaction) return true;
    opened.compaction.lastCompactionDetails = undefined;

    this.markCompactionStart(opened, "proactive");
    let endStatus: "succeeded" | "surrendered" | "failed" = "failed";
    try {
      const result = await runCompactionIfPending(
        toOpenedForCompaction({
          session: opened.session,
          metadata: opened.metadata,
          harness: opened.harness,
          compaction: opened.compaction,
        }),
        this.repo,
      );
      if (result.fired) {
        await this.recordCompactionEvent(
          opened,
          result,
          opened.compaction.lastCompactionDetails,
          entryPoint,
        );
        opened.compaction.lastCompactionDetails = undefined;
      }
      endStatus = result.surrendered ? "surrendered" : "succeeded";
      if (result.surrendered) {
        await this.emitCompactionSurrender(opened);
        return false;
      }
      return true;
    } finally {
      this.markCompactionEnd(opened, endStatus);
    }
  }

  /**
   * Inner-loop pending-compaction wrapper. Symmetric to `runPendingCompactionAtIdle`
   * but uses `runInlineCompactionInLoop` (pure functions, no phase guard) instead of
   * `runCompactionIfPending` (harness.compact() wrapper).
   *
   * Called from the `context` hook handler (registered in Task 4) — the only safe
   * site to invoke inline compaction from `phase==="turn"`.
   *
   * Returns a discriminated result:
   * - `{ ok: true, newMessages: [...] }` → happy path; caller returns `{ messages: newMessages }` from the hook
   * - `{ ok: false, surrendered: true }` → caller appends surrender notice to event.messages
   * - `{ ok: true, newMessages: undefined }` → no-op (nothing pending); caller returns `undefined`
   *
   * NOTE: the inline path does NOT populate `opened.compaction.lastCompactionDetails`
   * (pi's `session_before_compact` hook is not invoked by the pure-function path),
   * so observability for inline compactions has reduced detail (no filesRead/filesModified
   * in the dev-log entry; firstKeptEntryId comes from result.compactionEntryId where available).
   */
  private async runPendingInlineCompactionInLoop(
    opened: OpenSession,
    branchEntries: SessionTreeEntry[],
    entryPoint: CompactionEntryPoint,
  ): Promise<{ ok: boolean; newMessages?: AgentMessage[]; surrendered: boolean }> {
    if (!opened.compaction?.pendingCompaction) {
      return { ok: true, surrendered: false };
    }

    this.markCompactionStart(opened, "proactive");
    let endStatus: "succeeded" | "surrendered" | "failed" = "failed";
    try {
      const result = await runInlineCompactionInLoop(
        toOpenedForCompaction({
          session: opened.session,
          metadata: opened.metadata,
          harness: opened.harness,
          compaction: opened.compaction,
        }),
        branchEntries,
        this.repo,
      );
      if (result.fired) {
        // Synthesize a minimal compactionEntry from the inline result's
        // compactionEntryId; the inline path does NOT populate
        // opened.compaction.lastCompactionDetails (no session_before_compact hook).
        const syntheticEntry = result.compactionEntryId
          ? { firstKeptEntryId: result.compactionEntryId }
          : undefined;
        await this.recordCompactionEvent(
          opened,
          result,
          syntheticEntry,
          entryPoint,
        );
      }
      endStatus = result.surrendered ? "surrendered" : "succeeded";
      if (result.surrendered) {
        await this.emitCompactionSurrender(opened);
        return { ok: false, surrendered: true };
      }
      return {
        ok: !!result.succeeded,
        newMessages: result.newMessages,
        surrendered: false,
      };
    } finally {
      this.markCompactionEnd(opened, endStatus);
    }
  }

  private recordMessageEnd(opened: OpenSession, message: AgentMessage): void {
    const preview = previewOf(message);
    if (preview) {
      this.opts.indexer.touchSession(
        opened.id,
        new Date().toISOString(),
        preview,
      );
    }
    if ((message as any).role === "assistant") {
      this.opts.indexer.setUnread(opened.id, true);
    }
    this.emitMeta(opened.id);
  }

  private async emitCompactionSurrender(opened: OpenSession): Promise<void> {
    let tokens = 0;
    try {
      tokens = estimateContextTokens(
        (await opened.session.buildContext()).messages,
      ).tokens;
    } catch {
      // Best-effort diagnostic only.
    }
    const message = buildSurrenderAgentMessage(opened, tokens);
    await opened.harness.appendMessage(message);
    this.recordMessageEnd(opened, message);
    this.opts.bus.emit({
      type: "agent",
      sessionId: opened.id,
      event: { type: "message_start", message } as any,
    });
    this.opts.bus.emit({
      type: "agent",
      sessionId: opened.id,
      event: { type: "message_end", message } as any,
    });
    this.opts.bus.emit({
      type: "agent",
      sessionId: opened.id,
      event: { type: "turn_end", message, toolResults: [] } as any,
    });
  }

  private async recordCompactionEvent(
    opened: OpenSession,
    result: RunCompactionResult,
    compactionEntry: any,
    entryPoint: CompactionEntryPoint,
  ): Promise<void> {
    if (!opened.compaction) return;
    const model = opened.harness.getModel();
    const sessionFilePath = opened.metadata.path;

    // Compute tokensAfterEstimated via a structural char/4 walk over the
    // post-compact kept-set, deliberately bypassing estimateContextTokens —
    // see #72: that helper anchors on the last surviving assistant's
    // usage.totalTokens, which is the stale pre-compact snapshot from the
    // very turn that triggered compaction and would tautologically return
    // tokens_before_estimated. Best-effort: any throw falls back to 0.
    let tokensAfterEstimated = 0;
    try {
      const messages = (await opened.session.buildContext()).messages;
      const summaryTokens =
        compactionEntry?.summaryTokens ??
        Math.ceil(String(compactionEntry?.summary ?? "").length / 4);
      tokensAfterEstimated = estimateKeptSetTokens(messages, summaryTokens);
    } catch {
      // Best-effort diagnostic only; buildCompactionEvent falls back to 0.
    }

    const enrichedEntry = {
      ...(compactionEntry ?? {}),
      sessionId: opened.metadata.id,
      // key stays pi-shape; buildCompactionEvent reads compactionEntry?.tokensAfter
      tokensAfter: tokensAfterEstimated,
    };
    const devLogPath = `${memoryRoot()}/projects/ytsejam/dev-log.md`;
    const compactionEvent = buildCompactionEvent(
      model,
      sessionFilePath,
      result,
      enrichedEntry,
      entryPoint,
    );

    // Dev-log entry — write to the cog memory dev-log file.
    await appendDevLogLine(formatDevLogLine(compactionEvent), devLogPath);

    // Per-session JSONL record — co-located with the session file.
    await appendSessionCompactionJsonl(
      sessionFilePath,
      serializeJsonRecord(compactionEvent),
    );
  }

  // ---- messaging ---------------------------------------------------------

  async sendMessage(id: string, text: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    // Per-turn override: /yolo or /careful prefix wins over the persisted session toggle.
    const { override, message } = extractTurnOverride(text);
    const effectiveText = message;
    if (opened.running) {
      // Mid-turn steer: do NOT touch currentEffectiveMode — the running turn
      // keeps its starting mode (locked design decision).
      await opened.harness.steer(effectiveText);
      return;
    }
    // Fresh turn: resolve effective mode now.
    const sessionMode = this.opts.indexer.getSession(id)?.approvalMode ?? "yolo";
    opened.currentEffectiveMode.value = override ?? sessionMode;
    if (!(await this.runPendingCompactionAtIdle(opened, "idle"))) return;
    opened.running = true; // set eagerly: a second sendMessage before agent_start must steer
    opened.harness.prompt(effectiveText).catch((err) => {
      // run failures already surface as assistant error messages via events;
      // this catches pre-run rejections (e.g. "busy") so they don't crash the process
      console.error(`prompt failed for session ${id}`, err);
      opened.running = false;
    });
  }

  /**
   * Inject an out-of-band message (task result, scheduled prompt). The
   * assistant always takes a turn on it: queued as a follow-up when a run is
   * active, or started as a fresh turn when idle.
   */
  async injectMessage(id: string, text: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    const { override, message } = extractTurnOverride(text);
    const effectiveText = message;
    if (opened.running) {
      // Mid-turn followUp: do NOT touch currentEffectiveMode — the running
      // turn keeps its starting mode (locked design decision).
      await opened.harness.followUp(effectiveText);
      return;
    }
    const sessionMode = this.opts.indexer.getSession(id)?.approvalMode ?? "yolo";
    opened.currentEffectiveMode.value = override ?? sessionMode;
    if (!(await this.runPendingCompactionAtIdle(opened, "idle"))) return;
    opened.running = true;
    opened.harness.prompt(effectiveText).catch((err) => {
      console.error(`task result injection failed for session ${id}`, err);
      opened.running = false;
    });
  }

  async abort(id: string): Promise<void> {
    const opened = this.open.get(id);
    if (opened) await opened.harness.abort();
  }

  /**
   * Abort every open session's in-flight pi-ai turn. Used by the SIGTERM
   * drain in index.ts. Uses Promise.allSettled so one harness's failure
   * does not block the others; per-call errors are logged but not thrown.
   * Idempotent — calling on an empty/already-drained set is a no-op.
   */
  async abortAll(): Promise<void> {
    const aborts = Array.from(this.open.values()).map(async (opened) => {
      try {
        await opened.harness.abort();
      } catch (err) {
        console.warn(
          `[manager.abortAll] abort failed for session ${opened.id}: ${(err as Error).message}`,
        );
      }
    });
    await Promise.allSettled(aborts);
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

  isCompacting(id: string): boolean {
    return this.open.get(id)?.compacting ?? false;
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

  /**
   * Trigger title generation for a session that's missing one. No-op if the
   * session already has a title, or has no user messages, or is mid-rename.
   * Same path as the automatic post-first-turn trigger (maybeGenerateTitle)
   * — same invariants, same races. Built for one-shot backfill of sessions
   * that pre-date the OAuth fix (commit c2cf026); also handy as a general
   * "regenerate" operator action.
   */
  async regenerateTitle(id: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    await this.maybeGenerateTitle(opened);
  }

  async setModel(id: string, modelRef: string): Promise<void> {
    const opened = await this.getOrOpen(id);
    await opened.harness.setModel(this.opts.resolveModel(modelRef));
  }

  async setApprovalMode(id: string, mode: ApprovalMode): Promise<void> {
    const opened = await this.getOrOpen(id);
    const storage = opened.session.getStorage();
    const entry: SetApprovalModeEntry = {
      type: "set_approval_mode",
      id: await storage.createEntryId(),
      parentId: await storage.getLeafId(),
      timestamp: new Date().toISOString(),
      mode,
    };
    await storage.appendEntry(entry as unknown as SessionTreeEntry);
    this.opts.indexer.setApprovalMode(id, mode);
    this.emitMeta(id);
    this.opts.bus.emit({ type: "approval_mode_changed", sessionId: id, mode });
    const liveOpened = this.open.get(id);
    if (liveOpened && !liveOpened.running) {
      // Mid-turn flips must not leak into the running turn — locked design
      // decision (docs/plans/2026-06-14-approval-mode-design.md lines 205-207).
      // The next sendMessage/injectMessage reads indexer.approvalMode and sets
      // the ref, so next-turn propagation is preserved without the live write.
      liveOpened.currentEffectiveMode.value = mode;
    }
  }

  /**
   * Apply a workdir change to a session: rebuild its cwd-bearing tools
   * against the freshly-resolved workdir. The persistence step (appending
   * the workdir event to the SSOT JSONL) is the caller's responsibility —
   * by the time this runs, opts.resolveWorkdir(id) must already return the
   * new value. Idempotent and safe to call on a session that isn't open
   * yet; the next openSession() will pick up the new dir via wire().
   */
  async applyWorkdirChange(id: string): Promise<void> {
    const opened = this.open.get(id);
    if (!opened) return; // not loaded; next open will resolve fresh
    const cwd = this.opts.resolveWorkdir?.(id) ?? this.opts.dataDir;
    const baseTools = [
      ...this.opts.tools,
      ...createSessionCwdTools(cwd),
      ...(this.opts.sessionTools?.(id) ?? []),
    ];
    await opened.harness.setTools(this.wrapTools(baseTools, id, opened.currentEffectiveMode));
  }

  /** Resolved working dir for a session (the cwd its tools currently bind to). */
  resolveWorkdir(id: string): string {
    return this.opts.resolveWorkdir?.(id) ?? this.opts.dataDir;
  }

  markRead(id: string): void {
    this.opts.indexer.setUnread(id, false);
    this.emitMeta(id);
  }

  async archiveSession(id: string): Promise<void> {
    // Archive is non-destructive: leave a running session running, leave the
    // open-map entry alone (so an in-flight turn completes normally), and
    // never call repo.delete — the JSONL stays on disk. The session is only
    // hidden from the default list via the derived archived flag.
    this.opts.markArchived?.(id, true);
    this.opts.indexer.setArchived(id, true);
    this.opts.bus.emit({ type: "session_archived", sessionId: id });
  }

  async unarchiveSession(id: string): Promise<void> {
    this.opts.markArchived?.(id, false);
    this.opts.indexer.setArchived(id, false);
    this.opts.bus.emit({ type: "session_unarchived", sessionId: id });
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
          archived: this.opts.isArchived?.(metadata.id) ?? false,
          approvalMode: deriveApprovalMode(entries),
        });
      } catch (err) {
        console.error(`failed to index session ${metadata.path}`, err);
      }
    }
  }

  // ---- title generation ----------------------------------------------------

  private async maybeGenerateTitle(opened: OpenSession): Promise<void> {
    try {
      const logSkip = (level: "debug" | "warn", reason: string): void => {
        console[level](`maybeGenerateTitle skipped for ${opened.id}: ${reason}`);
      };

      if (this.open.get(opened.id) !== opened) {
        logSkip("debug", "session closed before title generation");
        return; // closed or deleted
      }
      if (this.opts.indexer.getSession(opened.id)?.title) return;
      if (opened.pendingTitle !== undefined) return; // a user rename is pending; don't override
      const messages = (await opened.session.buildContext()).messages;
      const firstUser = messages.find((m: any) => m.role === "user");
      if (!firstUser) {
        logSkip("warn", "no user message yet");
        return;
      }
      const model = this.opts.resolveModel(this.opts.defaultModel);
      // Same auth path the harness uses (commit 1850785 introduced OAuth via
      // PiAuthStore for the harness but missed this call site). Without an
      // apiKey, completeSimple silently returns content:[] + stopReason:"error"
      // for OAuth-only providers (e.g. github-copilot) and titles never get
      // written.
      const apiKey = await resolveApiKey(model.provider, this.opts.authStore);
      const result = await completeSimple(
        model,
        {
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
        },
        apiKey ? { apiKey } : undefined,
      );
      if (this.open.get(opened.id) !== opened) {
        logSkip("warn", "session closed during completion");
        return; // deleted/closed while completing
      }
      // Defensive: provider errors (auth, rate limit, network) come back as
      // stopReason:"error" with empty content rather than a thrown exception.
      // Don't write garbage titles and don't fail silently — log instead so the
      // failure mode is visible in logs.
      if (result.stopReason !== "stop") {
        console.error(
          `title generation failed for ${opened.id}: stopReason=${result.stopReason}${result.errorMessage ? ` ${result.errorMessage}` : ""}`,
        );
        return;
      }
      const title = sanitizeTitle(previewOf(result).split("\n")[0].trim()).slice(0, 80);
      if (!title) {
        logSkip("warn", "model returned empty title");
        return;
      }
      // Re-check user-rename invariants at the WRITE point, not just at the
      // start. Between the early-return at the top of this function and here,
      // a user can land a rename() (which sets pendingTitle synchronously when
      // running, or writes title + setTitle directly when idle). User rename
      // ALWAYS wins over auto-generation.
      if (this.opts.indexer.getSession(opened.id)?.title) {
        logSkip("debug", "title set during completion (user rename won)");
        return;
      }
      if (opened.pendingTitle !== undefined) {
        logSkip("debug", "user rename pending at write point");
        return;
      }
      // Mirror rename()'s shape: when running, defer the JSONL append to the
      // agent_end pendingTitle flush; index + emit immediately so the UI sees
      // the title in the next list/meta event. When idle, write through.
      if (opened.running) {
        opened.pendingTitle = title;
      } else {
        await opened.session.appendSessionName(title);
      }
      this.opts.indexer.setTitle(opened.id, title);
      this.emitMeta(opened.id);
    } catch (err) {
      console.error(`title generation failed for ${opened.id}`, err);
    }
  }

  private markCompactionStart(
    opened: OpenSession,
    trigger: "proactive" | "reactive",
  ): void {
    if (opened.compacting) return;
    opened.compacting = true;
    this.opts.bus.emit({
      type: "compaction_start",
      sessionId: opened.id,
      trigger,
    });
    this.emitMeta(opened.id);
  }

  private markCompactionEnd(
    opened: OpenSession,
    status: "succeeded" | "surrendered" | "failed",
  ): void {
    if (!opened.compacting) return;
    opened.compacting = false;
    this.opts.bus.emit({
      type: "compaction_end",
      sessionId: opened.id,
      status,
    });
    this.emitMeta(opened.id);
  }

  private emitMeta(id: string): void {
    const row = this.opts.indexer.getSession(id);
    if (row) {
      this.opts.bus.emit({
        type: "session_meta",
        session: {
          ...row,
          running: this.isRunning(id),
          compacting: this.isCompacting(id),
        },
      });
    }
  }
}
