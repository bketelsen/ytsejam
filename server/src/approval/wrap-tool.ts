import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ApprovalDecision, ApprovalCoordinator } from "./coordinator.ts";
import { canToolRequireApproval, isGatedTool } from "./gated-tools.ts";
import type { ApprovalMode } from "./types.ts";

/**
 * Per-turn context that the wrapper consults to decide gate vs. pass-through.
 * The manager sets this for the duration of a turn; the wrapper reads it.
 */
export interface ApprovalContext {
  sessionId: string;
  /** Resolved per turn: override > session toggle. */
  effectiveMode: () => ApprovalMode;
  coordinator: ApprovalCoordinator;
}

type DenialDecision = Exclude<ApprovalDecision, "approve">;
export interface ApprovalDenialDetails {
  approval: DenialDecision;
}

/**
 * Wrap a tool's execute fn. In YOLO mode (or for ungated tools) calls through
 * directly. In ASK mode for gated tools, opens an approval and either calls
 * through or returns a synthetic denial.
 */
export function wrapToolWithApproval<TParameters extends TSchema, TDetails = any>(
  tool: AgentTool<TParameters, TDetails>,
  ctx: ApprovalContext,
): AgentTool<TParameters, TDetails | ApprovalDenialDetails> {
  if (!canToolRequireApproval(tool.name)) return tool;

  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (
      toolCallId: string,
      params: Static<TParameters>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails | ApprovalDenialDetails>,
    ): Promise<AgentToolResult<TDetails | ApprovalDenialDetails>> => {
      if (!isGatedTool(tool.name, params) || ctx.effectiveMode() === "yolo") {
        return originalExecute(toolCallId, params, signal, onUpdate);
      }

      const decision = await ctx.coordinator.request({
        sessionId: ctx.sessionId,
        toolName: tool.name,
        // label is REQUIRED on AgentTool; fallback is defensive against ill-typed callers.
        toolLabel: tool.label ?? tool.name,
        params,
      });
      if (decision === "approve") {
        return originalExecute(toolCallId, params, signal, onUpdate);
      }

      const reason = decision === "timeout"
        ? "User denied this tool call (timeout)."
        : "User denied this tool call.";
      return {
        content: [{ type: "text" as const, text: reason }],
        details: { approval: decision },
      };
    },
  };
}
