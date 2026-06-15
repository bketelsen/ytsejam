import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as memory from "../memory/index.ts";
import type {
  DomainSummaryParams,
  GitParams,
  InitCanonicalFileParams,
  SkillWriteParams,
} from "../memory/index.ts";
import { parseObservationLine } from "../memory/bridge/ltm-observer.ts";
import { recall } from "../memory/recall.ts";
import { truncate } from "./shell.ts";

/**
 * Agent tools over the in-process memory module. Names and shapes follow the
 * cog skill vocabulary (cogmemory docs/SKILL-REWRITES.md) so skill playbooks
 * port verbatim.
 */

const PATH_RULE =
  "The path is the domain's directory *path* from the Domains table (e.g. projects/chapterhouse/notes.md), never the domain id — the memory store rejects id-as-path writes.";

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
  "init_canonical_file",
  "skill_write",
  "reconcile_now",
] as const;

type RpcMethod = (typeof RPC_METHODS)[number];
type RpcParams = Record<string, unknown> & Partial<DomainSummaryParams> & Partial<GitParams>;

const rpcDispatch: Record<RpcMethod, (params: RpcParams) => Promise<unknown>> = {
  "session_brief": (params) => memory.sessionBrief(params),
  "domain_summary": (params) => memory.domainSummary(params as DomainSummaryParams),
  "housekeeping_scan": (params) => memory.housekeepingScan(params),
  "open_actions": (params) => memory.openActions(params),
  "recent_observations": (params) => memory.recentObservations(params),
  "glacier_index_compute": () => memory.glacierIndexCompute(),
  "wiki_index_compute": () => memory.wikiIndexCompute(),
  "link_index_compute": (params) => memory.linkIndexCompute(params),
  "link_audit": (params) => memory.linkAudit(params),
  "entity_audit": (params) => memory.entityAudit(params),
  "cluster_check": (params) => memory.clusterCheck(params),
  "scenario_check": (params) => memory.scenarioCheck(params),
  "domains.list": async (params) => {
    rejectParams("domains.list", params, []);
    return { domains: new memory.Controller(memory.memoryRoot()).list() };
  },
  "domains.get": async (params) => {
    rejectParams("domains.get", params, ["id"]);
    const id = params.id;
    if (typeof id !== "string" || id === "") throw new Error("domains.get: id is required");
    return { domain: new memory.Controller(memory.memoryRoot()).get(id) };
  },
  "l0index": (params) => memory.l0index(params),
  "stats": (params) => {
    rejectParams("stats", params, ["prefix"]);
    const prefix = params.prefix;
    if (prefix !== undefined && typeof prefix !== "string") throw new Error("stats: prefix must be a string");
    return memory.stats(prefix);
  },
  "git": (params) => memory.git(params as GitParams),
  "health": (params) => {
    rejectParams("health", params, []);
    return memory.health();
  },
  "init_canonical_file": (params) =>
    memory.initCanonicalFile(params as unknown as InitCanonicalFileParams),
  "skill_write": (params) =>
    memory.skillWrite(params as unknown as SkillWriteParams),
  "reconcile_now": (params) => {
    rejectParams("reconcile_now", params, ["force"]);
    const force = params.force;
    if (force !== undefined && typeof force !== "boolean") {
      throw new Error("reconcile_now: force must be a boolean");
    }
    return memory.reconcileNow(force !== undefined ? { force } : {});
  },
};

// rejectParams: tool-layer unknown-key guard for methods whose memory function
// does not carry its own validateParams (Controller methods + scalar/no-arg calls).
// The other methods route to memory.* functions that already enforce D12
// strict-params via their own validateParams call.
function rejectParams(method: string, params: RpcParams, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const key = Object.keys(params).find((k) => !allowedSet.has(k));
  if (key) throw new Error(`${method}: invalid params: unknown param key: ${key}`);
}


