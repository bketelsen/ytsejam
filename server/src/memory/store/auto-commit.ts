import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);

/** Number of successful mutations between auto-commits. */
export const AUTO_COMMIT_EVERY = 10;

/** In-process state. Survives nothing across process restarts — by design. */
let pendingWrites = 0;
let startupFlushDone = false;
let inflight: Promise<void> | null = null;

/**
 * Reset the in-process auto-commit state. Test-only — production code
 * never calls this.
 */
export function __resetAutoCommitForTests(): void {
  pendingWrites = 0;
  startupFlushDone = false;
  inflight = null;
}

/**
 * Called by the store's mutation primitives (write, append, patch, move)
 * AFTER a successful file mutation. Bumps the in-process write counter
 * and, every AUTO_COMMIT_EVERY writes, commits the memory store.
 *
 * Never throws — commit failures log a WARNING via console.warn and the
 * caller's write still succeeds. The counter is NOT reset on failure so
 * the next write retries the commit.
 *
 * On the first call after process start, also runs a "startup flush"
 * commit if the working tree was already dirty.
 */
export async function maybeAutoCommit(): Promise<void> {
  pendingWrites += 1;
  if (inflight) {
    // A commit is already running. Skip — when it returns, pendingWrites
    // will be honored on the next call.
    return;
  }
  inflight = (async () => {
    try {
      const root = await ensureRoot();
      if (!startupFlushDone) {
        startupFlushDone = true;
        await maybeStartupFlush(root);
      }
      if (pendingWrites < AUTO_COMMIT_EVERY) return;
      const n = pendingWrites;
      pendingWrites = 0;
      await commit(root, `auto: ${n} memory writes`);
    } catch (err) {
      // Keep the counter as-is so the next write retries. Per the design,
      // memory writes MUST NOT fail because of commit problems.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`ytsejam memory auto-commit: ${message}`);
    } finally {
      inflight = null;
    }
  })();
  await inflight;
}

async function maybeStartupFlush(root: string): Promise<void> {
  // Skip if not a git repo at all — `commit` would fail and we'd warn.
  const status = await runOrEmpty(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.trim()) return;
  // Skip if a rebase/merge is in progress — not our mess to clean up.
  const inProgress = await isGitOpInProgress(root);
  if (inProgress) {
    console.warn("ytsejam memory auto-commit: skipping startup flush — git operation in progress");
    return;
  }
  await commit(root, "auto: startup flush (uncommitted from previous session)");
}

async function commit(root: string, message: string): Promise<void> {
  await runOrThrow(root, ["add", "-A"]);
  // If nothing is staged (race: another commit may have just landed) the
  // commit will fail with exit 1; treat that as success.
  const status = await runOrEmpty(root, ["diff", "--cached", "--name-only"]);
  if (!status.trim()) return;
  await runOrThrow(root, ["commit", "-m", message]);
}

async function isGitOpInProgress(root: string): Promise<boolean> {
  // Cheapest check: git status --porcelain=v2 --branch reports operation state.
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v2", "--branch"], {
      cwd: root,
      encoding: "utf8",
    });
    return /^# branch\.ab.*\n.*(MERGING|REBASING|CHERRY-PICKING|REVERTING|BISECTING)/m.test(stdout)
      || /\.git\/(MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)/i.test(stdout);
  } catch {
    return false;
  }
}

async function runOrThrow(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return `${stdout}${stderr}`.trim();
}

async function runOrEmpty(cwd: string, args: string[]): Promise<string> {
  try { return await runOrThrow(cwd, args); }
  catch { return ""; }
}
