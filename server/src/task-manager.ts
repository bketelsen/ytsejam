import path from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  estimateContextTokens,
  uuidv7,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EventBus } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import type { ModelResolver } from "./models.ts";
import { makeApiKeyResolver } from "./pi-auth.ts";
import type { PiAuthStore } from "./pi-auth.ts";
import { composeWorkerPrompt } from "./persona.ts";
import type { PersonaStore } from "./persona.ts";
import { type TaskRow, type TaskStore } from "./tasks.ts";
import { createSessionCwdTools } from "./tools/index.ts";
import {
  appendDevLogLine,
  appendSessionCompactionJsonl,
  buildCompactionEvent,
  buildSurrenderMessage,
  classifyOverflow,
  compactionEnabled,
  computeReserveTokens,
  decideCompaction,
  formatDevLogLine,
  REACTIVE_RETRY_PROMPT,
  runCompactionIfPending,
  serializeJsonRecord,
  toOpenedForCompaction,
  type CompactionEvent,
  type CompactionWiringState,
  type RunCompactionResult,
} from "./compaction.ts";
import { memoryRoot } from "./memory/index.ts";

const SUBAGENT_CWD = "subagent";
const REPORT_MAX = 16_000;

const RETRY_NUDGE =
  "Your previous response was cut off by the model provider before it finished; any tool call in it did NOT run. " +
  "This is often triggered by reproducing long verbatim quotes from sources. " +
  "Continue the task from where you left off, paraphrase source material instead of quoting it at length, " +
  "and redo the interrupted tool call if it is still needed.";

interface ActiveTaskHarness {
  taskId: string;
  parentSessionId: string;
  metadata: JsonlSessionMetadata;
  session: Session<JsonlSessionMetadata>;
  harness: AgentHarness;
  compaction?: CompactionWiringState;
  reactiveRetryPromise?: Promise<AgentMessage>;
  surrenderMessage?: string;
  compactionRunning?: boolean;
}

/** Full text of an assistant message (all text blocks), capped for injection. */
function fullTextOf(message: AgentMessage, cap = REPORT_MAX): string {
  const content = (message as any).content;
  if (typeof content === "string") return content.slice(0, cap);
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("\n")
    .slice(0, cap);
}

export interface DelegateInput {
  parentSessionId: string;
  task: string;
  label: string;
  context?: string;
  model?: string;
}

export interface TaskManagerOptions {
  dataDir: string;
  store: TaskStore;
  indexer: Indexer;
  bus: EventBus;
  persona: PersonaStore;
  authStore: PiAuthStore;
  resolveModel: ModelResolver;
  /** default "provider/modelId" for subagents */
  subagentModel: string;
  /**
   * Tools shared across every subagent — cwd-independent ones only (web
   * search/fetch). The cwd-bearing bash/file/search tools are built per
   * task in run() against the parent session's resolved workdir.
   */
  workerTools: AgentTool<any>[];
  /**
   * Resolve the parent session's working directory so the subagent's
   * bash/file tools land there. Optional; defaults to dataDir.
   */
  resolveParentWorkdir?: (parentSessionId: string) => string;
  /**
   * Optional: load AGENTS.md/CLAUDE.md ancestor-chain context for the
   * subagent's working dir. Returned text is injected into the worker
   * system prompt under "## Project context files".
   */
  loadContextFiles?: (cwd: string) => Promise<string>;
  concurrency: number;
  timeoutMs: number;
  /** inject a completion/failure message into the parent session */
  notifyParent: (parentSessionId: string, text: string) => Promise<void>;
}

/**
 * Runs delegated tasks as in-process subagents with their own JSONL sessions
 * (repo cwd "subagent", invisible to the chat sidebar). Task lifecycle events
 * in TaskStore are the SSOT; the sqlite tasks table and bus events are derived.
 */
export class TaskManager {
  private readonly opts: TaskManagerOptions;
  private readonly env: NodeExecutionEnv;
  private readonly repo: JsonlSessionRepo;
  private readonly queue: string[] = [];
  private readonly active = new Map<string, ActiveTaskHarness>();
  private runningCount = 0;

  constructor(opts: TaskManagerOptions) {
    this.opts = opts;
    this.env = new NodeExecutionEnv({ cwd: opts.dataDir });
    this.repo = new JsonlSessionRepo({
      fs: this.env,
      sessionsRoot: path.join(opts.dataDir, "sessions"),
    });
  }

  // ---- public API ----------------------------------------------------------

  async delegate(input: DelegateInput): Promise<TaskRow> {
    const modelRef = input.model ?? this.opts.subagentModel;
    this.opts.resolveModel(modelRef); // validate early: bad refs fail the tool call, not the run
    const taskId = uuidv7();
    const row = this.record({
      type: "created",
      taskId,
      parentSessionId: input.parentSessionId,
      label: input.label,
      task: input.task,
      context: input.context,
      model: modelRef,
      timestamp: new Date().toISOString(),
    });
    this.queue.push(taskId);
    this.pump();
    return row;
  }

