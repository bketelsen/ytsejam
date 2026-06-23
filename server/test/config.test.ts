import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

// Helper: tests don't care about dataDir; pass a fixed sentinel so the
// in-repo-default guard doesn't trip. Tests that care about dataDir
// (e.g. "applies defaults and overrides") call loadConfig directly.
function load(env: Record<string, string | undefined>): ReturnType<typeof loadConfig> {
  return loadConfig({ YTSEJAM_DATA_DIR: "/tmp/test-data", ...env });
}

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

  test("refuses to run with implicit ./data inside the ytsejam repo", () => {
    // Spread an env without YTSEJAM_DATA_DIR — the guard should trip
    // because the test runs from inside the repo checkout.
    expect(() => loadConfig({ YTSEJAM_AUTH_TOKEN: "x" })).toThrow(
      /YTSEJAM_DATA_DIR is unset and the default \.\/data would land inside the ytsejam repo/,
    );
  });

  describe("host", () => {
    test("defaults to 127.0.0.1 (loopback) when YTSEJAM_HOST is unset", () => {
      const cfg = load({ YTSEJAM_AUTH_TOKEN: "test" });
      expect(cfg.host).toBe("127.0.0.1");
    });

    test("honors an explicit YTSEJAM_HOST override (e.g. 0.0.0.0 behind a reverse proxy)", () => {
      const cfg = load({ YTSEJAM_AUTH_TOKEN: "test", YTSEJAM_HOST: "0.0.0.0" });
      expect(cfg.host).toBe("0.0.0.0");
    });
  });

  test("piAuthPath defaults to the pi CLI location and accepts override", () => {
    const def = load({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.piAuthPath.endsWith("/.pi/agent/auth.json")).toBe(true);
    const over = load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_PI_AUTH: "/tmp/custom-auth.json" });
    expect(over.piAuthPath).toBe("/tmp/custom-auth.json");
  });


  test("delegation settings default and override", () => {
    const def = load({ YTSEJAM_AUTH_TOKEN: "x" });
    expect(def.subagentModel).toBe(def.defaultModel);
    expect(def.taskConcurrency).toBe(4);
    expect(def.taskTimeoutMinutes).toBe(15);
    const over = load({
      YTSEJAM_AUTH_TOKEN: "x",
      YTSEJAM_SUBAGENT_MODEL: "faux/faux",
      YTSEJAM_TASK_CONCURRENCY: "2",
      YTSEJAM_TASK_TIMEOUT_MIN: "5",
    });
    expect(over.subagentModel).toBe("faux/faux");
    expect(over.taskConcurrency).toBe(2);
    expect(over.taskTimeoutMinutes).toBe(5);
  });

  test("workspace sandbox defaults on and accepts 0/false opt-out", () => {
    expect(load({ YTSEJAM_AUTH_TOKEN: "x" }).sandbox).toBe(true);
    expect(load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_SANDBOX: "0" }).sandbox).toBe(false);
    expect(load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_SANDBOX: "false" }).sandbox).toBe(false);
    expect(load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_SANDBOX: "FALSE" }).sandbox).toBe(false);
    expect(load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_SANDBOX: "true" }).sandbox).toBe(true);
  });
});


describe("context files config", () => {
  test("defaults to true", () => {
    expect(load({ YTSEJAM_AUTH_TOKEN: "x" }).contextFiles).toBe(true);
  });

  test("YTSEJAM_CONTEXT_FILES=false disables loading", () => {
    expect(
      load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_CONTEXT_FILES: "false" }).contextFiles,
    ).toBe(false);
  });

  test("any other value (including empty) leaves it enabled", () => {
    expect(
      load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_CONTEXT_FILES: "true" }).contextFiles,
    ).toBe(true);
    expect(
      load({ YTSEJAM_AUTH_TOKEN: "x", YTSEJAM_CONTEXT_FILES: "" }).contextFiles,
    ).toBe(true);
  });
});
