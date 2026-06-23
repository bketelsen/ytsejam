import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createRunChecksTool, parseVitestOutput } from "../src/tools/run-checks.ts";
import { runArgv } from "../src/tools/shell.ts";

const dir = () => mkdtempSync(join(tmpdir(), "run-checks-tool-"));

async function git(cwd: string, args: string[]) {
  const result = await runArgv("git", args, { cwd, timeoutMs: 5000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.output}`);
  }
}

async function initProject(): Promise<string> {
  const cwd = dir();
  await git(cwd, ["init", "-b", "main"]);
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "fixture",
    type: "module",
    scripts: {
      pass: "node -e \"console.log('ok')\"",
      fail: "node -e \"console.error('broken'); process.exit(7)\"",
      wait: "node -e \"setTimeout(() => console.log('waited'), 100)\"",
      test: "npm run pass",
    },
  }, null, 2));
  return cwd;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createRunChecksTool>["execute"]>>): string {
  return (result.content[0] as any).text;
}

describe("run_checks tool", () => {
  test("returns structured pass result for a passing script", async () => {
    const cwd = await initProject();
    const tool = createRunChecksTool(cwd);

    const result = await tool.execute("t1", { kind: "script", script: "pass", timeoutSeconds: 5 });

    expect(result.details).toMatchObject({
      command: "npm run pass",
      kind: "script",
      workspace: undefined,
      exitCode: 0,
      passed: true,
      timedOut: false,
      truncated: false,
      failures: [],
    });
    expect(text(result)).toContain("passed");
  });

  test("returns structured fail result for a failing script", async () => {
    const cwd = await initProject();
    const tool = createRunChecksTool(cwd);

    const result = await tool.execute("t1", { kind: "script", script: "fail", timeoutSeconds: 5 });

    expect(result.details).toMatchObject({
      command: "npm run fail",
      kind: "script",
      exitCode: 7,
      passed: false,
      timedOut: false,
      failures: [],
    });
    expect(text(result)).toContain("failed");
    expect(text(result)).toContain("broken");
  });

  test("returns structured error for an unknown script", async () => {
    const cwd = await initProject();
    const tool = createRunChecksTool(cwd);

    const result = await tool.execute("t1", { kind: "script", script: "missing", timeoutSeconds: 5 });

    expect(result.details).toMatchObject({
      command: "npm run missing",
      kind: "script",
      exitCode: null,
      passed: false,
      timedOut: false,
      truncated: false,
      summary: "Script 'missing' was not found. Available scripts: fail, pass, test, wait.",
      failures: [],
      availableScripts: ["fail", "pass", "test", "wait"],
    });
    expect(text(result)).toContain("Script 'missing' was not found");
  });

  test("rejects leading-dash explicit script names", async () => {
    const cwd = await initProject();
    const tool = createRunChecksTool(cwd);

    await expect(
      tool.execute("t1", { kind: "script", script: "--help", timeoutSeconds: 5 }),
    ).rejects.toThrow(/leading-dash/i);
  });

  test("clamps zero timeout to at least one second", async () => {
    const cwd = await initProject();
    const tool = createRunChecksTool(cwd);

    const result = await tool.execute("t1", { kind: "script", script: "wait", timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      command: "npm run wait",
      exitCode: 0,
      passed: true,
      timedOut: false,
    });
  });

  test("resolves npm workspace scripts from the repo root", async () => {
    const cwd = dir();
    await git(cwd, ["init", "-b", "main"]);
    mkdirSync(join(cwd, "server"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "fixture",
      type: "module",
      workspaces: ["server"],
      scripts: {},
    }, null, 2));
    writeFileSync(join(cwd, "server", "package.json"), JSON.stringify({
      name: "@fixture/server",
      type: "module",
      scripts: {
        check: "node -e \"console.log('checked')\"",
      },
    }, null, 2));
    const tool = createRunChecksTool(join(cwd, "server"));

    const result = await tool.execute("t1", { kind: "typecheck", workspace: "server", timeoutSeconds: 5 });

    expect(result.details).toMatchObject({
      command: "npm run check --workspace server",
      kind: "typecheck",
      workspace: "server",
      exitCode: 0,
      passed: true,
    });
  });
});

describe("parseVitestOutput", () => {
  test("extracts summary and failing test names from recognizable vitest output", () => {
    const parsed = parseVitestOutput(`
 FAIL  test/math.test.ts > math > adds wrong (123ms)
 FAIL  test/string.test.ts [ test/string.test.ts ]

 Test Files  2 failed | 1 passed (3)
      Tests  2 failed | 4 passed | 1 skipped (7)
   Start at  12:00:00
   Duration  1.23s
`);

    expect(parsed).toEqual({
      summary: "4 passed, 2 failed, 1 skipped",
      failures: [
        "test/math.test.ts > math > adds wrong",
        "test/string.test.ts [ test/string.test.ts ]",
      ],
    });
  });

  test("parses vitest lines prefixed with cursor-control escape sequences", () => {
    const parsed = parseVitestOutput([
      "\x1b[2K\x1b[1G FAIL  test/csi.test.ts > csi > survives cursor controls (45ms)",
      "\x1b[2K\x1b[1G Test Files  1 failed | 1 passed (2)",
      "\x1b[2K\x1b[1G      Tests  2 failed | 4 passed (6)",
    ].join("\n"));

    expect(parsed).toEqual({
      summary: "4 passed, 2 failed",
      failures: ["test/csi.test.ts > csi > survives cursor controls"],
    });
  });
});
