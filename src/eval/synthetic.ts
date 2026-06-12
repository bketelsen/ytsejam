/**
 * Synthetic conversation fixtures in ytsejam's session JSONL format (pi v3).
 *
 * A seeded generator builds a multi-month corpus for one persona: facts and
 * preferences are planted at known turns among realistic distractor chatter,
 * and ground truth records exactly where everything lives so the eval
 * harness can score recall and personality mirroring. Fully deterministic
 * per seed.
 */

import fs from "node:fs";
import path from "node:path";

// -- seeded PRNG -------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -- persona -------------------------------------------------------------------

export interface PlantedFact {
  key: string;
  statement: string;
  probe: string;
  /**
   * A second probe that intentionally shares NO content words with the
   * statement — measures retrieval beyond lexical overlap (PLAN.md Task 1.2).
   */
  paraphraseProbe: string;
  /** Substring whose presence in retrieved text counts as a hit. */
  answer: string;
}

export interface PlantedPreference {
  object: string;
  polarity: 1 | -1;
  statements: string[];
}

export interface PlantedDirective {
  object: string;
  polarity: 1 | -1;
  statement: string;
}

export interface PlantedContradiction {
  object: string;
  firstStatement: string;
  flipStatement: string;
  finalPolarity: 1 | -1;
}

export interface Persona {
  userName: string;
  identityStatement: string;
  facts: PlantedFact[];
  preferences: PlantedPreference[];
  directives: PlantedDirective[];
  contradictions: PlantedContradiction[];
}

export const DEFAULT_PERSONA: Persona = {
  userName: "Brian",
  identityStatement: "By the way, my name is Brian.",
  facts: [
    {
      key: "sister-name",
      statement: "My sister Alice is visiting next month, so I want to plan something.",
      probe: "What is my sister's name?",
      paraphraseProbe: "Tell me about my sibling.",
      answer: "Alice",
    },
    {
      key: "dog-name",
      statement: "I had to take my dog Biscuit to the vet this morning.",
      probe: "What's my dog called?",
      paraphraseProbe: "What is my canine companion's name?",
      answer: "Biscuit",
    },
    {
      key: "employer",
      statement: "I work at Initech on the platform team.",
      probe: "Where do I work?",
      paraphraseProbe: "Where am I currently employed?",
      answer: "Initech",
    },
    {
      key: "home-city",
      statement: "Here in Boulder where I live, the weather has been wild lately.",
      probe: "Which city do I live in?",
      paraphraseProbe: "Which town am I based in?",
      answer: "Boulder",
    },
    {
      key: "project-name",
      statement: "I am working on Chapterhouse, my side project for archiving newsletters.",
      probe: "What is the name of my side project about newsletters?",
      paraphraseProbe: "What's the hobby codebase I keep tinkering with?",
      answer: "Chapterhouse",
    },
    {
      key: "allergy",
      statement: "Remember that I am allergic to peanuts when suggesting recipes.",
      probe: "What food am I allergic to?",
      paraphraseProbe: "Which food can't I safely eat?",
      answer: "peanut",
    },
    {
      key: "guitar",
      statement: "I picked up my old Telecaster again and started practicing guitar.",
      probe: "Which guitar do I play?",
      paraphraseProbe: "Which instrument do I noodle on in the evenings?",
      answer: "Telecaster",
    },
    {
      key: "marathon",
      statement: "Training for the Denver marathon is going slowly but steadily.",
      probe: "Which marathon am I training for?",
      paraphraseProbe: "What big race am I preparing for?",
      answer: "Denver",
    },
  ],
  preferences: [
    {
      object: "TypeScript",
      polarity: 1,
      statements: [
        "I really like TypeScript for anything bigger than a script.",
        "I prefer TypeScript over plain JavaScript for new services.",
        "Honestly I love TypeScript's strict mode once it's set up.",
      ],
    },
    {
      object: "dark roast coffee",
      polarity: 1,
      statements: [
        "I love dark roast coffee, the darker the better.",
        "I really enjoy dark roast coffee in the morning.",
      ],
    },
    {
      object: "meetings before noon",
      polarity: -1,
      statements: [
        "I hate meetings before noon, I can never focus.",
        "I really dislike meetings before noon.",
      ],
    },
    {
      object: "vim",
      polarity: 1,
      statements: [
        "I prefer vim keybindings everywhere I can get them.",
        "I still prefer vim keybindings, even in the browser.",
      ],
    },
  ],
  directives: [
    { object: "answer in metric units", polarity: 1, statement: "Please always answer in metric units." },
    { object: "use emojis in your replies", polarity: -1, statement: "Please never use emojis in your replies." },
  ],
  contradictions: [
    {
      object: "tabs for indentation",
      firstStatement: "I like tabs for indentation, by the way.",
      flipStatement: "Actually I changed my mind, I really dislike tabs for indentation now.",
      finalPolarity: -1,
    },
  ],
};

