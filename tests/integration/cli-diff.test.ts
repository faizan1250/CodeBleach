import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "../../src/utils/spawn.ts";

const CLI = join(dirname(import.meta.dir), "..", "src", "cli", "index.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string, env?: Record<string, string | undefined>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function git(dir: string, args: string[]): Promise<string> {
  const result = await runProcess({ cmd: ["git", ...args], cwd: dir });
  return new TextDecoder().decode(result.stdout).trim();
}

async function makeRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "codebleach-cli-diff-"));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    await git(dir, ["init"]);
    await git(dir, ["config", "user.name", "CodeBleach Test"]);
    await git(dir, ["config", "user.email", "cli-diff@codebleach.local"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
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

describe("cli diff", () => {
  test("prints valid DiffResult json to stdout with logs on stderr", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 2;\n" }, "head");
      const result = await runCli(["diff", "--base", base, "--head", head, "--repo", dir], dir);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        baseSha: string;
        headSha: string;
        mergeBase: string;
        files: Array<{ path: string }>;
      };
      expect(parsed.baseSha).toBe(base.toLowerCase());
      expect(parsed.headSha).toBe(head.toLowerCase());
      expect(parsed.mergeBase).toBe(base.toLowerCase());
      expect(parsed.files.map((file) => file.path)).toEqual(["src/a.ts"]);
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("missing base exits 2", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "only");
      const result = await runCli(["diff", "--head", head, "--repo", dir], dir);
      expect(result.code).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("unknown flags exit 2", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const result = await runCli(["diff", "--bogus"], dir);
      expect(result.code).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("invalid commit exits 1 with a readable message", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "only");
      const missing = "0123456789abcdef0123456789abcdef01234567";
      const result = await runCli(["diff", "--base", head, "--head", missing, "--repo", dir], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/diff failed/i);
    } finally {
      await cleanup();
    }
  });

  test("normal review without credentials fails preflight before diff and context", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 2;\n" }, "head");
      const out = join(dir, "out");
      // Scrub ambient live credentials: normal tests never touch the network.
      const result = await runCli(["review", "--base", base, "--head", head, "--repo", dir, "--out", out], dir, {
        OPENCODE_API_KEY: "",
        CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "",
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING");
      const artifact = JSON.parse(await readFile(join(out, "run.json"), "utf8")) as {
        status: string;
        error: { code: string };
        stages: Array<{ name: string; status: string; ms: number }>;
        diff: { baseSha: string; headSha: string; files: unknown[] } | null;
        units: Array<{ id: string }>;
        contextStatus: string | null;
        contextDiagnostics: { unitsCreated: number } | null;
      };
      expect(artifact.status).toBe("failed");
      expect(artifact.error.code).toBe("CONFIG_INVALID");
      // Preflight runs after config but before diff: no git retrieval, no
      // context parsing, and the context/review stages never record.
      expect(artifact.stages).toEqual([{ name: "config", status: "completed", ms: expect.any(Number) }]);
      expect(artifact.diff).toBeNull();
      expect(artifact.units).toEqual([]);
      expect(artifact.contextStatus).toBeNull();
      expect(artifact.contextDiagnostics).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("review --no-llm exits 0 with skipped review and validation", async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      const base = await writeAndCommit(dir, { "src/a.ts": "const a = 1;\n" }, "base");
      const head = await writeAndCommit(dir, { "src/a.ts": "const a = 2;\n" }, "head");
      const out = join(dir, "out");
      const result = await runCli(
        ["review", "--base", base, "--head", head, "--repo", dir, "--out", out, "--dry-run", "--no-llm"],
        dir,
        { OPENCODE_API_KEY: "", CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "" },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("no model review");
      const artifact = JSON.parse(await readFile(join(out, "run.json"), "utf8")) as {
        status: string;
        runId: string;
        reviewStatus: string;
        findings: unknown[];
        stages: Array<{ name: string; status: string; reason?: string }>;
      };
      expect(artifact.status).toBe("completed");
      expect(artifact.reviewStatus).toBe("skipped");
      expect(artifact.findings).toEqual([]);
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
});
