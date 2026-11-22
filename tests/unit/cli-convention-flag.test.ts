import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipelineConventionAdvisoryEnabled, runReview } from "../../src/cli/commands/review.ts";
import { createLogger } from "../../src/core/logger.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

async function twoCommitRepo(): Promise<{ dir: string; base: string; head: string; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await makeRepo();
  const write = async (content: string, message: string): Promise<string> => {
    const full = join(dir, "src/a.ts");
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", message, "--quiet"]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const base = await write("export function f(): number {\n  return 1;\n}\n", "base");
  const head = await write("export function f(): number {\n  return 2;\n}\n", "head");
  return { dir, base, head, cleanup };
}

describe("p6-00 --convention-advisory composition", () => {
  test("demo ignores the flag and stays network-free", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-p6-00-demo-"));
    try {
      const lines = captureLog();
      const logger = createLogger({ level: "error", runId: "p6-00-demo" });
      const code = await runReview(
        {
          base: undefined,
          head: undefined,
          repo: base,
          out: join(base, "out"),
          dryRun: true,
          demo: true,
          noLlm: false,
          conventionAdvisory: true,
          logLevel: "error",
          runId: "p6-00-demo",
          secrets: [],
          env: {},
        },
        logger,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("completed");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("--no-llm ignores the flag and stays offline", async () => {
    const { dir, base, head, cleanup } = await twoCommitRepo();
    try {
      const lines = captureLog();
      const logger = createLogger({ level: "error", runId: "p6-00-nollm" });
      const code = await runReview(
        {
          base,
          head,
          repo: dir,
          out: join(dir, "out"),
          dryRun: true,
          demo: false,
          noLlm: true,
          conventionAdvisory: true,
          logLevel: "error",
          runId: "p6-00-nollm",
          secrets: [],
          env: {},
        },
        logger,
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("no model review");
      const artifact = JSON.parse(await readFile(join(dir, "out", "run.json"), "utf8")) as {
        reviewStatus: string;
      };
      expect(artifact.reviewStatus).toBe("skipped");
    } finally {
      await cleanup();
    }
  });

  test("live run with the flag fails closed before config load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-p6-00-live-"));
    try {
      const logger = createLogger({ level: "error", runId: "p6-00-live" });
      const promise = runReview(
        {
          base: "base",
          head: "head",
          repo: dir,
          out: join(dir, "out"),
          dryRun: true,
          demo: false,
          noLlm: false,
          conventionAdvisory: true,
          logLevel: "error",
          runId: "p6-00-live",
          secrets: [],
          env: {},
        },
        logger,
      );
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("p6-00 pipeline flag plumbing", () => {
  test("live run forwards the flag", () => {
    expect(pipelineConventionAdvisoryEnabled({ conventionAdvisory: true, demo: false, noLlm: false })).toBe(true);
  });

  test("flag off or absent stays disabled on the live path", () => {
    expect(pipelineConventionAdvisoryEnabled({ conventionAdvisory: false, demo: false, noLlm: false })).toBe(false);
    expect(pipelineConventionAdvisoryEnabled({ conventionAdvisory: undefined, demo: false, noLlm: false })).toBe(false);
  });

  test("demo and --no-llm never forward the flag", () => {
    expect(pipelineConventionAdvisoryEnabled({ conventionAdvisory: true, demo: true, noLlm: false })).toBe(false);
    expect(pipelineConventionAdvisoryEnabled({ conventionAdvisory: true, demo: false, noLlm: true })).toBe(false);
  });
});
