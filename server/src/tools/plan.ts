import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PlanStore, renderPlanSection, type PlanItem } from "../plans.ts";

/**
 * Per-session plan / todo tools. They mutate ONLY the agent's own plan state
 * (benign, like the cog/memory tools) and so are intentionally UNGATED —
 * registered through the session-tool assembly that binds the session id.
 *
 * The plan is re-injected into the system prompt every turn (renderPlanSection),
 * which is what lets it survive context compaction. Tool results echo the
 * rendered plan back so the model sees the new state immediately.
 */

const STATUS_VALUES = ["pending", "in_progress", "done", "cancelled"] as const;

const setParams = Type.Object({
  items: Type.Array(Type.String(), {
    description:
      "The full ordered list of task texts. REPLACES the entire plan; each item is assigned an id (p1, p2, …) and starts as pending.",
  }),
});

const updateOp = Type.Object({
  id: Type.String({ description: "Existing item id, e.g. p2." }),
  status: Type.Optional(
    Type.Union(
      STATUS_VALUES.map((s) => Type.Literal(s)),
      { description: "New status for this item." },
    ),
  ),
  text: Type.Optional(Type.String({ description: "New text for this item." })),
});

const updateParams = Type.Object({
  updates: Type.Optional(
    Type.Array(updateOp, {
      description: "Set status and/or text on existing items by id.",
    }),
  ),
  add: Type.Optional(
    Type.Array(Type.String(), {
      description: "New task texts to append as pending items.",
    }),
  ),
  remove: Type.Optional(
    Type.Array(Type.String(), { description: "Ids of items to remove." }),
  ),
});

function planResult(plan: PlanItem[]) {
  const rendered = renderPlanSection(plan) ?? "(no plan)";
  return { content: [{ type: "text" as const, text: rendered }], details: { plan } };
}

export function createPlanTools(
  store: PlanStore,
  sessionId: string,
): AgentTool<any>[] {
  const planSet: AgentTool<typeof setParams> = {
    name: "plan_set",
    label: "Set plan",
    description:
      "Replace your whole task plan with a new ordered list of item texts. Returns the plan with assigned ids and pending statuses. Use this to lay out the steps for a multi-step task; the plan persists and is re-shown to you every turn so it survives context compaction.",
    parameters: setParams,
    execute: async (_id, params) => {
      return planResult(store.set(sessionId, params.items));
    },
  };

  const planUpdate: AgentTool<typeof updateParams> = {
    name: "plan_update",
    label: "Update plan",
    description:
      "Update your task plan in place: set the status (pending|in_progress|done|cancelled) and/or text of existing items by id, append new items, or remove items. Mark items in_progress when you start them and done when finished. Unknown ids are rejected.",
    parameters: updateParams,
    execute: async (_id, params) => {
      return planResult(store.update(sessionId, params));
    },
  };

  const planRead: AgentTool<any> = {
    name: "plan_read",
    label: "Read plan",
    description: "Return your current task plan with each item's id, text, and status.",
    parameters: Type.Object({}),
    execute: async () => {
      return planResult(store.current(sessionId) ?? []);
    },
  };

  return [planSet, planUpdate, planRead];
}
