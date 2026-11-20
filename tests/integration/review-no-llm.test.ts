import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runReview } from "../../src/cli/commands/review.ts";
import { createLogger } from "../../src/core/logger.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";

const originalLog = console.log.bind(console);

afterEach(() => {
  console.log = originalLog;
});

function captureLog(): string[] {
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.log;
  return lines;
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

async function twoCommitRepo(): Promise<{ dir: string; base: string; head: string; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await makeRepo();
  const base = await writeAndCommit(dir, { "src/a.ts": "export function f(): number {\n  return 1;\n}\n" }, "base");
  const head = await writeAndCommit(
    dir,
    { "src/a.ts": "export function f(): number {\n  return 2;\n}\n" },
    "head",
  );
  return { dir, base, head, cleanup };
}

describe("p4-09 review --no-llm", () => {
  test("offline preview exits 0 with skipped review and validation", async () => {
    const { dir, base, head, cleanup } = await twoCommitRepo();
    const lines = captureLog();
    try {
      const out = join(dir, "out");
      const logger = createLogger({ level: "error", runId: "no-llm-e2e" });
      const code = await runReview(
        {
          base,
          head,
          repo: dir,
          out,
          dryRun: true,
          demo: false,
          noLlm: true,
          logLevel: "error",
          runId: "no-llm-e2e",
          secrets: [],
          env: {},
        },
        logger,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("no model review");
      const artifact = JSON.parse(await readFile(join(out, "run.json"), "utf8")) as {
        status: string;
        runId: string;
        reviewStatus: string;
        findings: unknown[];
        units: Array<{ id: string }>;
        contextStatus: string;
        stages: Array<{ name: string; status: string; reason?: string }>;
      };
      expect(artifact.status).toBe("completed");
      expect(artifact.runId).toBe("no-llm-e2e");
      expect(artifact.reviewStatus).toBe("skipped");
      expect(artifact.findings).toEqual([]);
      expect(artifact.units.length).toBeGreaterThan(0);
      expect(artifact.contextStatus).toBe("complete");
      expect(artifact.stages).toMatchObject([
        { name: "config", status: "completed" },
        { name: "diff", status: "completed" },
        { name: "context", status: "completed" },
        { name: "review", status: "skipped", reason: "no_llm_flag" },
        { name: "validation", status: "skipped", reason: "review_skipped_no_llm" },
        { name: "publish", status: "skipped" },
      ]);
    } finally {
      await cleanup();
    }
  });

  test("real review without key or opt-in stops before network access", async () => {
    const { dir, base, head, cleanup } = await twoCommitRepo();
    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const out = join(dir, "out");
      const logger = createLogger({ level: "warn", runId: "no-key-e2e" });
      const code = await runReview(
        {
          base,
          head,
          repo: dir,
          out,
          dryRun: true,
          demo: false,
          noLlm: false,
          logLevel: "warn",
          runId: "no-key-e2e",
          secrets: [],
          env: {},
        },
        logger,
      );
      expect(code).toBe(2);
      expect(captured).toContain("CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING");
      const artifact = JSON.parse(await readFile(join(out, "run.json"), "utf8")) as {
        status: string;
        error: { code: string };
      };
      expect(artifact.status).toBe("failed");
      expect(artifact.error.code).toBe("CONFIG_INVALID");
    } finally {
      process.stderr.write = originalWrite;
      await cleanup();
    }
  });

  test("demo stays deterministic with no-llm set", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-demo-nollm-"));
    try {
      const lines = captureLog();
      const logger = createLogger({ level: "error", runId: "demo-nollm" });
      const code = await runReview(
        {
          base: undefined,
          head: undefined,
          repo: base,
          out: join(base, "out"),
          dryRun: true,
          demo: true,
          noLlm: true,
          logLevel: "error",
          runId: "demo-nollm",
          secrets: [],
          env: {},
        },
        logger,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("completed");
      const artifact = JSON.parse(await readFile(join(base, "out", "run.json"), "utf8")) as {
        findings: unknown[];
      };
      expect(artifact.findings).toHaveLength(2);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
