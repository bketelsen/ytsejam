import { describe, expect, test } from "vitest";
import { EventBus, type ServerEvent } from "../src/events.ts";

describe("EventBus", () => {
  test("delivers events to subscribers until unsubscribed", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    bus.emit({ type: "session_deleted", sessionId: "a" });
    unsub();
    bus.emit({ type: "session_deleted", sessionId: "b" });
    expect(seen).toEqual([{ type: "session_deleted", sessionId: "a" }]);
  });

  test("a throwing subscriber does not break others", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => seen.push(e));
    bus.emit({ type: "session_deleted", sessionId: "a" });
    expect(seen.length).toBe(1);
  });
});
