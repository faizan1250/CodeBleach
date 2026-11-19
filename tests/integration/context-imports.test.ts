import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImportsForFile } from "../../src/context/imports.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import { commitIndex, git, makeRepo } from "../helpers/git-repo.ts";

async function writeIndexed(dir: string, outside: string, repoPath: string, content: string): Promise<void> {
  const staging = join(outside, Buffer.from(repoPath).toString("hex"));
  await writeFile(staging, content);
  const blob = await git(dir, ["hash-object", "-w", staging]);
  await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${repoPath}`]);
}

async function setupRepo(files: Record<string, string>): Promise<{
  dir: string;
  outside: string;
  cleanup: () => Promise<void>;
  commit: string;
}> {
  const { dir, cleanup } = await makeRepo();
  const outside = await mkdtemp(join(tmpdir(), "codebleach-imp-"));
  const cleanupBoth = async (): Promise<void> => {
    await rm(outside, { recursive: true, force: true });
    await cleanup();
  };
  try {
    for (const [repoPath, content] of Object.entries(files)) {
      await writeIndexed(dir, outside, repoPath, content);
    }
    const commit = await commitIndex(dir, "head");
    return { dir, outside, cleanup: cleanupBoth, commit };
  } catch (error) {
    await cleanupBoth();
    throw error;
  }
}

function readerFor(dir: string, commit: string): SnapshotReader {
  return new SnapshotReader({ repoRoot: dir, headSha: commit, mergeBase: commit });
}

describe("context relative imports from commit snapshots", () => {
  test("named, default, namespace, type-only, and side-effect imports resolve", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'import { greet } from "./util";\nimport make from "./def";\nimport * as ns from "./ns";\nimport type { Props } from "./types";\nimport "./setup";\n',
      "src/util.ts": "export function greet(): string {\n  return 'hi';\n}\n",
      "src/def.ts": "export default function make(): void {}\n",
      "src/ns.ts": "export function a(): void {}\nexport function b(): void {}\n",
      "src/types.ts": "export interface Props {\n  name: string;\n}\n",
      "src/setup.ts": "globalThis.__setup = true;\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      const bySpecifier = new Map(resolved.map((entry) => [entry.specifier, entry]));
      expect(bySpecifier.get("./util")).toMatchObject({
        targetPath: "src/util.ts",
        kind: "named",
        reason: "relative named import",
      });
      expect(bySpecifier.get("./util")?.definition).toMatchObject({ name: "greet" });
      expect(bySpecifier.get("./def")).toMatchObject({ targetPath: "src/def.ts", kind: "default" });
      expect(bySpecifier.get("./def")?.definition).toMatchObject({ name: "make" });
      const nsEntry = bySpecifier.get("./ns");
      expect(nsEntry).toMatchObject({ targetPath: "src/ns.ts", kind: "namespace" });
      expect(nsEntry?.definition).toBeNull();
      expect([...(nsEntry?.availableExports ?? [])]).toEqual(["a", "b"]);
      expect(bySpecifier.get("./types")?.definition).toMatchObject({ name: "Props" });
      const sideEffect = bySpecifier.get("./setup");
      expect(sideEffect).toMatchObject({ targetPath: "src/setup.ts", kind: "side-effect" });
      expect(sideEffect?.definition).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("extension-omitted and index-file candidates resolve", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { w } from "./widgets";\nimport { h } from "./helper.ts";\n',
      "src/widgets/index.ts": "export function w(): void {}\n",
      "src/helper.ts": "export function h(): void {}\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      const bySpecifier = new Map(resolved.map((entry) => [entry.specifier, entry]));
      expect(bySpecifier.get("./widgets")).toMatchObject({ targetPath: "src/widgets/index.ts" });
      expect(bySpecifier.get("./widgets")?.definition).toMatchObject({ name: "w" });
      expect(bySpecifier.get("./helper.ts")).toMatchObject({ targetPath: "src/helper.ts" });
    } finally {
      await cleanup();
    }
  });

  test("re-export chain resolves to the ultimate definition", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { x } from "./barrel";\n',
      "src/barrel.ts": 'export { x } from "./real";\n',
      "src/real.ts": "export function x(): number {\n  return 1;\n}\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ targetPath: "src/real.ts", reason: "relative named re-export" });
      expect(resolved[0]?.definition).toMatchObject({ name: "x" });
    } finally {
      await cleanup();
    }
  });

  test("unresolved, package, and escaping imports yield diagnostics without throwing", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts":
        'import { nope } from "./missing";\nimport React from "react";\nimport { evil } from "../../evil";\nimport { ok } from "./ok";\n',
      "src/ok.ts": "export function ok(): void {}\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      expect(resolved.map((entry) => entry.specifier)).toEqual(["./ok"]);
      const bySpecifier = new Map(diagnostics.map((entry) => [entry.specifier, entry.reason]));
      expect(bySpecifier.get("./missing")).toBe("not-found");
      expect(bySpecifier.get("react")).toBe("package-import");
      expect(bySpecifier.get("../../evil")).toBe("outside-repo");
    } finally {
      await cleanup();
    }
  });

  test("imported target is read from headSha, not the worktree", async () => {
    const { dir, cleanup } = await makeRepo();
    const outside = await mkdtemp(join(tmpdir(), "codebleach-imp-"));
    try {
      await writeIndexed(dir, outside, "src/a.ts", 'import { v } from "./b";\n');
      await writeIndexed(dir, outside, "src/b.ts", "export function v(): number {\n  return 1;\n}\n");
      const commit = await commitIndex(dir, "head");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "b.ts"), "export function v(): number {\n  return 2;\n}\n");
      const { resolved } = await resolveImportsForFile({
        importerPath: "src/a.ts",
        reader: readerFor(dir, commit),
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.targetPath).toBe("src/b.ts");
      expect(resolved[0]?.definition).toMatchObject({ name: "v" });
      expect(JSON.stringify(resolved[0]?.definition)).toContain("return 1;");
    } finally {
      await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("only the relevant declaration is returned from an export-heavy module", async () => {
    const many = Array.from({ length: 20 }, (_, index) => `export function f${index}(): void {}`).join("\n");
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { f7 } from "./many";\n',
      "src/many.ts": `${many}\n`,
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.definition).toMatchObject({ name: "f7" });
    } finally {
      await cleanup();
    }
  });

  test("star re-export resolves when unambiguous and omits when ambiguous", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { single } from "./one-star";\nimport { clash } from "./two-star";\n',
      "src/one-star.ts": 'export * from "./real-one";\n',
      "src/real-one.ts": "export function single(): void {}\n",
      "src/two-star.ts": 'export * from "./left";\nexport * from "./right";\n',
      "src/left.ts": "export function clash(): number {\n  return 1;\n}\n",
      "src/right.ts": "export function clash(): number {\n  return 2;\n}\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      const bySpecifier = new Map(resolved.map((entry) => [entry.specifier, entry]));
      expect(bySpecifier.get("./one-star")).toMatchObject({ targetPath: "src/real-one.ts" });
      expect(bySpecifier.get("./one-star")?.definition).toMatchObject({ name: "single" });
      expect(bySpecifier.has("./two-star")).toBe(false);
      expect(diagnostics).toEqual([
        { importerPath: "src/app.ts", specifier: "./two-star", reason: "ambiguous-reexport" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("default re-exported under an alias resolves", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import make from "./barrel";\n',
      "src/barrel.ts": 'export { make as default } from "./impl";\n',
      "src/impl.ts": "export function make(): void {}\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
      });
      expect(diagnostics).toEqual([]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        targetPath: "src/impl.ts",
        reason: "relative default re-export",
      });
      expect(resolved[0]?.definition).toMatchObject({ name: "make" });
    } finally {
      await cleanup();
    }
  });

  test("per-file cap stops with a diagnostic", async () => {
    const { dir, cleanup, commit } = await setupRepo({
      "src/app.ts": 'import { a } from "./a";\nimport { b } from "./b";\n',
      "src/a.ts": "export function a(): void {}\n",
      "src/b.ts": "export function b(): void {}\n",
    });
    try {
      const { resolved, diagnostics } = await resolveImportsForFile({
        importerPath: "src/app.ts",
        reader: readerFor(dir, commit),
        maxResolved: 1,
      });
      expect(resolved.map((entry) => entry.specifier)).toEqual(["./a"]);
      expect(diagnostics).toEqual([
        { importerPath: "src/app.ts", specifier: "./b", reason: "cap-reached" },
      ]);
    } finally {
      await cleanup();
    }
  });
});
