import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const message = readFileSync(join(root, "src/components/Message.tsx"), "utf8");
const taskCard = readFileSync(join(root, "src/components/TaskCard.tsx"), "utf8");

// Bug 2: a failed/interrupted task's transcript rendered any cut-off tool call
// (one with no toolResult) as a perpetual "running…" spinner, which reads as
// "still working" forever. In a terminal task the tool call did NOT complete.

test("ToolCallCard distinguishes an interrupted tool call from a running one", () => {
  assert.match(message, /interrupted/, "ToolCallCard should accept an interrupted flag");
  // the running spinner must be gated on NOT being interrupted
  const runningLine = message.split("\n").find((l) => l.includes("running…"));
  assert.ok(runningLine, "expected a running… label");
  assert.match(
    message,
    /!result && !interrupted[\s\S]*running…|interrupted[\s\S]*\?[\s\S]*running…|!interrupted[\s\S]*running…/,
    "running… must be shown only when not interrupted",
  );
});

test("TaskTranscriptDialog marks tool calls interrupted for terminal tasks", () => {
  // it must derive live/terminal from the task status and pass it into Message
  assert.match(taskCard, /status === "running" \|\| .*status === "pending"/);
  assert.match(taskCard, /interrupted=\{/, "Message in the transcript must receive an interrupted prop");
});
