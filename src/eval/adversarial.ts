/**
 * Adversarial corpus builder (PLAN.md Task 3.1): scripted sessions in pi-v3
 * format for scenarios designed to break belief dynamics — overlapping
 * preference objects, preference-vs-directive conflicts, contradiction
 * revival, fact-free high-frequency entities, salience cliffs. Unlike
 * synthetic.ts (statistical corpus), every turn here is hand-placed.
 */

import fs from "node:fs";
import path from "node:path";

export interface ScriptedTurn {
  text: string;
  role?: "user" | "assistant";
  /** Days after the session start for this turn. Default: turn index. */
  dayOffset?: number;
}

export interface ScriptedSessionOptions {
  dir: string;
  sessionId: string;
  startDate?: string;
  turns: ScriptedTurn[];
}

/** Write one scripted session; returns the file path and the entry ids. */
export function writeScriptedSession(opts: ScriptedSessionOptions): {
  filePath: string;
  entryIds: string[];
} {
  const startMs = Date.parse(opts.startDate ?? "2026-04-01T09:00:00.000Z");
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: opts.sessionId,
      timestamp: new Date(startMs).toISOString(),
      cwd: "/home/user",
    }),
  ];
  const entryIds: string[] = [];
  let parentId: string | null = null;
  opts.turns.forEach((turn, i) => {
    const id = `t${String(i).padStart(7, "0")}`;
    const at = startMs + (turn.dayOffset ?? i / 96) * 24 * 60 * 60 * 1000;
    const role = turn.role ?? "user";
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date(at).toISOString(),
        message:
          role === "user"
            ? { role, content: turn.text, timestamp: at }
            : { role, content: [{ type: "text", text: turn.text }], model: "scripted", stopReason: "stop", timestamp: at },
      }),
    );
    parentId = id;
    entryIds.push(id);
  });
  fs.mkdirSync(opts.dir, { recursive: true });
  const filePath = path.join(opts.dir, `${opts.sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return { filePath, entryIds };
}
