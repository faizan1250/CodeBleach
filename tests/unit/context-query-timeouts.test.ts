import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ContextEngineImpl } from "../../src/context/engine.ts";
import { isGitTimeout } from "../../src/context/snapshot.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";
import { emptyReviewResult } from "../fixtures/stubs.ts";

function logger() {
  return createLogger({ level: "error", runId: "p3-f03-test" });
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
const TWO_BASE =
  "export function f(): number {\n  return 1;\n}\nexport function g(): number {\n  return 2;\n}\n";
const TWO_HEAD =
  "export function f(): number {\n  return 10;\n}\nexport function g(): number {\n  return 20;\n}\n";

function timeoutError(): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: "injected git timeout",
    cause: { reason: "timeout", timeoutMs: 30_000 },
  });
}

function exitError(): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: "injected git exit",
    cause: { reason: "exit", exitCode: 1 },
  });
}

function throwingTimeout() {
  return async (): Promise<never> => {
    throw timeoutError();
  };
}

describe("p3-f03 git query timeouts", () => {
  test("single git timeout counts once and stays partial", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveCallersForSymbol: throwingTimeout() as never },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.diagnostics.queryTimeouts).toBe(1);
      expect(result.diagnostics.filesParseTimedOut).toBe(0);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
      const unit = result.units.find((u) => u.symbol.name === "f");
      expect(unit?.context.some((item) => item.kind === "definition")).toBe(true);
      expect(unit?.context.some((item) => item.file === "src/util.ts")).toBe(true);
      const diagnostic = result.diagnostics.diagnostics.find((d) => d.stage === "caller");
      expect(diagnostic).toMatchObject({ stage: "caller", path: "src/a.ts", symbol: "f", code: "timeout" });
    } finally {
      await cleanup();
    }
  });

  test("two distinct timeouts count twice without doubling", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCallersForSymbol: throwingTimeout() as never,
          resolveCalleesForSymbol: throwingTimeout() as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.diagnostics.queryTimeouts).toBe(2);
      expect(result.diagnostics.filesParseTimedOut).toBe(0);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
      expect(result.diagnostics.diagnostics.filter((d) => d.code === "timeout")).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test("parse-cancelled resolver signal never counts as query timeout", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCalleesForSymbol: (async () => ({
            callees: [],
            diagnostics: [{ filePath: "src/a.ts", symbol: "f", callee: "helper", reason: "parse-cancelled" }],
          })) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(
        result.diagnostics.diagnostics.some((d) => d.stage === "callee" && d.code === "parse-cancelled"),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("failed non-timeout git error is omitted without counting", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCallersForSymbol: (async (): Promise<never> => {
            throw exitError();
          }) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
      const diagnostic = result.diagnostics.diagnostics.find((d) => d.stage === "caller");
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.code).not.toBe("timeout");
    } finally {
      await cleanup();
    }
  });

  test("repeated timed-out calls count once each with no retry", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/two.ts": TWO_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/two.ts": TWO_HEAD }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      let calls = 0;
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCallersForSymbol: (async (): Promise<never> => {
            calls += 1;
            throw timeoutError();
          }) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(calls).toBe(2);
      expect(result.diagnostics.queryTimeouts).toBe(2);
      expect(result.status).toBe("partial");
    } finally {
      await cleanup();
    }
  });

  test("isGitTimeout distinguishes timeout cause only", () => {
    expect(isGitTimeout(timeoutError())).toBe(true);
    expect(isGitTimeout(exitError())).toBe(false);
    expect(
      isGitTimeout(new ReviewerError({ code: "GIT_FAILED", message: "cap", cause: { reason: "output-limit" } })),
    ).toBe(false);
    expect(isGitTimeout(new ReviewerError({ code: "GIT_FAILED", message: "abort", cause: { reason: "abort" } }))).toBe(
      false,
    );
    expect(isGitTimeout(new ReviewerError({ code: "GIT_FAILED", message: "bare" }))).toBe(false);
    expect(isGitTimeout(new Error("boom"))).toBe(false);
    expect(isGitTimeout(null)).toBe(false);
  });

  test("timeout count survives the run artifact", async () => {
    const { dir, cleanup } = await makeRepo();
    const outBase = await mkdtemp(join(tmpdir(), "codebleach-p3-f03-"));
    const outDir = join(outBase, "out");
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const context = new ContextEngineImpl({
        logger: logger(),
        resolvers: { resolveCallersForSymbol: throwingTimeout() as never },
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
        { repoDir: dir, baseSha, headSha, dryRun: true, outDir, runId: "p3-f03-run" },
      );
      expect(summary.status).toBe("completed");
      const artifact = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
        status: string;
        contextStatus: string;
        contextDiagnostics: { queryTimeouts: number; filesParseTimedOut: number };
      };
      expect(artifact.status).toBe("completed");
      expect(artifact.contextStatus).toBe("partial");
      expect(artifact.contextDiagnostics.queryTimeouts).toBe(1);
      expect(artifact.contextDiagnostics.filesParseTimedOut).toBe(0);
      expect(diff).toBeDefined();
    } finally {
      await rm(outBase, { recursive: true, force: true });
      await cleanup();
    }
  });
});