  get(taskId: string): TaskRow | undefined {
    return this.opts.indexer.getTask(taskId);
  }

  /** Cancel a pending or running task. Returns false when unknown or already terminal. */
  async cancel(taskId: string): Promise<boolean> {
    const row = this.opts.store.fold(taskId);
    if (!row || (row.status !== "pending" && row.status !== "running")) return false;
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) this.queue.splice(queued, 1);
    // record cancellation BEFORE aborting so run() sees it and skips fail/notify
    this.record({ type: "cancelled", taskId, timestamp: new Date().toISOString() });
    // fire-and-forget: abort() resolves only when the run settles, which a tool
    // mid-execution can hold for minutes; the cancellation is already durable
    // and cancel-wins makes the eventual outcome a no-op
    const active = this.active.get(taskId);
    if (active) {
      void active.harness.abort().catch((err) => console.error(`abort failed for task ${taskId}`, err));
    }
    return true;
  }

  async getTranscript(taskId: string): Promise<AgentMessage[]> {
    const row = this.opts.store.fold(taskId);
    if (!row?.subagentSessionId) return [];
    const metadata = (await this.repo.list({ cwd: SUBAGENT_CWD })).find(
      (m) => m.id === row.subagentSessionId,
    );
    if (!metadata) return [];
    const session = await this.repo.open(metadata);
    return (await session.buildContext()).messages;
  }

  /** Boot: tasks left pending/running by a previous process become interrupted. */
  async recoverInterrupted(): Promise<void> {
    for (const taskId of this.opts.store.listIds()) {
      const row = this.opts.store.fold(taskId);
      if (!row || (row.status !== "pending" && row.status !== "running")) continue;
      this.record({ type: "interrupted", taskId, timestamp: new Date().toISOString() });
      try {
        await this.opts.notifyParent(
          row.parentSessionId,
          `[Task "${row.label}" interrupted] The server restarted while this task was running. Re-delegate it if it is still needed.`,
        );
      } catch (err) {
        console.error(`failed to notify parent about interrupted task ${taskId}`, err);
      }
    }
  }

  /** Repopulate the (derived) tasks table from the JSONL event files. */
  async rebuildIndex(): Promise<void> {
    for (const taskId of this.opts.store.listIds()) {
      const row = this.opts.store.fold(taskId);
      if (row) this.opts.indexer.upsertTask(row);
    }
  }

  // ---- internals -----------------------------------------------------------

  /** Append an event, refresh the derived row, broadcast it. */
  private record(event: Parameters<TaskStore["append"]>[0]): TaskRow {
    this.opts.store.append(event);
    const row = this.opts.store.fold(event.taskId)!;
    this.opts.indexer.upsertTask(row);
    this.opts.bus.emit({ type: "task", task: row });
    return row;
  }

  private pump(): void {
    while (this.runningCount < this.opts.concurrency && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.runningCount++;
      void this.run(taskId).finally(() => {
        this.runningCount--;
        this.pump();
      });
    }
  }

  private async onHarnessEvent(
    taskId: string,
    event: AgentHarnessEvent,
  ): Promise<void> {
    const active = this.active.get(taskId);
    if (!active?.compaction) return;

    if (event.type === "turn_end") {
      await this.handleCompactionTurnEnd(active, event);
    }

    if (event.type === "session_compact") {
      active.compaction.lastCompactionDetails = event.compactionEntry;
    }

    if (
      event.type === "agent_end" &&
      active.compaction.pendingCompaction &&
      !active.compactionRunning
    ) {
      // Reactive recovery waits for agent_end because pi's phase is idle here;
      // compacting from turn_end would still be mid-loop and can throw "busy".
      // The retry is scheduled with setTimeout(0) to escape the awaited listener
      // settlement before prompt(), avoiding pi's reentrancy guard. Unlike
      // manager.ts, subagents store that retry promise because the retry's
      // assistant message becomes the task's final outcome. compactionRunning
      // blocks re-entry if another event arrives while this orchestration awaits.
      active.compactionRunning = true;
      try {
        const pendingSnapshot = { ...active.compaction.pendingCompaction };
        active.compaction.lastCompactionDetails = undefined;
        const result = await runCompactionIfPending(
          toOpenedForCompaction({
            session: active.session,
            metadata: active.metadata,
            harness: active.harness,
            compaction: active.compaction,
          }),
          this.repo,
        );
        if (result.fired) {
          await this.recordCompactionEvent(
            active,
            result,
            active.compaction.lastCompactionDetails,
          );
          active.compaction.lastCompactionDetails = undefined;
        }

        if (result.surrendered || (pendingSnapshot.trigger === "reactive" && !result.succeeded)) {
          await this.emitCompactionSurrender(active);
          return;
        }

        if (pendingSnapshot.trigger === "reactive" && result.succeeded) {
          active.reactiveRetryPromise = new Promise<AgentMessage>((resolve, reject) => {
            setTimeout(() => {
              if (this.active.get(taskId) !== active) {
                reject(new Error(`reactive retry skipped for inactive task ${taskId}`));
                return;
              }
              active.harness.prompt(REACTIVE_RETRY_PROMPT).then(resolve, reject);
            }, 0);
          });
        }
      } finally {
        active.compactionRunning = false;
      }
    }
  }

  private async handleCompactionTurnEnd(
    active: ActiveTaskHarness,
    event: AgentHarnessEvent,
  ): Promise<void> {
    if (!active.compaction || event.type !== "turn_end") return;
    const msg = event.message as AssistantMessage;
    const model = active.harness.getModel();

    if (msg.stopReason === "error") {
      if (classifyOverflow(msg, model)) {
        if (active.compaction.reactiveRetryAttempted) {
          active.compaction.pendingCompaction = null;
          active.compaction.reactiveRetryAttempted = false;
          await this.emitCompactionSurrender(active);
          return;
        }
        active.compaction.reactiveRetryAttempted = true;
        active.compaction.pendingCompaction = {
          trigger: "reactive",
          reason: "isContextOverflow",
          tokensBefore: 0,
          budget: model.contextWindow - computeReserveTokens(model),
        };
      }
      return;
    }

    active.compaction.reactiveRetryAttempted = false;
    try {
      const messages = (await active.session.buildContext()).messages;
      const decision = decideCompaction(messages, active.harness.getModel());
      if (decision.shouldFire) {
        active.compaction.pendingCompaction = {
          trigger: "proactive",
          reason: decision.reason,
          tokensBefore: decision.tokensBefore,
          budget: decision.budget,
        };
      }
    } catch (err) {
      console.error("[compaction] task-manager turn_end decision failed:", err);
    }
  }

  private async emitCompactionSurrender(active: ActiveTaskHarness): Promise<void> {
    const model = active.harness.getModel();
    let tokens = 0;
    try {
      tokens = estimateContextTokens(
        (await active.session.buildContext()).messages,
      ).tokens;
    } catch {
      // Best-effort diagnostic only.
    }
    const text = buildSurrenderMessage(tokens, model.contextWindow);
    active.surrenderMessage = text;
    console.error(`[compaction] subagent task ${active.taskId} surrender: ${text}`);
  }

  private async recordCompactionEvent(
    active: ActiveTaskHarness,
    result: RunCompactionResult,
    compactionEntry?: any,
  ): Promise<void> {
    if (!active.compaction) return;
    const model = active.harness.getModel();
    const sessionFilePath = active.metadata.path;

    let tokensAfter = compactionEntry?.tokensAfter ?? 0;
    try {
      const messages = (await active.session.buildContext()).messages;
      tokensAfter = estimateContextTokens(messages).tokens;
    } catch {
      // Best-effort diagnostic only; buildCompactionEvent falls back to 0.
    }

    const enrichedEntry = {
      ...(compactionEntry ?? {}),
      sessionId: active.parentSessionId,
      subagentTaskId: active.taskId,
      tokensAfter,
    };
    const devLogPath = `${memoryRoot()}/projects/ytsejam/dev-log.md`;
    const compactionEvent: CompactionEvent = buildCompactionEvent(
      model,
      sessionFilePath,
      result,
      enrichedEntry,
      devLogPath,
    );

    await appendDevLogLine(formatDevLogLine(compactionEvent), devLogPath);
    await appendSessionCompactionJsonl(
      sessionFilePath,
      serializeJsonRecord(compactionEvent),
    );
  }

  private async run(taskId: string): Promise<void> {
    const events = this.opts.store.read(taskId);
    const created = events.find((e) => e.type === "created");
    const row = this.opts.store.fold(taskId);
    if (!created || created.type !== "created" || row?.status !== "pending") return; // cancelled while queued

    let outcome: { type: "completed"; report: string } | { type: "failed"; error: string };
    try {
      const model = this.opts.resolveModel(created.model);
      const session = await this.repo.create({ cwd: SUBAGENT_CWD });
      const metadata = await session.getMetadata();
      await session.appendModelChange(model.provider, model.id);
      this.record({
        type: "started",
        taskId,
        subagentSessionId: metadata.id,
        timestamp: new Date().toISOString(),
      });

      // Resolve the parent's workdir so the subagent's bash/file tools land
      // in the same repo the user is conversing about. Falls back to dataDir
      // when no resolver is configured (preserves test/default behavior).
      const parentWorkdir =
        this.opts.resolveParentWorkdir?.(created.parentSessionId) ?? this.opts.dataDir;

      // The harness uses its own env for non-tool filesystem work (e.g.
      // compaction file reads). Construct a per-task env rooted at the
      // parent's workdir so that work also resolves there, without mutating
      // the shared this.env that the session repo uses for storage.
      const taskEnv = new NodeExecutionEnv({ cwd: parentWorkdir });

      const harness = new AgentHarness({
        env: taskEnv,
        session,
        model,
        tools: [...this.opts.workerTools, ...createSessionCwdTools(parentWorkdir)],
        systemPrompt: async () => {
          const [persona, contextFiles] = await Promise.all([
            this.opts.persona.load(),
            this.opts.loadContextFiles?.(parentWorkdir).catch(() => ""),
          ]);
          return composeWorkerPrompt(persona, {
            dataDir: this.opts.dataDir,
            workdir: parentWorkdir,
            contextFiles,
          });
        },
        getApiKeyAndHeaders: makeApiKeyResolver(this.opts.authStore),
      });
      const active: ActiveTaskHarness = {
        taskId,
        parentSessionId: created.parentSessionId,
        metadata,
        session,
        harness,
      };
      if (compactionEnabled()) {
        active.compaction = {
          pendingCompaction: null,
          reactiveRetryAttempted: false,
        };
      }
      this.active.set(taskId, active);
      harness.subscribe(async (event: AgentHarnessEvent) => {
        try {
          await this.onHarnessEvent(taskId, event);
        } catch (err) {
          console.error("[compaction] task-manager handler swallowed error:", err);
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void harness.abort();
      }, this.opts.timeoutMs);

      let result: AgentMessage;
      try {
        const prompt = created.context ? `${created.task}\n\nContext:\n${created.context}` : created.task;
        result = await harness.prompt(prompt);
        if (active.reactiveRetryPromise) {
          const retry = active.reactiveRetryPromise;
          active.reactiveRetryPromise = undefined;
          result = await retry;
        }
        if (
          !active.surrenderMessage &&
          !timedOut &&
          (result as any).stopReason === "error" &&
          this.opts.store.fold(taskId)?.status !== "cancelled"
        ) {
          // The provider killed generation mid-stream (e.g. a content-safety
          // stop while quoting sources). Answer any tool calls the cut-off
          // response left dangling — the Anthropic API rejects a context with
          // a tool_use that has no tool_result — then retry once with a nudge.
          const content = (result as any).content;
          const dangling = Array.isArray(content) ? content.filter((c: any) => c.type === "toolCall") : [];
          for (const call of dangling) {
            await session.appendMessage({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "This tool call was interrupted before execution and did not run." }],
              isError: true,
              timestamp: Date.now(),
            } as any);
          }
          result = await harness.prompt(RETRY_NUDGE);
          if (active.reactiveRetryPromise) {
            const retry = active.reactiveRetryPromise;
            active.reactiveRetryPromise = undefined;
            result = await retry;
          }
        }
      } finally {
        clearTimeout(timer);
        this.active.delete(taskId);
      }

      const stopReason = (result as any).stopReason;
      const errorMessage = (result as any).errorMessage;
      if (timedOut) {
        outcome = {
          type: "failed",
          error: `timed out after ${Math.round(this.opts.timeoutMs / 1000)}s`,
        };
      } else if (active.surrenderMessage) {
        outcome = { type: "failed", error: active.surrenderMessage };
      } else if (stopReason === "aborted") {
        outcome = { type: "failed", error: "aborted" };
      } else if (errorMessage) {
        outcome = { type: "failed", error: String(errorMessage) };
      } else {
        outcome = { type: "completed", report: fullTextOf(result) || "(empty report)" };
      }
    } catch (err) {
      this.active.delete(taskId);
      outcome = { type: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    // a cancel may have been recorded while we were running — it wins, no notify
    if (this.opts.store.fold(taskId)?.status === "cancelled") return;

    if (outcome.type === "completed") {
      this.record({ type: "completed", taskId, report: outcome.report, timestamp: new Date().toISOString() });
    } else {
      this.record({ type: "failed", taskId, error: outcome.error, timestamp: new Date().toISOString() });
    }

    const text =
      outcome.type === "completed"
        ? `[Task "${created.label}" completed]\n\n${outcome.report}`
        : `[Task "${created.label}" failed] ${outcome.error}`;
    try {
      await this.opts.notifyParent(created.parentSessionId, text);
    } catch (err) {
      console.error(`failed to notify parent for task ${taskId}`, err);
    }
  }
}
