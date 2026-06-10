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
});
