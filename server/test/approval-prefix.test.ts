import { describe, expect, test } from "vitest";
import { extractTurnOverride } from "../src/approval/prefix.ts";

describe("extractTurnOverride", () => {
  test("no prefix → no override, unchanged message", () => {
    expect(extractTurnOverride("hello world")).toEqual({ override: null, message: "hello world" });
  });

  test("/yolo foo → yolo, foo", () => {
    expect(extractTurnOverride("/yolo foo")).toEqual({ override: "yolo", message: "foo" });
  });

  test("/careful do the thing → ask, do the thing", () => {
    expect(extractTurnOverride("/careful do the thing")).toEqual({ override: "ask", message: "do the thing" });
  });

  test("/yolo with no body → yolo, empty", () => {
    expect(extractTurnOverride("/yolo")).toEqual({ override: "yolo", message: "" });
  });

  test("/yolocowboy → no override (no boundary)", () => {
    expect(extractTurnOverride("/yolocowboy x")).toEqual({ override: null, message: "/yolocowboy x" });
  });

  test("/yolo\nfoo → yolo, foo (newline counts as boundary)", () => {
    expect(extractTurnOverride("/yolo\nfoo")).toEqual({ override: "yolo", message: "foo" });
  });

  test("leading whitespace before /yolo → no override", () => {
    expect(extractTurnOverride(" /yolo foo")).toEqual({ override: null, message: " /yolo foo" });
  });

  test("/YOLO uppercase → no override (case-sensitive)", () => {
    expect(extractTurnOverride("/YOLO foo")).toEqual({ override: null, message: "/YOLO foo" });
  });
});
