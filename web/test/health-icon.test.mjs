import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const src = readFileSync(join(root, "src/components/HealthIcon.tsx"), "utf8");

test("HealthIcon exports a HealthState union with unknown | ok | bad", () => {
  assert.match(src, /export\s+type\s+HealthState\s*=\s*["']unknown["']\s*\|\s*["']ok["']\s*\|\s*["']bad["']/);
});

test("HealthIcon imports Plug and Brain from lucide-react", () => {
  assert.match(src, /import\s*\{[^}]*\bPlug\b[^}]*\}\s*from\s*["']lucide-react["']/);
  assert.match(src, /import\s*\{[^}]*\bBrain\b[^}]*\}\s*from\s*["']lucide-react["']/);
});

test("HealthIcon maps states to color classes (unknown → muted-foreground, ok → success, bad → destructive)", () => {
  assert.match(src, /unknown:\s*["']text-muted-foreground["']/);
  assert.match(src, /ok:\s*["']text-success["']/);
  assert.match(src, /bad:\s*["']text-destructive["']/);
});

test("HealthIcon picks the icon by kind (ws → Plug, ltm → Brain)", () => {
  assert.match(src, /ws:\s*Plug/);
  assert.match(src, /ltm:\s*Brain/);
});

test("HealthIcon renders role='status' with title, aria-label, and data-state from props", () => {
  assert.match(src, /role=\{?["']status["']/);
  assert.match(src, /title=\{title\}/);
  assert.match(src, /aria-label=\{title\}/);
  assert.match(src, /data-state=\{state\}/);
});

test("HealthIcon uses border-current so the ring color follows the text-* class", () => {
  assert.match(src, /border\s+border-current/);
});

test("HealthIcon accepts kind, state, title props with the expected types", () => {
  assert.match(src, /kind:\s*["']ws["']\s*\|\s*["']ltm["']/);
  assert.match(src, /state:\s*HealthState/);
  assert.match(src, /title:\s*string/);
});
