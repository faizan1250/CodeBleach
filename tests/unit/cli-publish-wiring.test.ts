import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPublishLine, runReview } from "../../src/cli/commands/review.ts";
import type { Logger } from "../../src/core/logger.ts";

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
});
