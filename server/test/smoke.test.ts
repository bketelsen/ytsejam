import { expect, test } from "vitest";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pi packages load and create a JSONL session", async () => {
  const root = mkdtempSync(join(tmpdir(), "ytsejam-smoke-"));
  const env = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
  const session = await repo.create({ cwd: "chat" });
  const meta = await session.getMetadata();
  expect(meta.id).toBeTruthy();
  expect((await repo.list({ cwd: "chat" })).length).toBe(1);
});
