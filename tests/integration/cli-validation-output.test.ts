import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../../src/cli/commands/review.ts";
import { createLogger } from "../../src/core/logger.ts";

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

describe("p5-10 cli validation output", () => {
  test("demo dry-run prints validation counts, a run.json pointer, and the scope disclaimer", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-p510-cli-"));
    try {
      const lines = captureLog();
      const logger = createLogger({ level: "error", runId: "p510-cli" });
      const code = await runReview(
        {
          base: undefined,
          head: undefined,
          repo: base,
          out: join(base, "out"),
          dryRun: true,
          demo: true,
          noLlm: false,
          logLevel: "error",
          runId: "p510-cli",
          secrets: [],
          env: {},
        },
        logger,
      );
      expect(code).toBe(0);
      const output = lines.join("\n");
      // Canned demo validation: 2 findings, first accepted, second rejected.
      expect(output).toContain("validation: 2 finding(s): 1 accepted, 1 rejected, 0 inconclusive");
      expect(output).toContain("run.json");
      expect(output).toContain("does not prove");
      const artifact = JSON.parse(await readFile(join(base, "out", "run.json"), "utf8")) as {
        validationSummary: { total: number; accepted: number; rejected: number; inconclusive: number } | null;
      };
      expect(artifact.validationSummary).toMatchObject({ total: 2, accepted: 1, rejected: 1, inconclusive: 0 });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
