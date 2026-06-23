import fs from "node:fs";
import path from "node:path";

/**
 * Per-session agent plan / todo state. The agentic loop is otherwise
 * prompt-driven — planning lives only in the persona prompt and in-context,
 * so a context overflow + compaction can lose the original task. We persist
 * the plan out-of-band (one JSONL file per session, latest snapshot wins) and
 * re-inject a rendered "## Current plan" section into the system prompt every
 * turn (see renderPlanSection + manager.ts). Because the system prompt is
 * rebuilt fresh each turn from this store — never from the conversation branch
 * that compaction rewrites — the plan survives compaction by construction.
 *
 * Storage mirrors workdirs.ts / schedules.ts: `<dataDir>/plans/<sessionId>.jsonl`,
 * one file per session, malformed lines skipped so a corrupt write can't break
 * boot. Each mutation appends a FULL snapshot of the plan (latest-wins), which
 * keeps "replace the whole plan" semantics trivial and rebuild-after-restart
 * clean — no event folding required.
 */

export type PlanStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface PlanItem {
  id: string;
  text: string;
  status: PlanStatus;
}

/** Edits applied by PlanStore.update. All fields optional; applied in order: edits, removals, additions. */
export interface PlanUpdate {
  /** Set status and/or text on existing items by id. Unknown ids are rejected. */
  updates?: { id: string; status?: PlanStatus; text?: string }[];
  /** Append new pending items (texts). New ids never collide with existing ones. */
  add?: string[];
  /** Remove existing items by id. Unknown ids are rejected. */
  remove?: string[];
}

const STATUS_VALUES: readonly PlanStatus[] = [
  "pending",
  "in_progress",
  "done",
  "cancelled",
];

export function isPlanStatus(s: unknown): s is PlanStatus {
  return typeof s === "string" && (STATUS_VALUES as readonly string[]).includes(s);
}

interface PlanSnapshot {
  items: PlanItem[];
  timestamp: string;
}

function isValidItem(x: unknown): x is PlanItem {
  if (!x || typeof x !== "object") return false;
  const it = x as Record<string, unknown>;
  return typeof it.id === "string" && typeof it.text === "string" && isPlanStatus(it.status);
}

/** Numeric suffix of a `pN` id, or 0 if it doesn't match — used to mint fresh ids on add. */
function idNum(id: string): number {
  const m = /^p(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

export class PlanStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get storeDir(): string {
    return this.dir;
  }

  private filePath(sessionId: string): string {
    // sessionId is a uuid in practice; normalize defensively against traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.jsonl`);
  }

  /**
   * The latest persisted plan for a session, or undefined if never set.
   * Malformed lines are skipped so a single corrupt write can't break boot.
   */
  current(sessionId: string): PlanItem[] | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath(sessionId), "utf8");
    } catch {
      return undefined;
    }
    let latest: PlanItem[] | undefined;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const snap = JSON.parse(line) as PlanSnapshot;
        if (Array.isArray(snap.items) && snap.items.every(isValidItem)) {
          latest = snap.items;
        }
      } catch {
        // tolerate corrupt lines
      }
    }
    return latest;
  }

  private persist(sessionId: string, items: PlanItem[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const snap: PlanSnapshot = { items, timestamp: new Date().toISOString() };
    fs.appendFileSync(this.filePath(sessionId), `${JSON.stringify(snap)}\n`);
  }

  /**
   * Replace the whole plan with a fresh ordered list of item texts. Ids are
   * reassigned p1..pN and every item starts `pending`. Returns the new plan.
   */
  set(sessionId: string, texts: string[]): PlanItem[] {
    const items: PlanItem[] = texts.map((t, i) => ({
      id: `p${i + 1}`,
      text: String(t),
      status: "pending",
    }));
    this.persist(sessionId, items);
    return items;
  }

  /**
   * Apply status/text edits, additions, and removals to the current plan.
   * Validates ALL referenced ids and statuses before mutating, so a bad op
   * rejects atomically (no partial write). Returns the new plan.
   */
  update(sessionId: string, ops: PlanUpdate): PlanItem[] {
    const items = (this.current(sessionId) ?? []).map((it) => ({ ...it }));
    const byId = new Map(items.map((it) => [it.id, it]));

    // Validate first — reject unknown ids / bad statuses before any mutation.
    const unknown = new Set<string>();
    for (const u of ops.updates ?? []) if (!byId.has(u.id)) unknown.add(u.id);
    for (const id of ops.remove ?? []) if (!byId.has(id)) unknown.add(id);
    if (unknown.size) {
      throw new Error(`unknown plan item id(s): ${[...unknown].join(", ")}`);
    }
    for (const u of ops.updates ?? []) {
      if (u.status !== undefined && !isPlanStatus(u.status)) {
        throw new Error(
          `invalid status "${u.status}" for ${u.id} (expected ${STATUS_VALUES.join("|")})`,
        );
      }
    }

    // Edits.
    for (const u of ops.updates ?? []) {
      const it = byId.get(u.id)!;
      if (u.status !== undefined) it.status = u.status;
      if (u.text !== undefined) it.text = String(u.text);
    }

    // Removals.
    const removeSet = new Set(ops.remove ?? []);
    const next = items.filter((it) => !removeSet.has(it.id));

    // Additions — mint ids above the current max so they never collide.
    let maxNum = next.reduce((m, it) => Math.max(m, idNum(it.id)), 0);
    for (const t of ops.add ?? []) {
      next.push({ id: `p${++maxNum}`, text: String(t), status: "pending" });
    }

    this.persist(sessionId, next);
    return next;
  }
}

const STATUS_MARK: Record<PlanStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  cancelled: "[-]",
};

const MAX_RENDERED_ITEMS = 50;
const MAX_ITEM_TEXT = 200;

/**
 * Render a compact, bounded "## Current plan" system-prompt section, or
 * undefined when there is no plan (so the caller injects nothing). Statuses
 * render as checkbox marks; item text is clamped and the list is capped so a
 * runaway plan can't blow up the prompt.
 */
export function renderPlanSection(items?: PlanItem[]): string | undefined {
  if (!items || items.length === 0) return undefined;
  const shown = items.slice(0, MAX_RENDERED_ITEMS);
  const lines = shown.map((it) => {
    const mark = STATUS_MARK[it.status] ?? "[ ]";
    const text =
      it.text.length > MAX_ITEM_TEXT ? `${it.text.slice(0, MAX_ITEM_TEXT - 1)}…` : it.text;
    return `- ${mark} (${it.id}) ${text}`;
  });
  if (items.length > MAX_RENDERED_ITEMS) {
    lines.push(`- …and ${items.length - MAX_RENDERED_ITEMS} more`);
  }
  return (
    "## Current plan\n\n" +
    "Your persisted task plan for this session. It survives context compaction — " +
    "treat it as the source of truth for what you're doing and keep it current with " +
    "plan_update as you make progress. Statuses: [ ] pending, [~] in progress, " +
    "[x] done, [-] cancelled.\n\n" +
    lines.join("\n")
  );
}