// -- distractors ----------------------------------------------------------------

const DISTRACTOR_TOPICS = [
  "debug a flaky integration test in the payments service",
  "write a regex that matches semantic version strings",
  "explain the difference between processes and threads",
  "draft a polite reply to a recruiter email",
  "summarize an article about container networking",
  "figure out why the staging deploy is slow",
  "convert a CSV of expenses into a markdown table",
  "explain how DNS resolution works step by step",
  "review a SQL query that joins three tables",
  "brainstorm names for an internal metrics dashboard",
  "fix a CSS layout bug on a settings page",
  "compare two libraries for parsing YAML",
  "outline a talk about incident retrospectives",
  "untangle a git rebase that went sideways",
  "estimate cloud costs for a small Postgres cluster",
  "translate an error message from a Rust compiler",
  "plan a weekend hike with reasonable mileage",
  "draft an agenda for the platform sync",
  "explain what a bloom filter is good for",
  "tighten up a flabby paragraph in a design doc",
];

const ASSISTANT_OPENERS = [
  "Sure — here's how I'd approach it.",
  "Happy to help with that.",
  "Good question, let's break it down.",
  "Here's a first pass.",
  "That makes sense, let's work through it.",
];

// -- generation -------------------------------------------------------------------

export interface GroundTruthFact extends PlantedFact {
  sessionId: string;
  entryId: string;
  sessionIndex: number;
}

export interface GroundTruth {
  facts: GroundTruthFact[];
  preferences: { object: string; polarity: 1 | -1; firstSessionIndex: number }[];
  directives: { object: string; polarity: 1 | -1 }[];
  contradictions: { object: string; finalPolarity: 1 | -1; flipSessionIndex: number }[];
  userName: string;
  sessionIds: string[];
  /** ISO start timestamp of each session, index-aligned with sessionIds. */
  sessionStarts: string[];
  /** Days between session starts. */
  intervalDays: number;
  /** ISO timestamp just after the last session; "now" for the eval. */
  horizonEnd: string;
}

export interface GenerateOptions {
  outDir: string;
  persona?: Persona;
  seed?: number;
  sessions?: number;
  turnsPerSession?: number;
  /** First session date (ISO). */
  startDate?: string;
  /** Days between sessions. */
  intervalDays?: number;
}

interface Plant {
  text: string;
  /** Position in the corpus: which session this lands in. */
  sessionIndex: number;
  tag?: { kind: "fact"; key: string };
}

