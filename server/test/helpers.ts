import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type Model } from "@earendil-works/pi-ai";
import { EventBus } from "../src/events.ts";
import { Indexer } from "../src/indexer.ts";
import { AgentManager } from "../src/manager.ts";
import { PersonaStore } from "../src/persona.ts";

export function setupFaux() {
  const faux = registerFauxProvider();
  return faux;
}

export function makeManager(faux: ReturnType<typeof registerFauxProvider>) {
  const dataDir = mkdtempSync(join(tmpdir(), "ytsejam-"));
  const indexer = new Indexer(join(dataDir, "index.db"));
  const bus = new EventBus();
  const fauxModel = faux.getModel() as Model<any>;
  const manager = new AgentManager({
    dataDir,
    indexer,
    bus,
    persona: new PersonaStore(join(dataDir, "persona")),
    resolveModel: () => fauxModel,
    defaultModel: "faux/faux",
    tools: [],
    generateTitles: false,
  });
  return { manager, indexer, bus, dataDir };
}

export { fauxAssistantMessage };
