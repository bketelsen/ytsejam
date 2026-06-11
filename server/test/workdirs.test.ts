import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerEvent } from "../src/events.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { resolveWorkdir, WorkdirStore } from "../src/workdirs.ts";
import { createBashTool } from "../src/tools/shell.ts";
import { fauxAssistantMessage, fauxToolCall, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
beforeEach(() => {
  faux = setupFaux();
});
afterEach(() => {
  faux.unregister();
});

describe("WorkdirStore", () => {
  test("returns undefined when nothing set; latest event wins after multiple writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    const store = new WorkdirStore(join(dir, "workdirs"));
    expect(store.current("sess-1")).toBeUndefined();
    store.append("sess-1", { dir: "/tmp/a", timestamp: "2026-06-11T00:00:00Z" });
    expect(store.current("sess-1")).toBe("/tmp/a");
    store.append("sess-1", { dir: "/tmp/b", timestamp: "2026-06-11T01:00:00Z" });
    expect(store.current("sess-1")).toBe("/tmp/b");
    // independent per session
    expect(store.current("sess-2")).toBeUndefined();
  });

  test("skips malformed lines so a single corrupt write can't break boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    mkdirSync(join(dir, "workdirs"), { recursive: true });
    const file = join(dir, "workdirs", "sess-1.jsonl");
    writeFileSync(file, '{"dir":"/tmp/a","timestamp":"x"}\nnot json\n{"dir":"/tmp/b","timestamp":"y"}\n');
    const store = new WorkdirStore(join(dir, "workdirs"));
    expect(store.current("sess-1")).toBe("/tmp/b");
  });
});

describe("resolveWorkdir", () => {
  test("defaults to dataDir when unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    const store = new WorkdirStore(join(dir, "workdirs"));
    expect(resolveWorkdir(store, "any", "/data")).toBe("/data");
  });

  test("returns set workdir when it exists and is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    const store = new WorkdirStore(join(dir, "workdirs"));
    const target = mkdtempSync(join(tmpdir(), "wd-target-"));
    store.append("sess-1", { dir: target, timestamp: new Date().toISOString() });
    expect(resolveWorkdir(store, "sess-1", "/data")).toBe(target);
  });

  test("falls back to dataDir when the set workdir no longer exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    const store = new WorkdirStore(join(dir, "workdirs"));
    const target = mkdtempSync(join(tmpdir(), "wd-target-"));
    store.append("sess-1", { dir: target, timestamp: new Date().toISOString() });
    rmSync(target, { recursive: true, force: true });
    expect(resolveWorkdir(store, "sess-1", "/data")).toBe("/data");
  });

  test("falls back to dataDir when the set path is a file, not a dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    const store = new WorkdirStore(join(dir, "workdirs"));
    const target = mkdtempSync(join(tmpdir(), "wd-target-"));
    const file = join(target, "f");
    writeFileSync(file, "x");
    store.append("sess-1", { dir: file, timestamp: new Date().toISOString() });
    expect(resolveWorkdir(store, "sess-1", "/data")).toBe("/data");
  });
});

describe("AgentManager + per-session workdir", () => {
  test(
    "each session's bash tool resolves against its own resolved workdir; default is dataDir",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "wd-data-"));
      const wdRoot = mkdtempSync(join(tmpdir(), "wd-root-"));
      const store = new WorkdirStore(join(wdRoot, "workdirs"));
      // session B will have its workdir set to a custom dir
      const targetB = mkdtempSync(join(tmpdir(), "wd-target-B-"));

      const { manager } = makeManager(faux, {
        // override the dataDir AgentManager owns so the assertion has a known shape
        dataDir,
        resolveWorkdir: (sessionId) => resolveWorkdir(store, sessionId, dataDir),
      });

      // capture the bash tool used by each session by inspecting tool inputs/outputs
      // via the faux model: it can issue a tool_call, we look at where pwd ran
      const seen: Record<string, string> = {};
      faux.setResponses([
        // session A: bash -> pwd
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })]),
        fauxAssistantMessage("done A"),
        // session B: bash -> pwd
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })]),
        fauxAssistantMessage("done B"),
      ]);

      const a = await manager.createSession();
      await manager.sendMessage(a.id, "what's pwd");
      await manager.waitForIdle(a.id);
      const msgsA = await manager.getMessages(a.id);
      const trA = msgsA.find((m: any) => m.role === "toolResult") as any;
      seen.a = JSON.stringify(trA?.content);

      // set workdir for session B before it is opened
      const b = await manager.createSession();
      store.append(b.id, { dir: targetB, timestamp: new Date().toISOString() });
      await manager.applyWorkdirChange(b.id);

      await manager.sendMessage(b.id, "what's pwd");
      await manager.waitForIdle(b.id);
      const msgsB = await manager.getMessages(b.id);
      const trB = msgsB.find((m: any) => m.role === "toolResult") as any;
      seen.b = JSON.stringify(trB?.content);

      expect(seen.a).toContain(dataDir);
      expect(seen.b).toContain(targetB);
      // sanity: B's pwd is NOT the dataDir (workdir isolation)
      expect(seen.b).not.toContain(`exit code: 0\n${dataDir}\n`);
    },
  );

  test(
    "changing a workdir for an already-open session rebuilds the cwd tools",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "wd-data-"));
      const wdRoot = mkdtempSync(join(tmpdir(), "wd-root-"));
      const store = new WorkdirStore(join(wdRoot, "workdirs"));
      const target1 = mkdtempSync(join(tmpdir(), "wd-target-1-"));
      const target2 = mkdtempSync(join(tmpdir(), "wd-target-2-"));

      const { manager } = makeManager(faux, {
        dataDir,
        resolveWorkdir: (sessionId) => resolveWorkdir(store, sessionId, dataDir),
      });

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })]),
        fauxAssistantMessage("done 1"),
        fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })]),
        fauxAssistantMessage("done 2"),
      ]);

      const a = await manager.createSession();
      store.append(a.id, { dir: target1, timestamp: new Date().toISOString() });
      await manager.applyWorkdirChange(a.id);
      await manager.sendMessage(a.id, "pwd?");
      await manager.waitForIdle(a.id);

      // change workdir for the SAME open session
      store.append(a.id, { dir: target2, timestamp: new Date().toISOString() });
      await manager.applyWorkdirChange(a.id);
      await manager.sendMessage(a.id, "pwd again?");
      await manager.waitForIdle(a.id);

      const msgs = await manager.getMessages(a.id);
      const toolResults = msgs.filter((m: any) => m.role === "toolResult") as any[];
      expect(toolResults).toHaveLength(2);
      expect(JSON.stringify(toolResults[0].content)).toContain(target1);
      expect(JSON.stringify(toolResults[1].content)).toContain(target2);
    },
  );
});