export function generateFixtures(opts: GenerateOptions): GroundTruth {
  const persona = opts.persona ?? DEFAULT_PERSONA;
  const seed = opts.seed ?? 42;
  const sessions = opts.sessions ?? 12;
  const turnsPerSession = opts.turnsPerSession ?? 12;
  const startMs = Date.parse(opts.startDate ?? "2026-01-05T09:00:00.000Z");
  const intervalMs = (opts.intervalDays ?? 14) * 24 * 60 * 60 * 1000;
  const rand = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  fs.mkdirSync(opts.outDir, { recursive: true });

  // Schedule plants across sessions: identity + facts early-to-mid,
  // preference statements spread out (repetition), contradiction flip late.
  const plants: Plant[] = [];
  plants.push({ text: persona.identityStatement, sessionIndex: 0 });
  persona.facts.forEach((fact, i) => {
    plants.push({
      text: fact.statement,
      sessionIndex: Math.floor((i / persona.facts.length) * (sessions * 0.6)),
      tag: { kind: "fact", key: fact.key },
    });
  });
  const prefFirstSession = new Map<string, number>();
  for (const pref of persona.preferences) {
    pref.statements.forEach((statement, j) => {
      const sessionIndex = Math.min(
        sessions - 1,
        Math.floor((j / pref.statements.length) * sessions) + (j === 0 ? 1 : 0),
      );
      const prev = prefFirstSession.get(pref.object);
      if (prev === undefined || sessionIndex < prev) prefFirstSession.set(pref.object, sessionIndex);
      plants.push({ text: statement, sessionIndex });
    });
  }
  for (const directive of persona.directives) {
    plants.push({ text: directive.statement, sessionIndex: 1 + Math.floor(rand() * 2) });
  }
  const flipSessionIndex = sessions - 2;
  for (const c of persona.contradictions) {
    plants.push({ text: c.firstStatement, sessionIndex: 1 });
    plants.push({ text: c.flipStatement, sessionIndex: flipSessionIndex });
  }

  const truth: GroundTruth = {
    facts: [],
    preferences: persona.preferences.map((p) => ({
      object: p.object,
      polarity: p.polarity,
      firstSessionIndex: prefFirstSession.get(p.object) ?? 0,
    })),
    directives: persona.directives.map((d) => ({ object: d.object, polarity: d.polarity })),
    contradictions: persona.contradictions.map((c) => ({
      object: c.object,
      finalPolarity: c.finalPolarity,
      flipSessionIndex,
    })),
    userName: persona.userName,
    sessionIds: [],
    sessionStarts: [],
    intervalDays: opts.intervalDays ?? 14,
    horizonEnd: new Date(startMs + (sessions - 1) * intervalMs + 24 * 60 * 60 * 1000).toISOString(),
  };

  let idCounter = 0;
  const nextId = () => {
    // uuidv7-prefix-shaped 8-char hex ids, deterministic.
    idCounter++;
    return (0x10000000 + idCounter * 2654435761) .toString(16).slice(0, 8);
  };

  for (let s = 0; s < sessions; s++) {
    const sessionId = `00000000-0000-7000-8000-${String(s).padStart(12, "0")}`;
    truth.sessionIds.push(sessionId);
    const sessionStart = startMs + s * intervalMs;
    truth.sessionStarts.push(new Date(sessionStart).toISOString());
    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(sessionStart).toISOString(),
        cwd: "/home/user",
      }),
    );

    const sessionPlants = plants.filter((p) => p.sessionIndex === s);
    // Plants are interleaved among distractor turns at deterministic slots.
    const userTurnCount = Math.max(turnsPerSession, sessionPlants.length * 2);
    const plantSlots = new Map<number, Plant[]>();
    sessionPlants.forEach((plant, i) => {
      const slot = Math.floor(((i + 0.5) / sessionPlants.length) * userTurnCount);
      const arr = plantSlots.get(slot) ?? [];
      arr.push(plant);
      plantSlots.set(slot, arr);
    });

    let parentId: string | null = null;
    let t = 0;
    const appendMessage = (role: "user" | "assistant", text: string): string => {
      const id = nextId();
      const timestamp = new Date(sessionStart + t * 90_000).toISOString();
      t++;
      lines.push(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp,
          message:
            role === "user"
              ? { role, content: text, timestamp: sessionStart + t * 90_000 }
              : {
                  role,
                  content: [{ type: "text", text }],
                  model: "synthetic-1",
                  stopReason: "stop",
                  timestamp: sessionStart + t * 90_000,
                },
        }),
      );
      parentId = id;
      return id;
    };

    for (let u = 0; u < userTurnCount; u++) {
      const topic = pick(DISTRACTOR_TOPICS);
      let userText = `Can you help me ${topic}?`;
      const here = plantSlots.get(u) ?? [];
      for (const plant of here) {
        userText = `${plant.text} Also, can you help me ${topic}?`;
        const entryId = appendMessage("user", userText);
        if (plant.tag?.kind === "fact") {
          const fact = (opts.persona ?? DEFAULT_PERSONA).facts.find((f) => f.key === plant.tag!.key)!;
          truth.facts.push({ ...fact, sessionId, entryId, sessionIndex: s });
        }
        appendMessage("assistant", `${pick(ASSISTANT_OPENERS)} Let's look at how to ${topic}.`);
      }
      if (here.length === 0) {
        appendMessage("user", userText);
        appendMessage("assistant", `${pick(ASSISTANT_OPENERS)} Let's look at how to ${topic}.`);
      }
    }

    fs.writeFileSync(path.join(opts.outDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  fs.writeFileSync(
    path.join(opts.outDir, "ground-truth.json"),
    JSON.stringify(truth, null, 2),
  );
  return truth;
}
