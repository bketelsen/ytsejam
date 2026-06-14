import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;

const apiSrc = readFileSync(join(root, "src/lib/api.ts"), "utf8");
const typesSrc = readFileSync(join(root, "src/lib/types.ts"), "utf8");

test("types.ts exports the SkillSummary interface with name/description/triggers", () => {
  assert.match(typesSrc, /export\s+interface\s+SkillSummary\b/);
  const body = typesSrc.match(/export\s+interface\s+SkillSummary\s*\{([\s\S]*?)\}/);
  assert.ok(body, "could not locate SkillSummary interface body");
  assert.match(body[1], /\bname\s*:\s*string\b/);
  assert.match(body[1], /\bdescription\s*:\s*string\b/);
  assert.match(body[1], /\btriggers\s*:\s*string\[\]/);
});

test("api.ts imports SkillSummary from ./types", () => {
  assert.match(
    apiSrc,
    /import\s+type\s*\{[^}]*\bSkillSummary\b[^}]*\}\s*from\s*["']\.\/types["']/,
  );
});

test("client.listSkills calls /api/skills via the shared api() helper", () => {
  assert.match(
    apiSrc,
    /listSkills\s*:\s*\(\)\s*=>\s*api<\{\s*skills\s*:\s*SkillSummary\[\]\s*\}>\(\s*["']\/api\/skills["']\s*\)/,
  );
});
