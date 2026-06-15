import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupFaux, makeManager } from "./helpers.ts";

function makeOpened(id: string, abort: () => Promise<void>) {
  return {
    id,
    harness: { abort },
  };
}

describe("AgentManager.abortAll", () => {
  let faux: ReturnType<typeof setupFaux>;

  beforeEach(() => {
    faux = setupFaux();
  });

  afterEach(() => {
    faux.unregister();
  });

  it("calls harness.abort() on every opened session and awaits all", async () => {
    const { manager } = makeManager(faux);
    const resolvers: Array<() => void> = [];
    const completed: string[] = [];
    const aborts = ["a", "b", "c"].map((id) =>
      vi.fn(async () => {
        await new Promise<void>((resolve) => resolvers.push(resolve));
        completed.push(id);
      }),
    );
    (manager as any).open = new Map([
      ["a", makeOpened("a", aborts[0])],
      ["b", makeOpened("b", aborts[1])],
      ["c", makeOpened("c", aborts[2])],
    ]);

    let settled = false;
    const promise = manager.abortAll().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(aborts.map((abort) => abort.mock.calls.length)).toEqual([1, 1, 1]);
    expect(settled).toBe(false);

    resolvers.forEach((resolve) => resolve());
    await promise;

    expect(settled).toBe(true);
    expect(completed).toEqual(["a", "b", "c"]);
  });

  it("is idempotent — abortAll() then abortAll() does not throw", async () => {
    const { manager } = makeManager(faux);
    const aborted = new Set<string>();
    const aborts = ["a", "b", "c"].map((id) =>
      vi.fn(async () => {
        if (aborted.has(id)) throw new Error("already aborted");
        aborted.add(id);
      }),
    );
    (manager as any).open = new Map([
      ["a", makeOpened("a", aborts[0])],
      ["b", makeOpened("b", aborts[1])],
      ["c", makeOpened("c", aborts[2])],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(manager.abortAll()).resolves.toBeUndefined();
    await expect(manager.abortAll()).resolves.toBeUndefined();

    expect(aborts.map((abort) => abort.mock.calls.length)).toEqual([2, 2, 2]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("resolves even when one harness.abort() rejects", async () => {
    const { manager } = makeManager(faux);
    const completed: string[] = [];
    const aborts = [
      vi.fn(async () => {
        completed.push("a");
      }),
      vi.fn(async () => {
        throw new Error("boom");
      }),
      vi.fn(async () => {
        completed.push("c");
      }),
    ];
    (manager as any).open = new Map([
      ["a", makeOpened("a", aborts[0])],
      ["b", makeOpened("b", aborts[1])],
      ["c", makeOpened("c", aborts[2])],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(manager.abortAll()).resolves.toBeUndefined();

    expect(aborts.map((abort) => abort.mock.calls.length)).toEqual([1, 1, 1]);
    expect(completed).toEqual(["a", "c"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
