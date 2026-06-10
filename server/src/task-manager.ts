import path from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  uuidv7,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { EventBus } from "./events.ts";
import type { Indexer } from "./indexer.ts";
import type { ModelResolver } from "./models.ts";
import { resolveApiKey } from "./pi-auth.ts";
import type { PiAuthStore } from "./pi-auth.ts";
import { composeWorkerPrompt } from "./persona.ts";
import type { PersonaStore } from "./persona.ts";
import { type TaskRow, type TaskStore } from "./tasks.ts";

const SUBAGENT_CWD = "subagent";
const REPORT_MAX = 16_000;

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
  workerTools: AgentTool<any>[];
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
  private readonly active = new Map<string, AgentHarness>();
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
    const harness = this.active.get(taskId);
    if (harness) {
      void harness.abort().catch((err) => console.error(`abort failed for task ${taskId}`, err));
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

      const harness = new AgentHarness({
        env: this.env,
        session,
        model,
        tools: this.opts.workerTools,
        systemPrompt: async () =>
          composeWorkerPrompt(await this.opts.persona.load(), { dataDir: this.opts.dataDir }),
        getApiKeyAndHeaders: async (m: Model<any>) => {
          const apiKey = await resolveApiKey(m.provider, this.opts.authStore);
          return apiKey ? { apiKey } : undefined;
        },
      });
      this.active.set(taskId, harness);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void harness.abort();
      }, this.opts.timeoutMs);

      let result: AgentMessage;
      try {
        const prompt = created.context ? `${created.task}\n\nContext:\n${created.context}` : created.task;
        result = await harness.prompt(prompt);
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
