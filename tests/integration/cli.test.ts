import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(dirname(import.meta.dir), "..", "src", "cli", "index.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function makeRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "codebleach-cli-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("cli", () => {
  test("version matches package.json", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
      const result = await runCli(["version"], dir);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
    } finally {
      await cleanup();
    }
  });

  test("config validate reports defaults when missing", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["config", "validate"], dir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("defaults");
    } finally {
      await cleanup();
    }
  });

  test("config validate rejects invalid file", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(join(dir, ".reviewer.yml"), "version: 1\nreview:\n  bogus: true\n");
      const result = await runCli(["config", "validate"], dir);
      expect(result.code).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("config print emits resolved json", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["config", "print"], dir);
      expect(result.code).toBe(0);
      const config = JSON.parse(result.stdout) as { version: number };
      expect(config.version).toBe(1);
      expect(result.stderr).not.toContain("no config");
    } finally {
      await cleanup();
    }
  });

  test("review without base/head exits 2", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["review", "--head", "h"], dir);
      expect(result.code).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("normal review with invalid SHAs fails at diff with failed artifact", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["review", "--base", "b", "--head", "h"], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("GIT_FAILED");
      const artifact = JSON.parse(
        await readFile(join(dir, ".reviewer-out", "run.json"), "utf8"),
      ) as { status: string; error: { code: string } };
      expect(artifact.status).toBe("failed");
      expect(artifact.error.code).toBe("GIT_FAILED");
    } finally {
      await cleanup();
    }
  });

  test("demo dry run exits 0 with complete artifact", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["review", "--demo", "--dry-run"], dir);
      expect(result.code).toBe(0);
      const artifact = JSON.parse(
        await readFile(join(dir, ".reviewer-out", "run.json"), "utf8"),
      ) as {
        status: string;
        schemaVersion: number;
        stages: Array<{ name: string; status: string; count?: number }>;
        findings: unknown[];
        validated: Array<{ status: string; finding: { id: string; file: string } }>;
        units: Array<{ id: string; file: { path: string }; symbol: { name: string } }>;
        publishResult: null;
      };
      expect(artifact.status).toBe("completed");
      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.stages.map((stage) => [stage.name, stage.status])).toEqual([
        ["config", "completed"],
        ["diff", "completed"],
        ["context", "completed"],
        ["review", "completed"],
        ["validation", "completed"],
        ["publish", "skipped"],
      ]);
      expect(artifact.findings).toHaveLength(2);
      expect(artifact.validated).toHaveLength(2);
      expect(artifact.publishResult).toBeNull();
      expect(artifact.validated[0]?.finding).toMatchObject({ id: "demo-finding-1" });
      expect(artifact.units[0]?.file).toMatchObject({ path: "src/demo.ts" });
      expect(artifact.units[0]?.symbol).toMatchObject({ name: "greet" });
    } finally {
      await cleanup();
    }
  });

  test("unknown flags and commands exit 2", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      expect((await runCli(["review", "--bogus"], dir)).code).toBe(2);
      expect((await runCli(["frobnicate"], dir)).code).toBe(2);
      expect((await runCli(["config", "bogus"], dir)).code).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("demo dry run uses one runId across logs and artifact", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["review", "--demo", "--dry-run"], dir);
      expect(result.code).toBe(0);
      const artifact = JSON.parse(await readFile(join(dir, ".reviewer-out", "run.json"), "utf8")) as {
        runId: string;
      };
      const logRunIds = result.stderr
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as { runId?: unknown };
          } catch {
            return {};
          }
        })
        .filter((line) => typeof line.runId === "string")
        .map((line) => line.runId as string);
      expect(logRunIds.length).toBeGreaterThan(0);
      expect(new Set(logRunIds).size).toBe(1);
      expect(logRunIds[0]).toBe(artifact.runId);
    } finally {
      await cleanup();
    }
  });

  test("independent demo runs use distinct runIds", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const readRunId = async (): Promise<string> => {
        const result = await runCli(["review", "--demo", "--dry-run"], dir);
        expect(result.code).toBe(0);
        const artifact = JSON.parse(
          await readFile(join(dir, ".reviewer-out", "run.json"), "utf8"),
        ) as { runId: string };
        return artifact.runId;
      };
      expect(await readRunId()).not.toBe(await readRunId());
    } finally {
      await cleanup();
    }
  });
});
