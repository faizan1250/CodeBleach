import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPublishLine, printPublishSummary, runReview } from "../../src/cli/commands/review.ts";
import type { Logger } from "../../src/core/logger.ts";

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

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

async function makeDirs(): Promise<{ repo: string; out: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "codebleach-p704-cli-"));
  return { repo: root, out: join(root, "out"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("p7-04 cli publish wiring", () => {
  test("formats publish counts with stable run codes only", () => {
    expect(formatPublishLine({ published: 2, skipped: 1, failures: [], runFailures: [] })).toBe(
      "publish: 2 published, 1 skipped, 0 failure(s); run failures: none",
    );
    expect(
      formatPublishLine({
        published: 0,
        skipped: 3,
        failures: [{ file: "src/a.ts", line: 1, reason: "publish_cap_exceeded" }],
        runFailures: [{ code: "rate_limited", message: "limited" }],
      }),
    ).toBe("publish: 0 published, 3 skipped, 1 failure(s); run failures: rate_limited");
  });

  test("live publish without PR metadata fails CONFIG_INVALID", async () => {
    const { repo, out, cleanup } = await makeDirs();
    try {
      const error = await runReview(
        {
          base: BASE,
          head: HEAD,
          repo,
          out,
          dryRun: false,
          demo: false,
          noLlm: false,
          logLevel: "error",
          runId: "p704-cli-nopr",
          env: { OPENCODE_API_KEY: "dummy-key", CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" },
        },
        nullLogger(),
      ).then(
        () => null,
        (failure: unknown) => failure as { code?: string },
      );
      expect(error?.code).toBe("CONFIG_INVALID");
    } finally {
      await cleanup();
    }
  });

  test("live publish without token fails CONFIG_INVALID", async () => {
    const { repo, out, cleanup } = await makeDirs();
    try {
      const error = await runReview(
        {
          base: BASE,
          head: HEAD,
          repo,
          out,
          dryRun: false,
          demo: false,
          noLlm: false,
          logLevel: "error",
          runId: "p704-cli-notoken",
          env: {
            OPENCODE_API_KEY: "dummy-key",
            CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true",
            GITHUB_REPOSITORY: "o/r",
            CODEBLEACH_PR_NUMBER: "1",
            CODEBLEACH_BASE_SHA: BASE,
            CODEBLEACH_HEAD_SHA: HEAD,
          },
        },
        nullLogger(),
      ).then(
        () => null,
        (failure: unknown) => failure as { code?: string },
      );
      expect(error?.code).toBe("CONFIG_INVALID");
    } finally {
      await cleanup();
    }
  });

  test("live dry-run without PR metadata does not fail on PR preflight", async () => {
    const { repo, out, cleanup } = await makeDirs();
    try {
      const code = await runReview(
        {
          base: BASE,
          head: HEAD,
          repo,
          out,
          dryRun: true,
          demo: false,
          noLlm: false,
          logLevel: "error",
          runId: "p704-cli-dryrun",
          env: { OPENCODE_API_KEY: "dummy-key", CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" },
        },
        nullLogger(),
      );
      // A non-git temp repo fails at diff (exit 1), proving the PR preflight
      // did not reject the dry-run for missing metadata (which would be 2).
      expect(code).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("demo non-dry-run completes offline with the canned publisher", async () => {
    const { repo, out, cleanup } = await makeDirs();
    try {
      const lines = captureLog();
      // No token and no PR env: a live run would fail the preflight, so exit
      // 0 proves the demo path stays offline with its synthetic identity.
      const code = await runReview(
        {
          repo,
          out,
          dryRun: false,
          demo: true,
          noLlm: false,
          logLevel: "error",
          runId: "p704-cli-demo-live",
          env: {},
        },
        nullLogger(),
      );
      expect(code).toBe(0);
      const artifact = JSON.parse(await readFile(join(out, "run.json"), "utf8"));
      expect(artifact.publishResult).toMatchObject({ published: 1, runFailures: [] });
      expect(lines.join("\n")).toContain("publish: 1 published");
    } finally {
      await cleanup();
    }
  });

  test("printPublishSummary renders legacy artifacts missing runFailures", async () => {
    const { out, cleanup } = await makeDirs();
    try {
      const lines = captureLog();
      await mkdir(out, { recursive: true });
      await writeFile(
        join(out, "run.json"),
        JSON.stringify({ publishResult: { published: 1, skipped: 0, failures: [] } }),
        "utf8",
      );
      await printPublishSummary(out);
      expect(lines).toEqual(["publish: 1 published, 0 skipped, 0 failure(s); run failures: none"]);
    } finally {
      await cleanup();
    }
  });
});
