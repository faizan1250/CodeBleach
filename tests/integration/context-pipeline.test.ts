import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { ContextEngineImpl } from "../../src/context/engine.ts";
import { RunBudget } from "../../src/context/limits.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import { stubPublisher, stubValidationEngine } from "../../src/core/stubs.ts";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";
import type { ReviewUnit } from "../../src/types/index.ts";

function logger() {
  return createLogger({ level: "error", runId: "p3-11-test" });
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

describe("p3-11 pipeline wiring", () => {
  test("real context persists units, status, diagnostics before review stub fails", async () => {
    const { dir, cleanup } = await makeRepo();
    const outDir = join(dir, "out");
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": "export function f(): number {\n  return 1;\n}\n" }, "base");
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 2;\n}\n" },
        "head",
      );
      const config = ConfigFileSchema.parse({});
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const result = await context.build(diff, config, dir);
      expect(result.status).toBe("complete");
      expect(result.units).toHaveLength(1);
      expect(result.units[0]?.symbol).toMatchObject({ name: "f", kind: "function" });
      expect(result.units[0]?.file.path).toBe("src/a.ts");
      expect(result.units[0]?.file.commentableLines.length).toBeGreaterThan(0);
      expect(result.diagnostics.unitsCreated).toBe(1);

      let seen: ReviewUnit[] | null = null;
      const recordingReview = {
        review: (units: ReviewUnit[]) => {
          seen = units;
          return Promise.reject(new ReviewerError({ code: "NOT_IMPLEMENTED", message: "review stub" }));
        },
      };
      const failure = await runPipeline(
        {
          diff: diffEngine,
          context,
          review: recordingReview as never,
          validation: stubValidationEngine,
          publisher: stubPublisher,
          logger: logger(),
        },
        { repoDir: dir, baseSha, headSha, dryRun: true, outDir, runId: "p3-11-run" },
      ).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
      expect((seen as ReviewUnit[] | null)?.length).toBe(1);
      expect((failure as { code?: string })?.code).toBe("NOT_IMPLEMENTED");
      const artifact = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
        status: string;
        units: Array<{ id: string }>;
        contextStatus: string;
        contextDiagnostics: { unitsCreated: number };
        stages: Array<{ name: string; status: string }>;
        error: { code: string };
      };
      expect(artifact.units).toHaveLength(1);
      expect(artifact.contextStatus).toBe("complete");
      expect(artifact.contextDiagnostics.unitsCreated).toBe(1);
      expect(artifact.stages.find((s) => s.name === "context")?.status).toBe("completed");
      expect(artifact.stages.find((s) => s.name === "review")?.status).toBe("failed");
      expect(artifact.error.code).toBe("NOT_IMPLEMENTED");
    } finally {
      await cleanup();
    }
  });

  test("two independent functions produce two deterministic units", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 1;\n}\nexport function g(): number {\n  return 1;\n}\n" },
        "base",
      );
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 2;\n}\nexport function g(): number {\n  return 3;\n}\n" },
        "head",
      );
      const config = ConfigFileSchema.parse({});
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const first = await context.build(diff, config, dir);
      const second = await context.build(diff, config, dir);
      expect(first.units).toHaveLength(2);
      expect(first.units.map((u) => u.symbol.name).sort()).toEqual(["f", "g"]);
      expect(second.units.map((u) => u.id)).toEqual(first.units.map((u) => u.id));
      for (const unit of first.units) {
        expect(unit.diff.originalHunkCount).toBeGreaterThan(0);
        expect(unit.diff.includedHunkCount).toBeGreaterThan(0);
      }
    } finally {
      await cleanup();
    }
  });

  test("empty diff produces no units but stays complete", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": "export function f(): number {\n  return 1;\n}\n" }, "base");
      const config = ConfigFileSchema.parse({});
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha: baseSha, config });
      const result = await context.build(diff, config, dir);
      expect(result.units).toEqual([]);
      expect(result.status).toBe("complete");
      expect(result.diagnostics.unitsCreated).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("deletion-only change keeps deleted lines with a head-side anchor", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n" },
        "base",
      );
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  const a = 1;\n  return a;\n}\n" },
        "head",
      );
      const config = ConfigFileSchema.parse({});
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const result = await context.build(diff, config, dir);
      expect(result.units).toHaveLength(1);
      const symbol = result.units[0]?.symbol;
      expect(symbol?.name).toBe("f");
      expect((symbol?.deletedLines ?? []).length).toBeGreaterThan(0);
      if ((symbol?.changedLines ?? []).length === 0) {
        expect(symbol?.anchorLine).toBeDefined();
        expect(result.units[0]?.file.commentableLines).toContain(symbol?.anchorLine as number);
      }
    } finally {
      await cleanup();
    }
  });

  test("unsupported language falls back to a module unit", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "data/notes.json": '{\n  "hello": "world"\n}\n' }, "base");
      const headSha = await writeAndCommit(dir, { "data/notes.json": '{\n  "hello": "moon"\n}\n' }, "head");
      const config = ConfigFileSchema.parse({});
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const result = await context.build(diff, config, dir);
      expect(result.units).toHaveLength(1);
      expect(result.units[0]?.symbol.kind).toBe("module");
      expect(result.units[0]?.file.language).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("explicit rules attach verbatim and worktree edits do not change output", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": "export function f(): number {\n  return 1;\n}\n" }, "base");
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 2;\n}\n" },
        "head",
      );
      const config = ConfigFileSchema.parse({
        rules: [{ id: "r1", kind: "convention", text: "Be careful.", paths: ["src/**"] }],
      });
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const first = await context.build(diff, config, dir);
      expect(first.units).toHaveLength(1);
      expect(first.units[0]?.rules.map((r) => r.id)).toEqual(["r1"]);
      await writeFile(join(dir, "src/a.ts"), "export function f(): number {\n  return 999;\n}\n");
      const second = await context.build(diff, config, dir);
      expect(second.units.map((u) => u.id)).toEqual(first.units.map((u) => u.id));
    } finally {
      await cleanup();
    }
  });

  test("rule-heavy unit skips with mandatory-budget-exceeded under a tiny cap", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": "export function f(): number {\n  return 1;\n}\n" }, "base");
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 2;\n}\n" },
        "head",
      );
      const config = ConfigFileSchema.parse({
        context: { max_tokens_per_unit: 1000 },
        rules: [{ id: "big", kind: "convention", text: `x${"y".repeat(20000)}` }],
      });
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const result = await context.build(diff, config, dir);
      expect(result.units).toEqual([]);
      expect(result.diagnostics.unitsSkipped.map((s) => s.reason)).toContain("mandatory-budget-exceeded");
    } finally {
      await cleanup();
    }
  });

  test("run deadline marks partial with a skip for every unprocessed file", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 1;\n}\nexport function g(): number {\n  return 1;\n}\n" },
        "base",
      );
      const headSha = await writeAndCommit(
        dir,
        { "src/a.ts": "export function f(): number {\n  return 2;\n}\nexport function g(): number {\n  return 3;\n}\n" },
        "head",
      );
      const defaults = ConfigFileSchema.parse({});
      const config = { ...defaults, context: { ...defaults.context, max_run_time_ms: 1 } };
      const context = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config: defaults });
      const result = await context.build(diff, config, dir);
      expect(result.status).toBe("partial");
      expect(result.diagnostics.deadlineExceeded).toBe(true);
      expect(result.units).toEqual([]);
      expect(result.diagnostics.unitsSkipped.length).toBeGreaterThan(0);
      for (const skip of result.diagnostics.unitsSkipped) {
        expect(skip.reason).toBe("run-deadline");
      }
      for (const file of diff.files) {
        expect(result.diagnostics.unitsSkipped.some((skip) => skip.path === file.path)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test("run deadline emits skips for every remaining symbol in the current file", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(
        dir,
        {
          "src/a.ts":
            "export function f(): number {\n  return 1;\n}\nexport function g(): number {\n  return 1;\n}\nexport function h(): number {\n  return 1;\n}\n",
        },
        "base",
      );
      const headSha = await writeAndCommit(
        dir,
        {
          "src/a.ts":
            "export function f(): number {\n  return 2;\n}\nexport function g(): number {\n  return 3;\n}\nexport function h(): number {\n  return 4;\n}\n",
        },
        "head",
      );
      const config = ConfigFileSchema.parse({});
      const engine = new ContextEngineImpl({ logger: logger() });
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const remainingRunMs = RunBudget.prototype.remainingRunMs;
      let emitted = 0;
      RunBudget.prototype.remainingRunMs = function (this: RunBudget): number {
        if (emitted > 0) return 0;
        return remainingRunMs.call(this);
      };
      const engineRecord = engine as unknown as {
        buildUnit: (input: Record<string, unknown>) => Promise<unknown>;
      };
      const originalBuildUnit = engineRecord.buildUnit.bind(engine);
      engineRecord.buildUnit = async (input: Record<string, unknown>): Promise<unknown> => {
        const outcome = await originalBuildUnit(input);
        emitted += 1;
        return outcome;
      };
      try {
        const result = await engine.build(diff, config, dir);
        expect(result.status).toBe("partial");
        expect(result.diagnostics.deadlineExceeded).toBe(true);
        expect(result.units.map((unit) => unit.symbol.name)).toEqual(["f"]);
        expect(result.diagnostics.unitsSkipped).toMatchObject([
          { path: "src/a.ts", symbol: "g", reason: "run-deadline" },
          { path: "src/a.ts", symbol: "h", reason: "run-deadline" },
        ]);
      } finally {
        RunBudget.prototype.remainingRunMs = remainingRunMs;
      }
    } finally {
      await cleanup();
    }
  });
});
