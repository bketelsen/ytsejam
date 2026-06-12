import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/api/memory-system.ts";
import { writeScriptedSession, type ScriptedTurn } from "../src/eval/adversarial.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ltm-adv-"));
}

const NOW = "2026-04-20T00:00:00.000Z";

async function systemWith(turns: ScriptedTurn[], sessionId = "adv00000-0000-7000-8000-000000000001") {
  const dir = tmpDir();
  const { filePath } = writeScriptedSession({ dir: path.join(dir, "sessions"), sessionId, turns });
  const mem = MemorySystem.open({ storeDir: path.join(dir, "store"), now: () => NOW });
  await mem.ingestSessionFile(filePath);
  return mem;
}

describe("adversarial scenarios (PLAN 3.1)", () => {
  it("overlapping preference objects stay distinct, not collapsed", async () => {
    const mem = await systemWith([
      { text: "I love dark roast coffee." },
      { text: "I like dark roast, generally." },
      { text: "I prefer vim keybindings in every editor." },
      { text: "I really like vim." },
    ]);
    const prefs = mem.profile().preferences.map((f) => f.objectNorm);
    expect(prefs).toContain("dark roast coffee");
    expect(prefs).toContain("dark roast");
    expect(prefs).toContain("vim keybindings in every editor");
    expect(prefs).toContain("vim");
    expect(new Set(prefs).size).toBe(prefs.length);
  });

  it("a preference and a contradicting directive coexist; the directive governs behavior", async () => {
    const mem = await systemWith([
      { text: "I love emojis." },
      { text: "Please never use emojis in your replies." },
    ]);
    const profile = mem.profile();
    // No silent merge: the liking survives as a preference…
    expect(profile.preferences.some((f) => f.objectNorm.includes("emojis") && f.polarity === 1)).toBe(true);
    // …and the behavior question is answered by the standing directive.
    const directive = profile.directives.find((f) => f.objectNorm.includes("emojis"));
    expect(directive).toBeDefined();
    expect(directive!.polarity).toBe(-1);
    // composeContext keeps directives in their own block, after preferences.
    const context = await mem.composeContext("write me a reply", { dryRun: true });
    expect(context).toContain("Standing instructions:");
    expect(context.indexOf("Standing instructions:")).toBeGreaterThan(context.indexOf("emojis"));
  });

  it("state → contradict → re-state: the re-statement revives and wins", async () => {
    const mem = await systemWith([
      { text: "I like tabs for indentation.", dayOffset: 0 },
      { text: "Actually, I dislike tabs for indentation.", dayOffset: 2 },
      { text: "You know what, I like tabs for indentation after all.", dayOffset: 4 },
    ]);
    const tabs = mem.profile().preferences.filter((f) => f.objectNorm.includes("tabs"));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].polarity).toBe(1);
    // The contradicted negative is superseded, not deleted (audit trail).
    const all = mem.listFacts().filter((f) => f.objectNorm.includes("tabs"));
    expect(all.some((f) => f.polarity === -1 && f.supersededBy)).toBe(true);
  });

  it("a high-frequency entity with no fact attached tops entities but never enters the preference profile", async () => {
    const turns: ScriptedTurn[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push({ text: `The Grafana dashboard flaked again on run ${i}.` });
      turns.push({ text: "Looking into it.", role: "assistant" });
    }
    const mem = await systemWith(turns);
    const profile = mem.profile();
    expect(profile.topEntities.some((e) => e.norm === "grafana")).toBe(true);
    expect(mem.listEntities().find((e) => e.norm === "grafana")!.mentionCount).toBeGreaterThanOrEqual(50);
    expect(profile.preferences.some((f) => f.objectNorm.includes("grafana"))).toBe(false);
    expect(profile.attributes.some((f) => f.objectNorm.includes("grafana"))).toBe(false);
  });

  it("a near-empty turn before a high-salience fact does not mask it", async () => {
    const mem = await systemWith([
      { text: "ok" },
      { text: "Important: my insulin prescription number is RX-77812." },
      { text: "thanks!" },
    ]);
    const { items } = await mem.retrieve("What is my prescription number?", { k: 3, dryRun: true });
    expect(items.some((i) => i.record.text.includes("RX-77812"))).toBe(true);
    // The filler turns scored near-zero salience.
    const filler = mem.listEpisodic().find((r) => r.text === "ok");
    expect(filler!.salience).toBeLessThanOrEqual(0.1);
  });
});
