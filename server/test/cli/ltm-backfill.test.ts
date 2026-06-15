import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ltmBackfill } from "../../src/cli/ltm-commands.ts";

describe("ltmBackfill CLI", () => {
  const originalToken = process.env.YTSEJAM_API_TOKEN;
  const originalUrl = process.env.YTSEJAM_API_URL;

  beforeEach(() => {
    process.env.YTSEJAM_API_TOKEN = "test-token";
    process.env.YTSEJAM_API_URL = "http://test";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.YTSEJAM_API_TOKEN;
    else process.env.YTSEJAM_API_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.YTSEJAM_API_URL;
    else process.env.YTSEJAM_API_URL = originalUrl;
  });

  it("POSTs to start, polls GET until done, returns 0", async () => {
    const calls: { method: string; url: string }[] = [];
    let pollCount = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "POST" && url.endsWith("/api/admin/ltm-backfill")) {
          return new Response(JSON.stringify({ jobId: "backfill-abc-123" }), {
            status: 200,
          });
        }
        if (method === "GET" && url.includes("/backfill-abc-123")) {
          pollCount++;
          return new Response(
            JSON.stringify({
              jobId: "backfill-abc-123",
              status: pollCount < 2 ? "running" : "done",
              processed: pollCount,
              total: 2,
              warnings: [],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exit = await ltmBackfill({
      dir: "/tmp/fixture",
      pollMs: 5,
      fetch: fetchMock as never,
      stdout: (l) => stdoutLines.push(l),
      stderr: (l) => stderrLines.push(l),
    });
    expect(exit).toBe(0);
    const postCalls = calls.filter((c) => c.method === "POST");
    const getCalls = calls.filter((c) => c.method === "GET");
    expect(postCalls.length).toBe(1);
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
    expect(stdoutLines.some((l) => l.includes("backfill-abc-123"))).toBe(
      true,
    );
    expect(stdoutLines.some((l) => l.includes("backfill: done"))).toBe(true);
  });

  it("abort during polling sends DELETE and returns 1", async () => {
    const calls: { method: string; url: string }[] = [];
    let pollCount = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "POST" && url.endsWith("/api/admin/ltm-backfill")) {
          return new Response(
            JSON.stringify({ jobId: "backfill-cancel-1" }),
            { status: 200 },
          );
        }
        if (method === "GET" && url.includes("/backfill-cancel-1")) {
          pollCount++;
          const hasDelete = calls.some((c) => c.method === "DELETE");
          return new Response(
            JSON.stringify({
              jobId: "backfill-cancel-1",
              status: hasDelete ? "cancelled" : "running",
              processed: pollCount,
              total: 10,
              warnings: [],
            }),
            { status: 200 },
          );
        }
        if (method === "DELETE" && url.includes("/backfill-cancel-1")) {
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 25);
    const exit = await ltmBackfill({
      dir: "/tmp/fixture",
      pollMs: 10,
      fetch: fetchMock as never,
      abortSignal: abortController.signal,
      stdout: () => {},
      stderr: () => {},
    });
    expect(exit).toBe(1);
    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0].url).toContain("/backfill-cancel-1");
  });

  it("returns 2 when dir is missing", async () => {
    const errs: string[] = [];
    const exit = await ltmBackfill({
      dir: "",
      stdout: () => {},
      stderr: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("dir"))).toBe(true);
  });

  it("returns 2 when YTSEJAM_API_TOKEN is missing", async () => {
    delete process.env.YTSEJAM_API_TOKEN;
    const errs: string[] = [];
    const exit = await ltmBackfill({
      dir: "/tmp/fixture",
      stdout: () => {},
      stderr: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("YTSEJAM_API_TOKEN"))).toBe(true);
  });
});
