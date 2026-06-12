import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { Controller, loadManifest } from "../../src/memory/index.ts";

const goodManifest = `version: 1
domains:
  - id: personal
    path: personal
    label: Personal
    triggers: [personal, home]
    files: [hot-memory, action-items, observations, entities]
  - id: work
    path: work/acme
    label: Acme
    files: [hot-memory, action-items]
    subdomains:
      - id: work-sub
        path: work/acme/team
        files: [observations]
  - id: cog-meta
    path: cog-meta
    files: [patterns, improvements]
`;

const nestedProjectsManifest = `version: 1
domains:
  - id: projects
    path: projects
    files: [hot-memory, observations]
    subdomains:
      - id: chapterhouse
        path: projects/chapterhouse
        files: [hot-memory, observations]
`;

const tempRoot = (body?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "ytsejam-domain-"));
  if (body !== undefined) writeFileSync(join(dir, "domains.yml"), body);
  return dir;
};
const bumpManifest = (dir: string, body: string) => {
  writeFileSync(join(dir, "domains.yml"), body);
  const t = new Date(Date.now() + 1000);
  utimesSync(join(dir, "domains.yml"), t, t);
};

describe("memory domain controller", () => {
  test("loadManifest parses manifest happy path", () => {
    const domains = loadManifest(tempRoot(goodManifest));
    expect(domains.map((d) => d.id)).toEqual(["personal", "work", "cog-meta"]);
    expect(domains[0]).toMatchObject({ path: "personal", label: "Personal", triggers: ["personal", "home"] });
    expect(domains[1].subdomains?.[0]).toMatchObject({ id: "work-sub", path: "work/acme/team" });
  });

  test("loadManifest treats null domains as an empty registry", () => {
    for (const body of ["domains:\n", "domains: null\n", "domains: ~\n"]) {
      expect(loadManifest(tempRoot(body))).toEqual([]);
      const c = new Controller(tempRoot(body));
      expect(c.list()).toEqual([]);
      expect(c.lastError).toBeNull();
    }
  });

  test("ControllerLoadAndList", () => {
    const c = new Controller(tempRoot(goodManifest));
    const ds = c.list();
    expect(ds.map((d) => d.id)).toEqual(["personal", "work", "work-sub", "cog-meta"]);
    expect(ds[1].subdomains).toHaveLength(1);
  });

  test("ControllerGetIncludesSubdomains", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.get("work-sub").path).toBe("work/acme/team");
    expect(() => c.get("nope")).toThrow(/unknown id/);
  });

  test("ControllerObservationsResolves", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.observations().map((t) => `${t.domain}:${t.path}`)).toEqual([
      "personal:personal/observations.md",
      "work-sub:work/acme/team/observations.md",
    ]);
  });

  test("ControllerActionItemsResolves", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.actionItems().map((t) => `${t.domain}:${t.path}`)).toEqual([
      "personal:personal/action-items.md",
      "work:work/acme/action-items.md",
    ]);
  });

  test("ControllerActionItemsObservationsEntities domain filter", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.actionItems("work")).toEqual([{ domain: "work", path: "work/acme/action-items.md", file: "action-items" }]);
    expect(c.observations("personal")).toEqual([{ domain: "personal", path: "personal/observations.md", file: "observations" }]);
    expect(c.entities("personal")).toEqual([{ domain: "personal", path: "personal/entities.md", file: "entities" }]);
  });

  test("ControllerResolveFile", () => {
    const root = tempRoot(goodManifest);
    const c = new Controller(root);
    expect(c.resolveFile("personal", "action-items")).toBe(resolve(root, "personal/action-items.md"));
    expect(() => c.resolveFile("personal", "nope")).toThrow(/does not declare file/);
  });

  test("ControllerDomainForPath", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.domainForPath("work/acme/team/observations.md")).toEqual({ domain: "work-sub", file: "observations", ok: true });
    expect(c.domainForPath("work/acme/deeper/notes.md")).toEqual({ domain: "", file: "", ok: false });
    expect(c.domainForPath("scratch/foo.md")).toEqual({ domain: "", file: "", ok: false });
  });

  test("ControllerDomainForPath normalizes dot-dot segments", () => {
    const c = new Controller(tempRoot("domains:\n  - id: work\n    path: work\n    files: [action-items]\n"));
    expect(c.domainForPath("work/sub/../action-items.md")).toEqual({ domain: "work", file: "action-items", ok: true });
  });

  test("Controller rejects relative paths that escape root", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(() => c.domainForPath("../foo.md")).toThrow(/invalid path: escapes root: \.\.\/foo\.md/);
    expect(() => c.validateWrite("work/../../escape.md")).toThrow(/invalid path: escapes root: work\/\.\.\/\.\.\/escape\.md/);
  });

  test("ControllerDomainForPath strips dot segments", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.domainForPath("./personal/./hot-memory.md")).toEqual({ domain: "personal", file: "hot-memory", ok: true });
  });

  test("ControllerValidateWriteWarnsUnknown", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(() => c.validateWrite("personal/hot-memory.md")).not.toThrow();
    expect(() => c.validateWrite("personal/random.md")).toThrow(/domain "personal"/);
    expect(() => c.validateWrite("scratch/foo.md")).not.toThrow();
  });

  test("ControllerHotReloadOnMtimeChange", () => {
    const dir = tempRoot(goodManifest);
    const c = new Controller(dir);
    expect(c.list()).toHaveLength(4);
    bumpManifest(dir, "version: 1\ndomains:\n  - id: solo\n    path: solo\n    files: [hot-memory]\n");
    expect(c.list().map((d) => d.id)).toEqual(["solo"]);
    expect(c.lastError).toBeNull();
  });

  test("Controller hot-reload serves stale manifest and records parse error", () => {
    const dir = tempRoot(goodManifest);
    const c = new Controller(dir);
    bumpManifest(dir, "domains: [: not yaml\n");
    expect(c.list().map((d) => d.id)).toEqual(["personal", "work", "work-sub", "cog-meta"]);
    expect(c.lastError?.message).toMatch(/parse/);

    bumpManifest(dir, "version: 1\ndomains:\n  - id: recovery-domain\n    path: recovery\n    files: [hot-memory]\n");
    expect(c.list().map((d) => d.id)).toEqual(["recovery-domain"]);
    expect(c.lastError).toBeNull();
  });

  test("ControllerMalformedYAMLRejected", () => {
    expect(() => new Controller(tempRoot("domains: [: not yaml\n"))).toThrow(/parse/);
  });

  test("ControllerInvalidSchemaRejected", () => {
    const cases: Record<string, string> = {
      "duplicate-id": "domains:\n  - {id: a, path: a}\n  - {id: a, path: b}\n",
      "empty-id": "domains:\n  - {id: '', path: a}\n",
      "empty-path": "domains:\n  - {id: a, path: ''}\n",
      absolute: "domains:\n  - {id: a, path: /etc}\n",
      dotdot: "domains:\n  - {id: a, path: ../escape}\n",
      "bad-file": "domains:\n  - {id: a, path: a, files: ['hot-memory.md']}\n",
      "slash-file": "domains:\n  - {id: a, path: a, files: ['sub/file']}\n",
      "bad-subdomains": "domains:\n  - {id: a, path: a, subdomains: nope}\n",
    };
    for (const [name, body] of Object.entries(cases)) {
      expect(() => new Controller(tempRoot(body)), name).toThrow();
    }
  });

  test("ControllerMissingManifestEmpty", () => {
    const c = new Controller(tempRoot());
    expect(c.list()).toEqual([]);
    expect(c.lastError).toBeNull();
  });

  test("ControllerEntitiesResolves", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(c.entities()).toEqual([{ domain: "personal", path: "personal/entities.md", file: "entities" }]);
  });

  test("ControllerValidateWriteFlagsIDAsPath", () => {
    const c = new Controller(tempRoot(nestedProjectsManifest));
    expect(() => c.validateWrite("chapterhouse/INDEX.md")).toThrow(/domain id used as path.*projects\/chapterhouse/);
    expect(() => c.validateWrite("projects/chapterhouse/observations.md")).not.toThrow();
  });

  test("ControllerValidateWriteAllowsIDPrefixedPath", () => {
    const c = new Controller(tempRoot(goodManifest));
    expect(() => c.validateWrite("work/notes.md")).not.toThrow();
  });
});
