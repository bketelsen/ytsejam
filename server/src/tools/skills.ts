import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SkillsStore } from "../skills.ts";

const skillParams = Type.Object({
  name: Type.String({ description: "skill name from the Skills table" }),
});

export function createSkillTool(store: SkillsStore): AgentTool<typeof skillParams> {
  return {
    name: "skill",
    label: "Load skill",
    description:
      "Load a skill playbook by name and follow its instructions. Use when the user types /name or when the conversation matches a skill's invoke-when condition.",
    parameters: skillParams,
    execute: async (_id, params) => {
      const content = await store.load(params.name);
      return { content: [{ type: "text", text: content }], details: {} };
    },
  };
}
