import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TaskManager } from "../task-manager.ts";

const delegateParams = Type.Object({
  task: Type.String({
    description:
      "Complete, self-contained instructions for the subagent. It cannot see this conversation — include everything it needs.",
  }),
  label: Type.String({ description: "Short human-readable label (3-6 words) shown in the UI" }),
  context: Type.Optional(Type.String({ description: "Extra background the subagent may need" })),
  model: Type.Optional(Type.String({ description: 'Override model as "provider/modelId" (optional)' })),
});

const taskIdParams = Type.Object({ taskId: Type.String() });

function elapsed(row: { startedAt: string | null }): string {
  if (!row.startedAt) return "not started";
  return `${Math.round((Date.now() - new Date(row.startedAt).getTime()) / 1000)}s`;
}

/**
 * Tools bound to one chat session (the parent). getTaskManager is late-bound
 * because the TaskManager is constructed after the AgentManager at boot.
 */
export function createDelegationTools(
  getTaskManager: () => TaskManager,
  sessionId: string,
): AgentTool<any>[] {
  const delegate: AgentTool<typeof delegateParams> = {
    name: "delegate",
    label: "Delegate to subagent",
    description:
      "Start a background subagent to work on a task asynchronously. Returns immediately with a task id; you will receive a message in this conversation when the task completes or fails. Use it for research or multi-step work that would block the conversation; do NOT use it for trivial single-step actions. Subagents cannot delegate further.",
    parameters: delegateParams,
    execute: async (_id, params) => {
      const row = await getTaskManager().delegate({
        parentSessionId: sessionId,
        task: params.task,
        label: params.label,
        context: params.context,
        model: params.model,
      });
      return {
        content: [
          {
            type: "text",
            text: `Delegated task ${row.id} ("${row.label}"). It runs in the background — continue helping the user; you'll get a [Task ...] message here when it finishes.`,
          },
        ],
        details: { taskId: row.id, label: row.label },
      };
    },
  };

  const checkTask: AgentTool<typeof taskIdParams> = {
    name: "check_task",
    label: "Check task status",
    description: "Check the status of a delegated background task by id.",
    parameters: taskIdParams,
    execute: async (_id, params) => {
      const row = getTaskManager().get(params.taskId);
      if (!row) throw new Error(`Unknown task: ${params.taskId}`);
      const summary = row.resultSummary ? `\nresult: ${row.resultSummary}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Task ${row.id} ("${row.label}"): ${row.status} (elapsed: ${elapsed(row)})${summary}`,
          },
        ],
        details: { taskId: row.id, status: row.status },
      };
    },
  };

  const cancelTask: AgentTool<typeof taskIdParams> = {
    name: "cancel_task",
    label: "Cancel task",
    description: "Cancel a pending or running delegated task by id.",
    parameters: taskIdParams,
    execute: async (_id, params) => {
      const ok = await getTaskManager().cancel(params.taskId);
      return {
        content: [
          { type: "text", text: ok ? `Cancelled task ${params.taskId}.` : `Task ${params.taskId} is not cancellable (unknown or already finished).` },
        ],
        details: { cancelled: ok },
      };
    },
  };

  return [delegate, checkTask, cancelTask];
}
