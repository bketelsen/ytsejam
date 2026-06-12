import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Source-inspection contract tests for the error boundary, matching the
// established node:test pattern used across web/test/*.

const root = new URL("..", import.meta.url).pathname;

const boundarySource = readFileSync(
  join(root, "src/components/MessageErrorBoundary.tsx"),
  "utf8",
);
const chatSource = readFileSync(join(root, "src/components/Chat.tsx"), "utf8");

test("MessageErrorBoundary is a React class component", () => {
  // React 19 still requires class components for error boundaries (no hook
  // equivalent). Make sure we don't accidentally refactor to a functional
  // component and silently lose the catch.
  assert.match(
    boundarySource,
    /class\s+MessageErrorBoundary\s+extends\s+(React\.)?Component/,
    "MessageErrorBoundary must be a class extending React.Component",
  );
});

test("MessageErrorBoundary implements getDerivedStateFromError", () => {
  // Required half of the boundary contract — drives the fallback render path.
  assert.match(
    boundarySource,
    /static\s+getDerivedStateFromError\s*\(/,
    "missing static getDerivedStateFromError",
  );
});

test("MessageErrorBoundary implements componentDidCatch", () => {
  // Required half of the boundary contract — gives us a side-effect hook for
  // console / telemetry without affecting the render output.
  assert.match(
    boundarySource,
    /componentDidCatch\s*\(/,
    "missing componentDidCatch",
  );
});

test("MessageErrorBoundary renders children when no error has been caught", () => {
  // Happy path: must pass through `this.props.children`. If this regresses the
  // boundary would either render nothing or always render the fallback.
  assert.match(
    boundarySource,
    /this\.props\.children/,
    "boundary must render this.props.children in the happy path",
  );
});

test("MessageErrorBoundary fallback surfaces the role and the error message", () => {
  // The whole point of the boundary is to make a localised, debuggable
  // failure. Make sure the fallback UI mentions both pieces of context.
  assert.match(boundarySource, /Could not render this message/);
  assert.match(boundarySource, /message\?\.role/);
  assert.match(boundarySource, /error\.message/);
});

test("Chat.tsx imports MessageErrorBoundary", () => {
  assert.match(
    chatSource,
    /from\s+["']\.\/MessageErrorBoundary["']/,
    "Chat.tsx must import MessageErrorBoundary",
  );
});

test("Chat.tsx wraps every <Message ...> render in <MessageErrorBoundary>", () => {
  // Belt-and-braces: there must be zero bare <Message uses outside a boundary.
  // Strip whitespace before each <Message and check the preceding token.
  const messageRenders = chatSource.match(/<Message[ \n][^>]*\/>/g) ?? [];
  assert.notEqual(
    messageRenders.length,
    0,
    "expected at least one <Message /> render in Chat.tsx",
  );
  for (const render of messageRenders) {
    // Find this exact render in the source and confirm the preceding non-space
    // text is an opening <MessageErrorBoundary ...> tag.
    const idx = chatSource.indexOf(render);
    const prefix = chatSource.slice(Math.max(0, idx - 200), idx);
    assert.match(
      prefix,
      /<MessageErrorBoundary[^>]*>\s*$/,
      `<Message ...> render not preceded by <MessageErrorBoundary>: ${render}`,
    );
  }
});
