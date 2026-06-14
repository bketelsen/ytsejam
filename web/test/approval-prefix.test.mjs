import test from "node:test";
import assert from "node:assert/strict";

// Plain TypeScript helper, so Node 22+'s built-in type stripping can import it directly.
const { extractTurnOverride } = await import("../src/lib/approvalPrefix.ts");

test("extractTurnOverride: no prefix → no override, unchanged message", () => {
  assert.deepEqual(extractTurnOverride("hello world"), { override: null, message: "hello world" });
});

test("extractTurnOverride: /yolo foo → yolo, foo", () => {
  assert.deepEqual(extractTurnOverride("/yolo foo"), { override: "yolo", message: "foo" });
});

test("extractTurnOverride: /careful do the thing → ask, do the thing", () => {
  assert.deepEqual(extractTurnOverride("/careful do the thing"), { override: "ask", message: "do the thing" });
});

test("extractTurnOverride: /yolo with no body → yolo, empty", () => {
  assert.deepEqual(extractTurnOverride("/yolo"), { override: "yolo", message: "" });
});

test("extractTurnOverride: /yolocowboy → no override (no boundary)", () => {
  assert.deepEqual(extractTurnOverride("/yolocowboy x"), { override: null, message: "/yolocowboy x" });
});

test("extractTurnOverride: /yolo\\nfoo → yolo, foo (newline counts as boundary)", () => {
  assert.deepEqual(extractTurnOverride("/yolo\nfoo"), { override: "yolo", message: "foo" });
});

test("extractTurnOverride: leading whitespace before /yolo → no override", () => {
  assert.deepEqual(extractTurnOverride(" /yolo foo"), { override: null, message: " /yolo foo" });
});

test("extractTurnOverride: /YOLO uppercase → no override (case-sensitive)", () => {
  assert.deepEqual(extractTurnOverride("/YOLO foo"), { override: null, message: "/YOLO foo" });
});
