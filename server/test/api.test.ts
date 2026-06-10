import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { fauxAssistantMessage, makeManager, setupFaux } from "./helpers.ts";

let faux: ReturnType<typeof setupFaux>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  faux = setupFaux();
  const made = makeManager(faux);
  deps = {
    manager: made.manager,
    taskManager: made.taskManager,
    scheduler: made.scheduler,
    indexer: made.indexer,
    bus: made.bus,
    persona: new PersonaStore(`${made.dataDir}/persona`),
    config: {
      port: 0,
      dataDir: made.dataDir,
      authToken: "test-token",
      defaultModel: "faux/faux",
      webDistDir: "/tmp/nonexistent",
      generateTitles: false,
      piAuthPath: `${made.dataDir}/no-auth.json`,
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
    cogSocket: "/tmp/no-cog.sock",
    cogRole: "agent",
    },
    authStore: new PiAuthStore(`${made.dataDir}/no-auth.json`),
  };
  app = createApp(deps).app;
});
afterEach(() => faux.unregister());

const auth = { Authorization: "Bearer test-token" };

describe("auth", () => {
  test("rejects missing/wrong token", async () => {
    expect((await app.request("/api/sessions")).status).toBe(401);
    expect((await app.request("/api/sessions", { headers: { Authorization: "Bearer no" } })).status).toBe(401);
  });

  test("login validates the token", async () => {
    const ok = await app.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token: "test-token" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    const bad = await app.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token: "wrong" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(401);
  });
});

describe("sessions", () => {
  test("create, list, message, transcript, rename, mark-read, delete", async () => {
    faux.setResponses([fauxAssistantMessage("api reply")]);

    const created = await app.request("/api/sessions", { method: "POST", headers: auth });
    expect(created.status).toBe(200);
    const { session } = (await created.json()) as any;

    const list = (await (await app.request("/api/sessions", { headers: auth })).json()) as any;
    expect(list.sessions.length).toBe(1);

    const sent = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(sent.status).toBe(202);
    await deps.manager.waitForIdle(session.id);

    const transcript = (await (
      await app.request(`/api/sessions/${session.id}`, { headers: auth })
    ).json()) as any;
    expect(transcript.messages.some((m: any) => m.role === "assistant")).toBe(true);
    expect(transcript.session.unread).toBe(true);

    await app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed", unread: false }),
    });
    const after = (await (await app.request("/api/sessions", { headers: auth })).json()) as any;
    expect(after.sessions[0]).toMatchObject({ title: "Renamed", unread: false });

    const del = await app.request(`/api/sessions/${session.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect(((await (await app.request("/api/sessions", { headers: auth })).json()) as any).sessions).toEqual([]);
  });

  test("404 for unknown session", async () => {
    const res = await app.request("/api/sessions/nope", { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("persona and models", () => {
  test("persona round-trip", async () => {
    const get = await app.request("/api/persona", { headers: auth });
    expect(((await get.json()) as any).content).toContain("personal assistant");
    await app.request("/api/persona", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Persona\nJeeves." }),
    });
    const get2 = await app.request("/api/persona", { headers: auth });
    expect(((await get2.json()) as any).content).toBe("# Persona\nJeeves.");
  });

  test("models endpoint returns a list", async () => {
    const res = await app.request("/api/models", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.defaultModel).toBe("faux/faux");
  });
});

describe("tasks api", () => {
  test("list, transcript, cancel", async () => {
    faux.setResponses([fauxAssistantMessage("task report"), fauxAssistantMessage("ack")]);
    const row = await deps.manager.createSession();
    const task = await deps.taskManager.delegate({
      parentSessionId: row.id,
      task: "do it",
      label: "do it",
    });

    // wait for completion
    for (let i = 0; i < 200 && deps.indexer.getTask(task.id)?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(deps.indexer.getTask(task.id)?.status).toBe("completed");

    const list = (await (await app.request("/api/tasks", { headers: auth })).json()) as any;
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({ id: task.id, status: "completed" });

    const transcript = (await (
      await app.request(`/api/tasks/${task.id}/transcript`, { headers: auth })
    ).json()) as any;
    expect(transcript.task.id).toBe(task.id);
    expect(transcript.messages.some((m: any) => m.role === "assistant")).toBe(true);

    // cancel on a finished task → 409
    const cancel = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST", headers: auth });
    expect(cancel.status).toBe(409);

    // unknown ids → 404
    expect((await app.request("/api/tasks/nope/transcript", { headers: auth })).status).toBe(404);
    expect((await app.request("/api/tasks/nope/cancel", { method: "POST", headers: auth })).status).toBe(404);
  });
});

describe("schedules api", () => {
  test("list and cancel", async () => {
    const row = deps.scheduler.create({
      label: "api sched",
      prompt: "p",
      spec: { type: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
      targetSessionId: null,
    });

    const list = (await (await app.request("/api/schedules", { headers: auth })).json()) as any;
    expect(list.schedules).toHaveLength(1);
    expect(list.schedules[0]).toMatchObject({ id: row.id, label: "api sched", enabled: true });

    const del = await app.request(`/api/schedules/${row.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    const after = (await (await app.request("/api/schedules", { headers: auth })).json()) as any;
    expect(after.schedules[0]).toMatchObject({ cancelled: true });

    expect((await app.request(`/api/schedules/${row.id}`, { method: "DELETE", headers: auth })).status).toBe(409);
    expect((await app.request("/api/schedules/nope", { method: "DELETE", headers: auth })).status).toBe(409);
  });
});