function textResult(text: string) {
  return { content: [{ type: "text" as const, text: truncate(text) }], details: {} };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

export function createCogTools(): AgentTool<any>[] {
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
        description: "method-specific parameters",
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
        const { path, section, start, end } = p as { path: string; section?: string; start?: number; end?: number };
        const r = await memory.read(path, { section, start, end });
        return textResult(String(r?.content ?? ""));
      },
    },
    {
      name: "cog_write",
      label: "Write memory file",
      description: `Create or overwrite a cog memory file. ${PATH_RULE}`,
      parameters: writeParams,
      execute: async (_id, p) => {
        const { path, content } = p as { path: string; content: string };
        const r = await memory.write(path, content);
        return jsonResult(r);
      },
    },
    {
      name: "cog_append",
      label: "Append to memory file",
      description: `Append text to a cog memory file (observations, action items). ${PATH_RULE}`,
      parameters: appendParams,
      execute: async (_id, p) => {
        const { path, text, section } = p as { path: string; text: string; section?: string };

        // Route observations.md writes through recordObservation so the
        // LTM bridge mirrors live writes. Non-observation files and section-
        // targeted writes use the unchanged memory.append path.
        if (path.endsWith("/observations.md") && !section) {
          const domainPath = path.slice(0, -"/observations.md".length);
          const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

          // Validate ALL lines BEFORE any write, so a mid-batch malformed
          // line aborts without partial commits across cog SSOT + LTM.
          // (Preserves the prior memory.append atomicity guarantee on
          // multi-line input — see issue notes for Task 5.)
          const parsedAll: ReturnType<typeof parseObservationLine>[] = [];
          for (const line of lines) {
            const parsed = parseObservationLine(line);
            if (!parsed) {
              throw new Error(
                `cog_append: malformed observation line for ${path}: ${JSON.stringify(line)}`,
              );
            }
            parsedAll.push(parsed);
          }

          for (const parsed of parsedAll) {
            await memory.recordObservation({
              domainPath,
              text: parsed!.text,
              tags: parsed!.tags,
              timestamp: new Date(parsed!.timestamp),
            });
          }
          return jsonResult({ ok: true });
        }

        const r = await memory.append(path, text, { section });
        return jsonResult(r);
      },
    },
    {
      name: "cog_patch",
      label: "Patch memory file",
      description: `Replace an exact text occurrence in a cog memory file. ${PATH_RULE}`,
      parameters: patchParams,
      execute: async (_id, p) => {
        const { path, old_text, new_text } = p as { path: string; old_text: string; new_text: string };
        const r = await memory.patch(path, old_text, new_text);
        return jsonResult(r);
      },
    },
    {
      name: "cog_outline",
      label: "Outline memory file",
      description: "Get a memory file's heading outline + L0 header without reading the body.",
      parameters: outlineParams,
      execute: async (_id, p) => {
        const { path } = p as { path: string };
        const r = await memory.outline(path);
        return jsonResult(r);
      },
    },
    {
      name: "cog_search",
      label: "Search memory",
      description: "Full-text search across all cog memory files.",
      parameters: searchParams,
      execute: async (_id, p) => {
        const { query } = p as { query: string };
        const r = await memory.search(query);
        return jsonResult(r);
      },
    },
    {
      name: "recall",
      label: "Recall across cog + LTM",
      description: "Unified recall across cog memory (full-text search) and long-term memory (semantic retrieval). Returns interleaved hits from both substrates, deduped by origin (cog wins on collision). Each hit is labeled with its source ('cog' or 'ltm'). Use when looking up what you know about a topic — broader and smarter than cog_search alone, especially for past conversations consolidated into LTM.",
      parameters: searchParams,
      execute: async (_id, p) => {
        const { query } = p as { query: string };
        const r = await recall(query);
        return jsonResult(r);
      },
    },
    {
      name: "cog_list",
      label: "List memory files",
      description: "List all files in cog memory.",
      parameters: listParams,
      execute: async () => {
        const r = await memory.list();
        return jsonResult(r);
      },
    },
    {
      name: "cog_move",
      label: "Move memory file",
      description: "Move/rename a cog memory file (e.g. archiving into glacier/).",
      parameters: moveParams,
      execute: async (_id, p) => {
        const { from, to } = p as { from: string; to: string };
        const r = await memory.move(from, to);
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
        const { method, params } = p as { method: string; params?: RpcParams };
        if (!isRpcMethod(method)) throw new Error(`unknown cog_rpc method: ${method}`);
        const r = await rpcDispatch[method](params ?? {});
        return jsonResult(r);
      },
    },
  ];
}

function isRpcMethod(method: string): method is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(method);
}
