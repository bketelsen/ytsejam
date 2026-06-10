import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CogClient, CogRpcError } from "../src/cog/client.ts";

type Handler = (req: any) => unknown | undefined;

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Fake cogmemory daemon: newline-delimited JSON-RPC over a unix socket. */
function fakeDaemon(handler: Handler): string {
  const socketPath = join(mkdtempSync(join(tmpdir(), "cog-")), "fake.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const req = JSON.parse(line);
        const out = handler(req);
        if (out !== undefined) conn.write(JSON.stringify(out) + "\n");
      }
    });
  });
  server.listen(socketPath);
  servers.push(server);
  return socketPath;
}

describe("CogClient", () => {
  test("frames request as one JSON-RPC line and returns result", async () => {
    let seen: any;
    const sock = fakeDaemon((req) => {
      seen = req;
      return { jsonrpc: "2.0", id: req.id, result: { content: "hello" } };
    });
    const client = new CogClient({ socketPath: sock });
    const result = await client.call<{ content: string }>("read", {
      role: "agent",
      path: "hot-memory.md",
    });
    expect(result.content).toBe("hello");
    expect(seen.jsonrpc).toBe("2.0");
    expect(seen.method).toBe("read");
    expect(seen.params).toMatchObject({ role: "agent", path: "hot-memory.md" });
    expect(seen.id).toBeDefined();
  });

  test("maps JSON-RPC errors to CogRpcError with code and message", async () => {
    const sock = fakeDaemon((req) => ({
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32602,
        message:
          'write: domain id used as path: write to "dakota/INDEX.md" uses domain id "dakota" as its path; domain "dakota" lives at "projects/dakota"',
      },
    }));
    const client = new CogClient({ socketPath: sock });
    const err: any = await client.call("write", { role: "agent", path: "dakota/INDEX.md", content: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(CogRpcError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('lives at "projects/dakota"');
  });

  test("concurrent calls each get their own correct response", async () => {
    const sock = fakeDaemon((req) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: { echo: req.params.path },
    }));
    const client = new CogClient({ socketPath: sock });
    const results = await Promise.all(
      ["a.md", "b.md", "c.md", "d.md"].map((p) =>
        client.call<{ echo: string }>("read", { role: "agent", path: p }),
      ),
    );
    expect(results.map((r) => r.echo)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  test("unreachable socket produces a clear error naming the path", async () => {
    const client = new CogClient({ socketPath: "/nonexistent/cog.sock" });
    const err: any = await client.call("health", { role: "agent" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CogRpcError);
    expect(err.message).toContain("/nonexistent/cog.sock");
    expect(err.message.toLowerCase()).toContain("not reachable");
  });

  test("connection closed before reply produces a clear error", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "cog-")), "fake.sock");
    const server = net.createServer((conn) => conn.on("data", () => conn.destroy()));
    server.listen(socketPath);
    servers.push(server);
    const client = new CogClient({ socketPath });
    const err: any = await client.call("read", { role: "agent", path: "x.md" }).catch((e) => e);
    expect(err.message).toContain("closed the connection before replying");
  });

  test("times out on a hung daemon", async () => {
    const sock = fakeDaemon(() => undefined); // never replies
    const client = new CogClient({ socketPath: sock, timeoutMs: 100 });
    const err: any = await client.call("read", { role: "agent", path: "x.md" }).catch((e) => e);
    expect(err.message.toLowerCase()).toContain("timed out");
  });

  test("rejects oversized requests before sending (64KB daemon line limit)", async () => {
    let reached = false;
    const sock = fakeDaemon((req) => {
      reached = true;
      return { jsonrpc: "2.0", id: req.id, result: {} };
    });
    const client = new CogClient({ socketPath: sock });
    const err: any = await client
      .call("write", { role: "agent", path: "big.md", content: "x".repeat(70_000) })
      .catch((e) => e);
    expect(err.message).toContain("too large");
    expect(err.message).toContain("cog_append");
    expect(reached).toBe(false);
  });

  test("sessionBrief returns the typed envelope", async () => {
    const sock = fakeDaemon((req) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        hot_memory: "hot",
        patterns: "rules",
        domains: [{ id: "dakota", path: "projects/dakota", label: "Dakota", triggers: ["dakota"] }],
        action_counts: { dakota: 2, _pri_high_anywhere: false },
        controller_last_error: null,
      },
    }));
    const client = new CogClient({ socketPath: sock });
    const brief = await client.sessionBrief("agent");
    expect(brief.hot_memory).toBe("hot");
    expect(brief.domains[0].path).toBe("projects/dakota");
  });

  test("health() returns true when daemon responds and false when unreachable, never throws", async () => {
    const sock = fakeDaemon((req) => ({ jsonrpc: "2.0", id: req.id, result: { status: "ok" } }));
    expect(await new CogClient({ socketPath: sock }).health()).toBe(true);
    expect(await new CogClient({ socketPath: "/nonexistent/cog.sock" }).health()).toBe(false);
  });
});

describe("audit regressions", () => {
  test("multibyte UTF-8 split across chunks decodes intact", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "cog-")), "fake.sock");
    const server = net.createServer((conn) => {
      conn.on("data", () => {
        const payload = Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: "héllo — émoji 🎉" } }) + "\n",
          "utf8",
        );
        // split mid-sequence: one byte into the é (0xC3 0xA9), two bytes into the 🎉
        const eAcute = payload.indexOf(0xc3) + 1;
        const emoji = payload.indexOf(0xf0) + 2;
        conn.write(payload.subarray(0, eAcute));
        setTimeout(() => conn.write(payload.subarray(eAcute, emoji)), 10);
        setTimeout(() => conn.write(payload.subarray(emoji)), 20);
      });
    });
    server.listen(socketPath);
    servers.push(server);
    const client = new CogClient({ socketPath });
    const r = await client.call<{ content: string }>("read", { role: "agent", path: "x.md" });
    expect(r.content).toBe("héllo — émoji 🎉");
    expect(r.content).not.toContain("�");
  });
});
