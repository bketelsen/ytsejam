import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { EventBus } from "./events.ts";
import { Indexer } from "./indexer.ts";
import { AgentManager } from "./manager.ts";
import { resolveModel } from "./models.ts";
import { PiAuthStore } from "./pi-auth.ts";
import { PersonaStore } from "./persona.ts";
import { createApp } from "./server.ts";
import { createTools } from "./tools/index.ts";

const config = loadConfig();

// Ensure dataDir exists before sqlite tries to create its file
fs.mkdirSync(config.dataDir, { recursive: true });

const authStore = new PiAuthStore(config.piAuthPath);
const indexer = new Indexer(path.join(config.dataDir, "index.db"));
const bus = new EventBus();
const persona = new PersonaStore(path.join(config.dataDir, "persona"));
const manager = new AgentManager({
  dataDir: config.dataDir,
  indexer,
  bus,
  persona,
  resolveModel: (ref) => resolveModel(ref, authStore),
  defaultModel: config.defaultModel,
  tools: createTools(config.dataDir),
  generateTitles: config.generateTitles,
  authStore,
});

// sqlite is derived: rebuild from JSONL on boot so offline JSONL edits are reflected
await manager.rebuildIndex();

const { app, injectWebSocket } = createApp({ manager, indexer, bus, persona, config, authStore });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ytsejam listening on http://localhost:${info.port}`);
  console.log(`data dir: ${config.dataDir}`);
});
injectWebSocket(server);
