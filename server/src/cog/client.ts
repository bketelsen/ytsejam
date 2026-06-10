import net from "node:net";

/**
 * Client for the cogmemory daemon: newline-delimited JSON-RPC 2.0 over a
 * unix socket. One short-lived connection per request — the daemon handles
 * each connection's lines sequentially, while agent tools execute in
 * parallel, so per-request connections give natural concurrency and survive
 * daemon restarts without correlation state.
 */

/** A JSON-RPC error returned by the daemon (RBAC denial, invalid params, store error...). */
export class CogRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CogRpcError";
  }
}

export interface CogClientOptions {
  socketPath: string;
  /** per-call deadline covering connect + response; default 5000ms */
  timeoutMs?: number;
}

export interface SessionBrief {
  hot_memory: string;
  patterns: string;
  domains: { id: string; path: string; label?: string; triggers?: string[] }[];
  action_counts: Record<string, number | boolean>;
  controller_last_error: string | null;
}

// The daemon reads requests with a default bufio.Scanner (64KB line cap); an
// oversized line closes the connection with no response. Reject early with
// actionable guidance instead.
const MAX_REQUEST_BYTES = 60_000;

const DEFAULT_TIMEOUT_MS = 5_000;

export class CogClient {
  private nextId = 1;

  constructor(private readonly opts: CogClientOptions) {}

  get socketPath(): string {
    return this.opts.socketPath;
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const request =
      JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }) + "\n";
    if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error(
        `cog request too large for the memory daemon (64KB line limit) — split the content into multiple cog_append calls`,
      );
    }
    const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const line = await this.exchange(request, timeoutMs);
    const response = JSON.parse(line);
    if (response.error) {
      throw new CogRpcError(response.error.code, response.error.message);
    }
    return response.result as T;
  }

  /** Typed convenience for the session_brief envelope. */
  sessionBrief(role: string): Promise<SessionBrief> {
    return this.call<SessionBrief>("session_brief", { role });
  }

  /** True when the daemon answers a health call. Never throws. */
  async health(timeoutMs = 1_500): Promise<boolean> {
    try {
      await this.call("health", {}, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  private exchange(request: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.opts.socketPath });
      let buf = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`cog request timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );
      socket.on("connect", () => socket.write(request));
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) finish(() => resolve(buf.slice(0, nl)));
      });
      socket.on("error", (err: NodeJS.ErrnoException) => {
        const message =
          err.code === "ENOENT" || err.code === "ECONNREFUSED"
            ? `cog memory daemon not reachable at ${this.opts.socketPath}`
            : `cog socket error: ${err.message}`;
        finish(() => reject(new Error(message)));
      });
      socket.on("close", () =>
        finish(() =>
          reject(
            new Error(
              "cog memory daemon closed the connection before replying (daemon restarted, or the request exceeded its 64KB line limit)",
            ),
          ),
        ),
      );
    });
  }
}
