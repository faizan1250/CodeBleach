import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ContextEngineImpl } from "../../src/context/engine.ts";
import { SnapshotReader } from "../../src/context/snapshot.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";
import { emptyReviewResult } from "../fixtures/stubs.ts";

function logger() {
  return createLogger({ level: "error", runId: "p3-f02-test" });
}

async function writeAndCommit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", message, "--quiet"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const UTIL_BASE = "export function helper(x: number): number {\n  return x + 1;\n}\n";
const A_BASE =
  'import { helper } from "./util.ts";\n' +
  "export function f(x: number): number {\n" +
  "  return helper(x);\n" +
  "}\n";
const A_HEAD =
  'import { helper } from "./util.ts";\n' +
  "export function f(x: number): number {\n" +
  "  return helper(x + 1);\n" +
  "}\n";

async function buildTwoFileDiff(dir: string) {
  const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
  const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
  return { baseSha, headSha };
}

async function buildDiff(dir: string, base: Record<string, string>, head: Record<string, string>) {
  const baseSha = await writeAndCommit(dir, base, "base");
  const headSha = await writeAndCommit(dir, head, "head");
  return { baseSha, headSha };
}

function throwingCaller(message: string) {
  return async (): Promise<never> => {
    throw new ReviewerError({ code: "GIT_FAILED", message });
  };
}

