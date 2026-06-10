import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CogClient } from "../cog/client.ts";
import { truncate } from "./shell.ts";

/**
 * Agent tools over the cogmemory daemon. Names and shapes follow the cog
 * skill vocabulary (cogmemory docs/SKILL-REWRITES.md) so skill playbooks
 * port verbatim. The role is injected here — the model never supplies it.
 */

const PATH_RULE =
  "The path is the domain's directory *path* from the Domains table (e.g. projects/chapterhouse/notes.md), never the domain id — the daemon rejects id-as-path writes.";

// Consolidated envelope RPCs reachable through cog_rpc. File operations are
// deliberately excluded — they go through their dedicated tools.
const RPC_METHODS = [
  "session_brief",
  "domain_summary",
  "housekeeping_scan",
  "open_actions",
  "recent_observations",
  "glacier_index_compute",
  "wiki_index_compute",
  "link_index_compute",
  "link_audit",
  "entity_audit",
  "cluster_check",
  "scenario_check",
  "domains.list",
  "domains.get",
  "l0index",
  "stats",
  "git",
  "health",
] as const;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text: truncate(text) }], details: {} };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

export function createCogTools(client: CogClient, role: string): AgentTool<any>[] {
  const call = (method: string, params: Record<string, unknown>) =>
    client.call<Record<string, unknown>>(method, { role, ...params });

  const readParams = Type.Object({
    path: Type.String({ description: "memory-root-relative path, e.g. personal/observations.md" }),
    section: Type.Optional(Type.String({ description: "markdown heading to read just that section" })),
    start: Type.Optional(Type.Number({ description: "1-based start line" })),
    end: Type.Optional(Type.Number({ description: "1-based end line" })),
  });

  const writeParams = Type.Object({
    path: Type.String(),
    content: Type.String(),
  });

  const appendParams = Type.Object({
    path: Type.String(),
    text: Type.String(),
    section: Type.Optional(Type.String({ description: "append under this markdown heading" })),
  });

  const patchParams = Type.Object({
    path: Type.String(),
    old_text: Type.String({ description: "exact text to replace" }),
    new_text: Type.String(),
  });

  const outlineParams = Type.Object({ path: Type.String() });
  const searchParams = Type.Object({ query: Type.String() });
  const listParams = Type.Object({});
  const moveParams = Type.Object({ from: Type.String(), to: Type.String() });

  const rpcParams = Type.Object({
    method: Type.Union(RPC_METHODS.map((m) => Type.Literal(m))),
    params: Type.Optional(
      Type.Record(Type.String(), Type.Any(), {
        description: "method-specific parameters (role is injected automatically)",
      }),
    ),
  });

  return [
    {
      name: "cog_read",
      label: "Read memory file",
      description:
        "Read a file from cog memory. Optionally a single section or line range — prefer sections over whole files.",
      parameters: readParams,
      execute: async (_id, p) => {
        const r = await call("read", p as Record<string, unknown>);
        return textResult(String(r.content ?? ""));
      },
    },
    {
      name: "cog_write",
      label: "Write memory file",
      description: `Create or overwrite a cog memory file. ${PATH_RULE}`,
      parameters: writeParams,
      execute: async (_id, p) => {
        const r = await call("write", p as Record<string, unknown>);
        return jsonResult(r);
      },
    },
    {
      name: "cog_append",
      label: "Append to memory file",
      description: `Append text to a cog memory file (observations, action items). ${PATH_RULE}`,
      parameters: appendParams,
      execute: async (_id, p) => {
        const r = await call("append", p as Record<string, unknown>);
        return jsonResult(r);
      },
    },
    {
      name: "cog_patch",
      label: "Patch memory file",
      description: `Replace an exact text occurrence in a cog memory file. ${PATH_RULE}`,
      parameters: patchParams,
      execute: async (_id, p) => {
        const r = await call("patch", p as Record<string, unknown>);
        return jsonResult(r);
      },
    },
    {
      name: "cog_outline",
      label: "Outline memory file",
      description: "Get a memory file's heading outline + L0 header without reading the body.",
      parameters: outlineParams,
      execute: async (_id, p) => {
        const r = await call("outline", p as Record<string, unknown>);
        return jsonResult(r);
      },
    },
    {
      name: "cog_search",
      label: "Search memory",
      description: "Full-text search across all cog memory files.",
      parameters: searchParams,
      execute: async (_id, p) => {
        const r = await call("search", p as Record<string, unknown>);
        return jsonResult(r);
      },
    },
    {
      name: "cog_list",
      label: "List memory files",
      description: "List all files in cog memory.",
      parameters: listParams,
      execute: async () => {
        const r = await call("list", {});
        return jsonResult(r);
      },
    },
    {
      name: "cog_move",
      label: "Move memory file",
      description: "Move/rename a cog memory file (e.g. archiving into glacier/).",
      parameters: moveParams,
      execute: async (_id, p) => {
        const r = await call("move", p as Record<string, unknown>);
        return jsonResult(r);
      },
    },
    {
      name: "cog_rpc",
      label: "Cog envelope RPC",
      description:
        "Call a consolidated cogmemory RPC (session_brief, domain_summary, housekeeping_scan, audits, index computations...). Returns the JSON envelope. Used mainly by skill playbooks.",
      parameters: rpcParams,
      execute: async (_id, p) => {
        const { method, params } = p as { method: string; params?: Record<string, unknown> };
        const r = await call(method, params ?? {});
        return jsonResult(r);
      },
    },
  ];
}
