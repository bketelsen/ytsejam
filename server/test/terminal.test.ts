import { serve } from "@hono/node-server";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { createApp } from "../src/server.ts";
import { createTerminalSession, type TerminalSession } from "../src/terminal.ts";
import { makeManager, setupFaux } from "./helpers.ts";
import { PersonaStore } from "../src/persona.ts";

function waitForExit(run: (onExit: (code: number | undefined) => void) => TerminalSession) {
  let session: TerminalSession | null = null;
  const done = new Promise<number | undefined>((resolve) => {
    session = run(resolve);
  });
  return { session: session!, done };
}

describe("terminal session", () => {
  test("spawns a shell command and forwards output and exit", async () => {
    let output = "";
    const { done } = waitForExit((onExit) =>
      createTerminalSession({
        shell: "sh",
        args: ["-lc", "printf hi"],
        onData: (data) => {
          output += data;
        },
        onExit,
      }),
    );

    await expect(done).resolves.toBe(0);
    expect(output).toContain("hi");
  });

  test("defaults to the user's home directory", async () => {
    let output = "";
    const { done } = waitForExit((onExit) =>
      createTerminalSession({
        shell: "sh",
        args: ["-lc", "pwd"],
        onData: (data) => {
          output += data;
        },
        onExit,
      }),
    );

    await expect(done).resolves.toBe(0);
    expect(output.replace(/\r/g, "")).toContain(os.homedir());
  });

  test("kill terminates the child process", async () => {
    const { session, done } = waitForExit((onExit) =>
      createTerminalSession({
        shell: "sh",
        args: ["-lc", "sleep 30"],
        onData: () => {},
        onExit,
      }),
    );

    session.kill();
    await expect(Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))])).resolves.toBe(true);
  });
});

describe("terminal websocket", () => {
  let faux: ReturnType<typeof setupFaux>;
  let server: ReturnType<typeof serve>;
  let port = 0;

  beforeEach(async () => {
    faux = setupFaux();
    const made = makeManager(faux);
    const { app, injectWebSocket } = createApp({
      manager: made.manager,
      taskManager: made.taskManager,
      scheduler: made.scheduler,
      indexer: made.indexer,
      bus: made.bus,
      persona: new PersonaStore(`${made.dataDir}/persona`),
      config: {
        port: 0,
        host: "127.0.0.1",
        dataDir: made.dataDir,
        authToken: "test-token",
        defaultModel: "faux/faux",
        webDistDir: "/tmp/nonexistent",
        generateTitles: false,
        piAuthPath: `${made.dataDir}/no-auth.json`,
        subagentModel: "faux/faux",
        taskConcurrency: 4,
        taskTimeoutMinutes: 15,
        contextFiles: false,
      },
      authStore: new PiAuthStore(`${made.dataDir}/no-auth.json`),
    });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
      injectWebSocket(server);
    });
  });

  afterEach(async () => {
    faux.unregister();
    await new Promise((resolve) => server.close(resolve));
  });

  test("rejects missing or invalid terminal websocket tokens", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws?token=wrong`);
    const closeEvent = await new Promise<CloseEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for close event")), 2000);
      ws.addEventListener(
        "close",
        (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        (event) => {
          clearTimeout(timeout);
          reject(event.error ?? new Error("websocket error before close"));
        },
        { once: true },
      );
    });

    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    expect(closeEvent.code).toBe(4401);
  });
});
