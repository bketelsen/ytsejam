import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("requires auth token", () => {
    expect(() => loadConfig({})).toThrow(/YTSEJAM_AUTH_TOKEN/);
  });

  test("applies defaults and overrides", () => {
    const cfg = loadConfig({
      YTSEJAM_AUTH_TOKEN: "secret",
      YTSEJAM_PORT: "4000",
      YTSEJAM_DATA_DIR: "/tmp/x",
    });
    expect(cfg.authToken).toBe("secret");
    expect(cfg.port).toBe(4000);
    expect(cfg.dataDir).toBe("/tmp/x");
    expect(cfg.defaultModel).toContain("/");
  });

  test("piAuthPath defaults to the pi CLI location and accepts override", () => {
    const def = loadConfig({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.piAuthPath.endsWith("/.pi/agent/auth.json")).toBe(true);
    const over = loadConfig({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_PI_AUTH: "/tmp/custom-auth.json" });
    expect(over.piAuthPath).toBe("/tmp/custom-auth.json");
  });

  test("cog settings default to the test daemon socket and accept overrides", () => {
    const def = loadConfig({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.cogSocket.endsWith("/.local/share/cogmemory-test/cog-memory-test.sock")).toBe(true);
    expect(def.cogSocket.startsWith("/")).toBe(true); // ~ expanded
    expect(def.cogRole).toBe("agent");
    const over = loadConfig({
      YTSEJAM_AUTH_TOKEN: "x",
      YTSEJAM_COG_SOCKET: "/run/cog.sock",
      YTSEJAM_COG_ROLE: "ytsejam",
    });
    expect(over.cogSocket).toBe("/run/cog.sock");
    expect(over.cogRole).toBe("ytsejam");
  });

  test("delegation settings default and override", () => {
    const def = loadConfig({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.subagentModel).toBe(def.defaultModel);
    expect(def.taskConcurrency).toBe(4);
    expect(def.taskTimeoutMinutes).toBe(15);
    const over = loadConfig({
      YTSEJAM_AUTH_TOKEN: "x",
      YTSEJAM_SUBAGENT_MODEL: "faux/faux",
      YTSEJAM_TASK_CONCURRENCY: "2",
      YTSEJAM_TASK_TIMEOUT_MIN: "5",
    });
    expect(over.subagentModel).toBe("faux/faux");
    expect(over.taskConcurrency).toBe(2);
    expect(over.taskTimeoutMinutes).toBe(5);
  });
});

describe("audit regressions", () => {
  test("empty YTSEJAM_COG_ROLE falls back to agent", () => {
    const cfg = loadConfig({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_COG_ROLE: "" });
    expect(cfg.cogRole).toBe("agent");
  });
});

describe("context files config", () => {
  test("defaults to true", () => {
    expect(loadConfig({ YTSEJAM_AUTH_TOKEN: "x" }).contextFiles).toBe(true);
  });

  test("YTSEJAM_CONTEXT_FILES=false disables loading", () => {
    expect(
      loadConfig({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_CONTEXT_FILES: "false" }).contextFiles,
    ).toBe(false);
  });

  test("any other value (including empty) leaves it enabled", () => {
    expect(
      loadConfig({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_CONTEXT_FILES: "true" }).contextFiles,
    ).toBe(true);
    expect(
      loadConfig({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_CONTEXT_FILES: "" }).contextFiles,
    ).toBe(true);
  });
});
