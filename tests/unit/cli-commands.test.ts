import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigPrint, runConfigValidate } from "../../src/cli/commands/config.ts";
import { readVersion, runVersion } from "../../src/cli/commands/version.ts";
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

describe("version command", () => {
  test("reads version from package.json", async () => {
    const pkg = JSON.parse(await Bun.file("package.json").text()) as { version: string };
    await expect(readVersion()).resolves.toBe(pkg.version);
  });

  test("prints version and exits 0", async () => {
    const lines = captureLog();
    await expect(runVersion()).resolves.toBe(0);
    expect(lines).toHaveLength(1);
  });
});

describe("config commands", () => {
  test("validate uses defaults when missing", async () => {
    const lines = captureLog();
    const dir = await mkdtemp(join(tmpdir(), "codebleach-cmd-"));
    try {
      const logger = createLogger({ level: "error", runId: "cmd-test" });
      await expect(runConfigValidate(dir, logger)).resolves.toBe(0);
      expect(lines.join("\n")).toContain("defaults");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validate rejects invalid file with exit 2", async () => {
    const lines = captureLog();
    const dir = await mkdtemp(join(tmpdir(), "codebleach-cmd-"));
    try {
      await writeFile(join(dir, ".reviewer.yml"), "version: 1\nreview:\n  bogus: true\n");
      const logger = createLogger({ level: "error", runId: "cmd-test" });
      await expect(runConfigValidate(dir, logger)).resolves.toBe(2);
      expect(lines).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("print emits resolved config json to stdout", async () => {
    const lines = captureLog();
    const dir = await mkdtemp(join(tmpdir(), "codebleach-cmd-"));
    try {
      const logger = createLogger({ level: "error", runId: "cmd-test" });
      await expect(runConfigPrint(dir, logger)).resolves.toBe(0);
      const config = JSON.parse(lines.join("\n")) as { version: number };
      expect(config.version).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
