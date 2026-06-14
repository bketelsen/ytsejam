import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type AppDeps } from "../src/server.ts";
import { PiAuthStore } from "../src/pi-auth.ts";
import { PersonaStore } from "../src/persona.ts";
import { SkillsStore } from "../src/skills.ts";
import { makeManager, setupFaux } from "./helpers.ts";

async function seed(skillsDir: string): Promise<void> {
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, "alpha.md"),
    "---\nname: alpha\ndescription: First skill\ntriggers: [a, alpha, first]\n---\nbody\n",
  );
  await fs.writeFile(
    path.join(skillsDir, "beta.md"),
    "---\nname: beta\ndescription: Second skill\ntriggers: [b, beta]\n---\nbody\n",
  );
}

function buildApp(opts: { skills?: SkillsStore } = {}): ReturnType<typeof createApp>["app"] {
  const made = makeManager(faux);
  const deps: AppDeps = {
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
      webDistDir: os.tmpdir(),
      generateTitles: false,
      piAuthPath: `${made.dataDir}/no-auth.json`,
      subagentModel: "faux/faux",
      taskConcurrency: 4,
      taskTimeoutMinutes: 15,
      contextFiles: false,
    },
    authStore: new PiAuthStore(`${made.dataDir}/no-auth.json`),
    skills: opts.skills,
  };
  return createApp(deps).app;
}

async function getJson(pathname: string, token?: string): Promise<{ status: number; body: SkillsResponse | null }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(pathname, { headers });
  const body = res.status === 200 ? ((await res.json()) as SkillsResponse) : null;
  return { status: res.status, body };
}

type SkillsResponse = {
  skills: Array<{
    name: string;
    description?: string;
    triggers?: string[];
  }>;
};

let faux: ReturnType<typeof setupFaux>;
let app: ReturnType<typeof createApp>["app"];

beforeEach(async () => {
  faux = setupFaux();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytsejam-skills-api-"));
  await seed(path.join(dir, "skills"));
  app = buildApp({ skills: new SkillsStore(path.join(dir, "skills")) });
});

afterEach(() => faux.unregister());

describe("GET /api/skills", () => {
  it("returns the list from the injected SkillsStore", async () => {
    const { status, body } = await getJson("/api/skills", "test-token");
    expect(status).toBe(200);
    expect(body?.skills).toHaveLength(2);
    const names = body?.skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    const alpha = body?.skills.find((s) => s.name === "alpha");
    expect(alpha?.description).toBe("First skill");
    expect(alpha?.triggers).toEqual(["a", "alpha", "first"]);
  });

  it("returns 401 without a bearer token", async () => {
    const { status } = await getJson("/api/skills");
    expect(status).toBe(401);
  });

  it("returns an empty array when no SkillsStore was injected", async () => {
    app = buildApp();
    const { status, body } = await getJson("/api/skills", "test-token");
    expect(status).toBe(200);
    expect(body?.skills).toEqual([]);
  });
});
