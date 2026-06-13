import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ensureRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);

/** Number of successful mutations between auto-commits. */
export const AUTO_COMMIT_EVERY = 10;

/** In-process state. Survives nothing across process restarts — by design. */
const INITIAL_PENDING_WRITES = 0;
let pendingWrites = INITIAL_PENDING_WRITES;
let startupFlushDone = false;
let inflight: Promise<void> | null = null;

/**
 * Reset the in-process auto-commit state. Test-only — production code
 * never calls this.
 */
export function __resetAutoCommitForTests(): void {
  pendingWrites = INITIAL_PENDING_WRITES;
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
    // A commit is already running. Skip — pendingWrites will be honored by
    // the in-flight drain loop or a later call.
    return;
  }
  inflight = (async () => {
    try {
      const root = await ensureRoot();
      if (!startupFlushDone) {
        await maybeStartupFlush(root);
        startupFlushDone = true;
      }
      while (pendingWrites >= AUTO_COMMIT_EVERY) {
        const n = AUTO_COMMIT_EVERY;
        await commit(root, `auto: ${n} memory writes`);
        pendingWrites -= n;
      }
    } catch (err) {
      // Keep the counter as-is so the next write retries. Per the design,
      // memory writes MUST NOT fail because of commit problems.
      warn(err);
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
  // Skip if a rebase/merge/etc. is in progress — not our mess to clean up.
  if (isGitOpInProgress(root)) {
    warn("skipping startup flush — git operation in progress");
    return;
  }
  await commit(root, "auto: startup flush (uncommitted from previous session)");
}

async function commit(root: string, message: string): Promise<void> {
  await runOrThrow(root, ["add", "-A"]);
  // If nothing is staged (race: another commit may have just landed) git's
  // behavior on an empty commit is version/state-dependent, so we guard on
  // staged content rather than relying on the exit code.
  const status = await runOrEmpty(root, ["diff", "--cached", "--name-only"]);
  if (!status.trim()) return;
  await runOrThrow(root, ["commit", "-m", message]);
}

function isGitOpInProgress(root: string): boolean {
  // The memory repo is the canonical repo, not a git worktree; this assumes
  // `.git` is a directory rather than a file that points elsewhere.
  const gitDir = path.join(root, ".git");
  return (
    existsSync(path.join(gitDir, "MERGE_HEAD")) ||
    existsSync(path.join(gitDir, "rebase-merge")) ||
    existsSync(path.join(gitDir, "rebase-apply")) ||
    existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")) ||
    existsSync(path.join(gitDir, "REVERT_HEAD")) ||
    existsSync(path.join(gitDir, "BISECT_LOG"))
  );
}

function warn(reason: unknown): void {
  const message = (reason instanceof Error ? reason.message : String(reason)).replace(/\s+/g, " ").trim();
  console.warn(`ytsejam memory auto-commit: ${message}`);
}

async function runOrThrow(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return `${stdout}${stderr}`.trim();
}

async function runOrEmpty(cwd: string, args: string[]): Promise<string> {
  try { return await runOrThrow(cwd, args); }
  catch { return ""; }
}