describe("p3-f02 partial diagnostics", () => {
  test("clean change stays complete with no diagnostics", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      expect(result.status).toBe("complete");
      expect(result.units.length).toBeGreaterThan(0);
      expect(result.diagnostics.diagnostics).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("isolated symbol without callers stays complete", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const solo = "export function solo(): number {\n  return 1;\n}\n";
      const { baseSha, headSha } = await buildDiff(
        dir,
        { "src/solo.ts": solo },
        { "src/solo.ts": solo.replace("return 1", "return 2") },
      );
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      expect(result.status).toBe("complete");
      expect(result.units).toHaveLength(1);
      expect(result.diagnostics.diagnostics).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("caller failure is partial and preserves imports", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveCallersForSymbol: throwingCaller("injected caller boom") as never },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
      const unit = result.units.find((u) => u.symbol.name === "f");
      expect(unit).toBeDefined();
      expect(unit?.context.some((item) => item.kind === "definition")).toBe(true);
      expect(unit?.context.some((item) => item.kind === "definition" && item.file === "src/a.ts")).toBe(true);
      const diagnostic = result.diagnostics.diagnostics.find((d) => d.stage === "caller");
      expect(diagnostic).toMatchObject({ stage: "caller", path: "src/a.ts", symbol: "f" });
      expect(typeof diagnostic?.code).toBe("string");
    } finally {
      await cleanup();
    }
  });

  test("callee failure is partial and preserves definition", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveCalleesForSymbol: throwingCaller("injected callee boom") as never },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.status).toBe("partial");
      const unit = result.units.find((u) => u.symbol.name === "f");
      expect(unit).toBeDefined();
      expect(unit?.context.some((item) => item.kind === "definition")).toBe(true);
      expect(result.diagnostics.diagnostics.some((d) => d.stage === "callee" && d.path === "src/a.ts")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("import failure is partial and preserves definition", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveImportsForFile: throwingCaller("injected import boom") as never },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
      expect(result.units.some((u) => u.context.some((item) => item.kind === "definition"))).toBe(true);
      expect(result.diagnostics.diagnostics.some((d) => d.stage === "import" && d.path === "src/a.ts")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("test failure preserves imports and callees", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const clean = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveTestsForSymbol: throwingCaller("injected test boom") as never },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.status).toBe("partial");
      expect(result.units).toHaveLength(clean.units.length);
      const unit = result.units.find((u) => u.symbol.name === "f");
      expect(unit?.context.some((item) => item.kind === "definition")).toBe(true);
      expect(
        result.diagnostics.diagnostics.some((d) => d.stage === "test" && d.path === "src/a.ts" && d.symbol === "f"),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("snapshot read failure is partial with file and stage details", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const original = SnapshotReader.prototype.readHeadText;
      const seen = new Set<string>();
      SnapshotReader.prototype.readHeadText = async function (path: string): Promise<string> {
        if (seen.has(path)) throw new ReviewerError({ code: "GIT_FAILED", message: "injected snapshot boom" });
        seen.add(path);
        return original.call(this, path);
      };
      try {
        const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
        expect(result.status).toBe("partial");
        expect(result.units.length).toBeGreaterThan(0);
        const diagnostic = result.diagnostics.diagnostics.find((d) => d.stage === "snapshot");
        expect(diagnostic).toBeDefined();
        expect(diagnostic?.path).toBe("src/a.ts");
        expect(JSON.stringify(result.diagnostics)).not.toContain("injected snapshot boom");
      } finally {
        SnapshotReader.prototype.readHeadText = original;
      }
    } finally {
      await cleanup();
    }
  });

  test("required mapping failure on one file never completes", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const bBase = "export function g(): number {\n  return 1;\n}\n";
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/b.ts": bBase }, "base");
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": A_HEAD, "src/b.ts": bBase.replace("return 1", "return 2") },
        "head",
      );
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const original = SnapshotReader.prototype.readHeadText;
      SnapshotReader.prototype.readHeadText = async function (path: string): Promise<string> {
        if (path === "src/b.ts") throw new ReviewerError({ code: "GIT_FAILED", message: "injected mapping boom" });
        return original.call(this, path);
      };
      try {
        const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
        expect(result.status).not.toBe("complete");
        expect(result.status).toBe("partial");
        expect(result.units.some((u) => u.file.path === "src/a.ts")).toBe(true);
        expect(result.units.some((u) => u.file.path === "src/b.ts")).toBe(false);
        expect(result.diagnostics.diagnostics.some((d) => d.path === "src/b.ts" && d.stage === "snapshot")).toBe(true);
      } finally {
        SnapshotReader.prototype.readHeadText = original;
      }
    } finally {
      await cleanup();
    }
  });

  test("fatal mapping failure on every file returns failed", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const original = SnapshotReader.prototype.readHeadText;
      SnapshotReader.prototype.readHeadText = async (): Promise<string> => {
        throw new ReviewerError({ code: "GIT_FAILED", message: "injected fatal boom" });
      };
      try {
        const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
        expect(result.units).toEqual([]);
        expect(result.status).toBe("failed");
        expect(result.diagnostics.diagnostics.length).toBeGreaterThan(0);
      } finally {
        SnapshotReader.prototype.readHeadText = original;
      }
    } finally {
      await cleanup();
    }
  });

  test("one resolver failure preserves other resolvers output", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const clean = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveCalleesForSymbol: throwingCaller("callee down") as never },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.units).toHaveLength(clean.units.length);
      const cleanUnit = clean.units.find((u) => u.symbol.name === "f");
      const unit = result.units.find((u) => u.symbol.name === "f");
      expect(cleanUnit?.context.some((i) => i.kind === "definition")).toBe(true);
      expect(unit?.context.some((i) => i.kind === "definition")).toBe(true);
      const isImportItem = (i: { kind: string; file: string }) =>
        i.file === "src/util.ts" && (i.kind === "definition" || i.kind === "type");
      const cleanImports = cleanUnit?.context.filter(isImportItem) ?? [];
      const imports = unit?.context.filter(isImportItem) ?? [];
      expect(cleanImports.length).toBeGreaterThan(0);
      expect(imports.length).toBe(cleanImports.length);
      expect(cleanUnit?.context.some((i) => i.kind === "callee")).toBe(true);
      expect(unit?.context.some((i) => i.kind === "callee")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("every diagnostic carries file and stage details without large content", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCalleesForSymbol: throwingCaller("callee down") as never,
          resolveCallersForSymbol: throwingCaller("caller down") as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.status).toBe("partial");
      expect(result.diagnostics.diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of result.diagnostics.diagnostics) {
        expect(["snapshot", "parse", "import", "caller", "callee", "test"]).toContain(diagnostic.stage);
        expect(typeof diagnostic.path).toBe("string");
        expect(diagnostic.path.length).toBeGreaterThan(0);
        expect(typeof diagnostic.code).toBe("string");
        expect(typeof diagnostic.reason).toBe("string");
        expect(JSON.stringify(diagnostic).length).toBeLessThan(1000);
      }
    } finally {
      await cleanup();
    }
  });

  test("pipeline survives partial context and run.json keeps diagnostics without secrets", async () => {
    const { dir, cleanup } = await makeRepo();
    const outBase = await mkdtemp(join(tmpdir(), "codebleach-p3-f02-"));
    const outDir = join(outBase, "out");
    try {
      const secret = "zxqv-f02-secret-9f8e7d6c5b4a";
      const { baseSha, headSha } = await buildTwoFileDiff(dir);
      const config = ConfigFileSchema.parse({});
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const context = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveCallersForSymbol: throwingCaller(`caller down ${secret}`) as never },
      });
      const summary = await runPipeline(
        {
          diff: diffEngine,
          context,
          review: { review: () => Promise.resolve(emptyReviewResult()), requiresLlm: false },
          validation: { validate: () => Promise.resolve([]) },
          publisher: { publish: () => Promise.resolve({ published: 0, skipped: 0, failures: [] }) },
          logger: logger(),
        },
        { repoDir: dir, baseSha, headSha, dryRun: true, outDir, runId: "p3-f02-run", secrets: [secret] },
      );
      expect(summary.status).toBe("completed");
      const artifact = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
        status: string;
        contextStatus: string;
        contextDiagnostics: { diagnostics: Array<{ stage: string; path: string; code: string; reason: string }> };
        stages: Array<{ name: string; status: string }>;
      };
      expect(artifact.status).toBe("completed");
      expect(artifact.contextStatus).toBe("partial");
      expect(artifact.contextDiagnostics.diagnostics.length).toBeGreaterThan(0);
      expect(artifact.stages.find((s) => s.name === "context")?.status).toBe("completed");
      const raw = JSON.stringify(artifact);
      expect(raw).not.toContain(secret);
      expect(JSON.stringify(diff)).not.toContain(secret);
    } finally {
      await rm(outBase, { recursive: true, force: true });
      await cleanup();
    }
  });
});
