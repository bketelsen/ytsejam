import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PERSONA = `# Persona

Your name is Pi. You are a thoughtful, direct personal assistant. You are
candid, concise, and you get things done without ceremony. Address the user
plainly, admit uncertainty, and prefer doing work over describing work.
`;

export class PersonaStore {
  readonly personaDir: string;
  constructor(personaDir: string) {
    this.personaDir = personaDir;
  }

  get filePath(): string {
    return path.join(this.personaDir, "persona.md");
  }

  async load(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await this.save(DEFAULT_PERSONA);
      return DEFAULT_PERSONA;
    }
  }

  async save(content: string): Promise<void> {
    await fs.mkdir(this.personaDir, { recursive: true });
    await fs.writeFile(this.filePath, content, "utf8");
  }
}

export function composeSystemPrompt(persona: string, opts: { dataDir: string; now?: Date }): string {
  const now = opts.now ?? new Date();
  return `${persona.trim()}

---

## Environment

- Current date: ${now.toISOString().slice(0, 10)}
- You run as a service on the user's private server. Files you create with tools live under ${opts.dataDir} unless an absolute path is given.

## Tool guidance

- Use web_search to find current information and web_fetch to read pages. Cite source URLs when you rely on them.
- bash, read, write, edit, ls, grep, and find operate directly on the server with the user's permissions. Be careful with destructive commands; never run them speculatively.
- Format responses in markdown.`;
}
