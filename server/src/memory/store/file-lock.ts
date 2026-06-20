/**
 * Per-path async mutex for the cog markdown store.
 *
 * The store's mutating primitives (append/write/patch/move) are each a
 * read → modify → atomicWrite(rename) sequence. atomicWrite is atomic per
 * write, but the read-modify-write as a whole is NOT serialized: two overlapping
 * mutations of the SAME file both read the same `existing`, then the second
 * rename clobbers the first ("lost update"). pi executes a turn's tool calls in
 * parallel (Promise.all), so a model emitting two cog_append/cog_patch calls to
 * the same file in one turn can silently drop one — and cog markdown is the
 * AUTHORITATIVE substrate, so that's silent persisted-memory loss.
 *
 * This serializes mutations per resolved path: a chain of promises keyed by the
 * file, so writes to the same file run one-at-a-time while writes to different
 * files stay fully parallel. Mirrors the in-process coalescing approach used by
 * auto-commit.ts.
 */

// Tail of the in-flight chain per file key. Absent key == idle (no contention).
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `key` (typically a resolved absolute path).
 * Concurrent calls for the same key run sequentially in arrival order; calls for
 * different keys run concurrently. The chain self-prunes when it drains so the
 * map doesn't grow without bound.
 */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  // Run fn whether the prior holder fulfilled or rejected, so one failed
  // mutation doesn't strand every later writer to the same file.
  const run = prior.then(fn, fn);
  // The stored tail swallows errors so the NEXT waiter isn't rejected by a
  // predecessor's failure; the real result/rejection is returned to THIS caller.
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  // Prune the map entry once this is the current tail and it has drained, so an
  // idle file doesn't retain a settled promise forever.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
