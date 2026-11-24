import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { ContextEngineImpl } from "../../src/context/engine.ts";
import { isGitOutputLimit, isGitTimeout, SnapshotReader } from "../../src/context/snapshot.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";
import { emptyReviewResult } from "../fixtures/stubs.ts";

function logger() {
  return createLogger({ level: "error", runId: "cb-output-limit-test" });
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
const TWO_BASE = "export function f(): number {\n  return 1;\n}\nexport function g(): number {\n  return 2;\n}\n";
const TWO_HEAD = "export function f(): number {\n  return 10;\n}\nexport function g(): number {\n  return 20;\n}\n";

function outputLimitError(message = "injected output-limit"): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message,
    cause: { reason: "output-limit", stream: "stdout", limitBytes: 8, observedBytes: 16, bufferedBytes: 8 },
  });
}

function timeoutError(): ReviewerError {
  return new ReviewerError({
    code: "GIT_FAILED",
    message: "injected git timeout",
    cause: { reason: "timeout", timeoutMs: 30_000 },
  });
}

describe("context transport output-limit diagnostics", () => {
  test("output-limit maps to transport-output-limit with partial units", async () => {
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
            throw outputLimitError("injected output-limit zxqv-no-secret-here");
          }) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
      const diagnostic = result.diagnostics.diagnostics.find((d) => d.stage === "caller");
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.code).toBe("transport-output-limit");
      expect(diagnostic?.code).not.toBe("cap-reached");
      expect(diagnostic?.code).not.toBe("timeout");
      expect(diagnostic?.code).not.toBe("budget-exceeded");
      expect(diagnostic).toMatchObject({ stage: "caller", path: "src/a.ts", symbol: "f" });
      expect(typeof diagnostic?.reason).toBe("string");
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(result.diagnostics.filesParseTimedOut).toBe(0);
      const unit = result.units.find((u) => u.symbol.name === "f");
      expect(unit?.context.some((item) => item.kind === "definition")).toBe(true);
      expect(JSON.stringify(diagnostic)).not.toContain("zxqv-no-secret-here");
      expect(JSON.stringify(diagnostic).length).toBeLessThan(1000);
    } finally {
      await cleanup();
    }
  });

  test("resolver-internal output-limit surfaces instead of silent miss", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const original = SnapshotReader.prototype.readHeadText;
      SnapshotReader.prototype.readHeadText = async function (path: string): Promise<string> {
        if (path === "src/util.ts") throw outputLimitError();
        return original.call(this, path);
      };
      try {
        const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
        const codes = result.diagnostics.diagnostics.map((d) => d.code);
        expect(codes).toContain("transport-output-limit");
        expect(codes).not.toContain("cap-reached");
        expect(result.diagnostics.queryTimeouts).toBe(0);
        expect(result.units.length).toBeGreaterThan(0);
        expect(result.status).toBe("partial");
      } finally {
        SnapshotReader.prototype.readHeadText = original;
      }
    } finally {
      await cleanup();
    }
  });

  test("candidate cap stays cap-reached without transport code", async () => {
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
            diagnostics: [{ filePath: "src/a.ts", symbol: "f", callee: "helper", reason: "cap-reached" }],
          })) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.diagnostics.diagnostics.some((d) => d.code === "cap-reached")).toBe(true);
      expect(result.diagnostics.diagnostics.some((d) => d.code === "transport-output-limit")).toBe(false);
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("token budget skip stays independent of transport code", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const bigBody = Array.from({ length: 1000 }, (_, i) => `  const x${i} = ${i};`).join("\n");
      const baseFile = "export function big(): number {\n  return 1;\n}\n";
      const headFile = `export function big(): number {\n${bigBody}\n  return 1;\n}\n`;
      const baseSha = await writeAndCommit(dir, { "src/big.ts": baseFile }, "base");
      const headSha = await writeAndCommit(dir, { "src/big.ts": headFile }, "head");
      const config = ConfigFileSchema.parse({ context: { max_tokens_per_unit: 1000 } });
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
      expect(result.diagnostics.diagnostics.some((d) => d.code === "transport-output-limit")).toBe(false);
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(result.status).toBe("partial");
      expect(result.diagnostics.diagnostics.some((d) => d.code === "budget-exceeded")).toBe(false);
      const skipReasons = result.diagnostics.unitsSkipped.map((s) => s.reason);
      expect(skipReasons.some((r) => r === "mandatory-budget-exceeded" || r === "diff-exceeds-budget")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("cap, success, and output-limit stay independent in one run", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/two.ts": TWO_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/two.ts": TWO_HEAD }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const engine = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCalleesForSymbol: (async (options: { symbol: { name: string } }) => {
            if (options.symbol.name === "g") throw outputLimitError();
            return {
              callees: [],
              diagnostics: [{ filePath: "src/two.ts", symbol: "f", callee: "other", reason: "cap-reached" }],
            };
          }) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      const codes = result.diagnostics.diagnostics.map((d) => d.code);
      expect(codes).toContain("cap-reached");
      expect(codes).toContain("transport-output-limit");
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(result.status).toBe("partial");
      expect(result.units.length).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("output-limit never increments queryTimeouts and helper is timeout-exclusive", async () => {
    expect(isGitOutputLimit(outputLimitError())).toBe(true);
    expect(isGitOutputLimit(timeoutError())).toBe(false);
    expect(isGitTimeout(outputLimitError())).toBe(false);
    expect(isGitTimeout(timeoutError())).toBe(true);
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
            throw outputLimitError();
          }) as never,
          resolveCalleesForSymbol: (async (): Promise<never> => {
            throw outputLimitError();
          }) as never,
        },
      });
      const result = await engine.build(diff, config, dir);
      expect(result.diagnostics.queryTimeouts).toBe(0);
      expect(result.diagnostics.filesParseTimedOut).toBe(0);
      expect(result.diagnostics.diagnostics.filter((d) => d.code === "transport-output-limit")).toHaveLength(2);
      expect(result.diagnostics.diagnostics.some((d) => d.code === "timeout")).toBe(false);
      expect(result.status).toBe("partial");
    } finally {
      await cleanup();
    }
  });

  test("fatal output-limit on every file fails without completing", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diff = await new GitDiffEngine({ logger: logger() }).run({ repoDir: dir, baseSha, headSha, config });
      const original = SnapshotReader.prototype.readHeadText;
      SnapshotReader.prototype.readHeadText = async (): Promise<string> => {
        throw outputLimitError();
      };
      try {
        const result = await new ContextEngineImpl({ logger: logger() }).build(diff, config, dir);
        expect(result.units).toEqual([]);
        expect(result.status).toBe("failed");
        expect(result.status).not.toBe("complete");
        expect(result.diagnostics.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.diagnostics.every((d) => d.code === "transport-output-limit")).toBe(true);
        expect(result.diagnostics.queryTimeouts).toBe(0);
      } finally {
        SnapshotReader.prototype.readHeadText = original;
      }
    } finally {
      await cleanup();
    }
  });

  test("pipeline persists transport-output-limit verbatim with redaction", async () => {
    const { dir, cleanup } = await makeRepo();
    const outBase = await mkdtemp(join(tmpdir(), "codebleach-cb-output-limit-"));
    const outDir = join(outBase, "out");
    try {
      const secret = "zxqv-output-limit-secret-9f8e7d6c5b4a";
      const baseSha = await writeAndCommit(dir, { "src/a.ts": A_BASE, "src/util.ts": UTIL_BASE }, "base");
      const headSha = await writeAndCommit(dir, { "src/a.ts": A_HEAD, "src/util.ts": UTIL_BASE }, "head");
      const config = ConfigFileSchema.parse({});
      const diffEngine = new GitDiffEngine({ logger: logger() });
      const diff = await diffEngine.run({ repoDir: dir, baseSha, headSha, config });
      const context = new ContextEngineImpl({
        logger: logger(),
        resolvers: {
          resolveCallersForSymbol: (async (): Promise<never> => {
            throw outputLimitError(`injected output-limit ${secret}`);
          }) as never,
        },
      });
      const summary = await runPipeline(
        {
          diff: diffEngine,
          context,
          review: { review: () => Promise.resolve(emptyReviewResult()), requiresLlm: false },
          validation: { validate: () => Promise.resolve([]) },
          publisher: { publish: () => Promise.resolve({ published: 0, skipped: 0, failures: [], runFailures: [] }) },
          logger: logger(),
        },
        { repoDir: dir, baseSha, headSha, dryRun: true, outDir, runId: "cb-output-limit-run", secrets: [secret] },
      );
      expect(summary.status).toBe("completed");
      const artifact = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
        status: string;
        contextStatus: string;
        contextDiagnostics: {
          queryTimeouts: number;
          diagnostics: Array<{ stage: string; path: string; code: string; reason: string }>;
        };
        stages: Array<{ name: string; status: string }>;
      };
      expect(artifact.status).toBe("completed");
      expect(artifact.contextStatus).toBe("partial");
      expect(artifact.contextDiagnostics.queryTimeouts).toBe(0);
      expect(artifact.contextDiagnostics.diagnostics.some((d) => d.code === "transport-output-limit")).toBe(true);
      expect(artifact.stages.find((s) => s.name === "context")?.status).toBe("completed");
      expect(JSON.stringify(artifact)).not.toContain(secret);
      expect(diff).toBeDefined();
    } finally {
      await rm(outBase, { recursive: true, force: true });
      await cleanup();
    }
  });
});
