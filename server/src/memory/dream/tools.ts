// server/src/memory/dream/tools.ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { applyProposals, dismissProposals, type ApplyDeps } from "./apply.ts";

const idsParams = Type.Object({ ids: Type.Array(Type.String({ description: "proposal ids, e.g. p-ab12" })) });

function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], details: {} };
}

export interface DreamToolDeps { apply: ApplyDeps; maintenanceSessionId: () => string | null; }

export function createDreamTools(deps: DreamToolDeps, sessionId: string): AgentTool<any>[] {
  if (sessionId !== deps.maintenanceSessionId()) return [];
  return [
    {
      name: "ltm_apply_proposals",
      label: "Apply memory proposals",
      description: "Apply the listed memory-maintenance proposal ids (drop/merge/resolve/add). Backs up + audits each.",
      parameters: idsParams,
      execute: async (_id, p) => {
        const { ids } = p as { ids: string[] };
        const res = await applyProposals(deps.apply, ids);
        return jsonResult(res);
      },
    },
    {
      name: "ltm_dismiss_proposals",
      label: "Dismiss memory proposals",
      description: "Dismiss the listed proposal ids so they are not re-proposed.",
      parameters: idsParams,
      execute: async (_id, p) => {
        const { ids } = p as { ids: string[] };
        return jsonResult(dismissProposals(deps.apply, ids));
      },
    },
  ];
}
