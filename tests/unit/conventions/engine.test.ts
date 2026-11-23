import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../../src/config/schema.ts";
import type { DiffResult } from "../../../src/types/index.ts";
import { ConventionEngineImpl } from "../../../src/conventions/engine.ts";
import { git, makeRepo } from "../../helpers/git-repo.ts";

const NAMED_MODULE = (marker: string): string =>
  `// ${marker}\nexport function alpha(): number {\n  return 1;\n}\nexport const beta = 2;\n`;

async function seedRepo(fileCount: number): Promise<{
  dir: string;
  base: string;
  head: string;
  cleanup: () => Promise<void>;
}> {
  const { dir, cleanup } = await makeRepo();
  try {
    for (let index = 0; index < fileCount; index += 1) {
      const full = join(dir, `src/mod-${index}.ts`);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, NAMED_MODULE(`mod-${index}`));
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base", "--quiet"]);
    const base = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "src/mod-0.ts"), `${NAMED_MODULE("mod-0")}\nexport const extra = 3;\n`);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "head", "--quiet"]);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    return { dir, base, head, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function diffFor(base: string, head: string, touched: string): DiffResult {
  return {
    baseSha: base,
    headSha: head,
    mergeBase: base,
    files: [
      {
        path: touched,
        oldPath: null,
        status: "modified",
        language: "typescript",
        hunks: [],
        commentableLines: [],
        symbols: [],
      },
    ],
  };
}

describe("convention engine build", () => {
  test("discovers baseline conventions excluding every touched path", async () => {
    const repo = await seedRepo(6);
    try {
      const engine = new ConventionEngineImpl();
      const config = ConfigFileSchema.parse({});
      const result = await engine.build({
        repoDir: repo.dir,
        diff: diffFor(repo.base, repo.head, "src/mod-0.ts"),
        config,
      });
      const naming = result.conventions.filter((convention) => convention.detector === "naming-exports");
      expect(naming).toHaveLength(1);
      expect(naming[0]?.matchingFiles).toBe(5);
      expect(naming[0]?.id.startsWith("inf-")).toBe(true);
      expect(result.diagnostics.sampledFiles).toBeGreaterThanOrEqual(5);
      expect(result.diagnostics.conventions).toBe(result.conventions.length);
    } finally {
      await repo.cleanup();
    }
  });

  test("returns empty conventions with codes when nothing is eligible", async () => {
    const repo = await seedRepo(1);
    try {
      const engine = new ConventionEngineImpl();
      const config = ConfigFileSchema.parse({});
      const result = await engine.build({
        repoDir: repo.dir,
        diff: diffFor(repo.base, repo.head, "src/mod-0.ts"),
        config,
      });
      expect(result.conventions).toEqual([]);
      expect(result.diagnostics.conventions).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("fails open to empty conventions on snapshot failure", async () => {
    const engine = new ConventionEngineImpl();
    const config = ConfigFileSchema.parse({});
    const result = await engine.build({
      repoDir: "/nonexistent-codebleach-repo",
      diff: { baseSha: "a".repeat(40), headSha: "b".repeat(40), mergeBase: "a".repeat(40), files: [] },
      config,
    });
    expect(result.conventions).toEqual([]);
    expect(result.diagnostics.codes.length).toBeGreaterThan(0);
  });

  test("propagates caller abort instead of failing open", async () => {
    const repo = await seedRepo(6);
    try {
      const engine = new ConventionEngineImpl();
      const config = ConfigFileSchema.parse({});
      const controller = new AbortController();
      controller.abort();
      let thrown: unknown;
      try {
        await engine.build({
          repoDir: repo.dir,
          diff: diffFor(repo.base, repo.head, "src/mod-0.ts"),
          config,
          signal: controller.signal,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { name?: string }).name).toBe("AbortError");
    } finally {
      await repo.cleanup();
    }
  });
});
