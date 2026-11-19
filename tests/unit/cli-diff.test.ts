import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiff } from "../../src/cli/commands/diff.ts";
import { createLogger } from "../../src/core/logger.ts";

function logger() {
  return createLogger({ level: "error", runId: "cli-diff-unit" });
}

describe("runDiff usage", () => {
  test("missing base/head throws CONFIG_INVALID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-diff-unit-"));
    try {
      const error = await runDiff({ repo: dir, logLevel: "info", runId: "r1" }, logger()).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unknown log level throws CONFIG_INVALID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-diff-unit-"));
    try {
      const full = "0123456789abcdef0123456789abcdef01234567";
      const error = await runDiff(
        { base: full, head: full, repo: dir, logLevel: "nope", runId: "r1" },
        logger(),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
