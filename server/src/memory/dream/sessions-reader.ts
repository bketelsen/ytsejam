// server/src/memory/dream/sessions-reader.ts
import fs from "node:fs";
import { listSessionFiles, readSessionFile } from "ltm";

export function makeGatherUserTurns(sessionsDir: string) {
  return (cursorMs: number): { turns: { sessionId: string; entryId: string; text: string }[]; newCursorMs: number } => {
    const turns: { sessionId: string; entryId: string; text: string }[] = [];
    let newCursor = cursorMs;
    let files: string[] = [];
    try { files = listSessionFiles(sessionsDir); } catch { return { turns, newCursorMs: cursorMs }; }
    for (const file of files) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtimeMs <= cursorMs) continue;
      newCursor = Math.max(newCursor, mtimeMs);
      try {
        const parsed = readSessionFile(file);
        for (const t of parsed.turns) {
          if (t.role !== "user" || !t.text.trim()) continue;
          turns.push({ sessionId: t.sessionId, entryId: t.entryId, text: t.text });
        }
      } catch { /* skip unreadable */ }
    }
    return { turns, newCursorMs: newCursor };
  };
}
