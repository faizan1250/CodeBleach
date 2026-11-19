import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import { exitCodeForError } from "../../src/cli/exit-codes.ts";
import { GitDiffEngine, isFullCommitSha, normalizeCommitSha } from "../../src/diff/git.ts";
import type { DiffLogger } from "../../src/diff/git.ts";
import { DEFAULT_MAX_STDOUT_BYTES } from "../../src/utils/spawn.ts";
import { commitIndex, git, makeRepo } from "./git-diff-engine.test.ts";

const CLI = join(dirname(import.meta.dir), "..", "src", "cli", "index.ts");

interface LoggedCall {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function makeLogger(): { calls: LoggedCall[]; logger: DiffLogger } {
  const calls: LoggedCall[] = [];
  const entry =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      calls.push({ level, msg, fields });
    };
  return {
    calls,
    logger: {
      debug: entry("debug"),
      info: entry("info"),
      warn: entry("warn"),
      error: entry("error"),
    },
  };
}

function defaults(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return ConfigFileSchema.parse(overrides);
}

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(ReviewerError);
  return (error as ReviewerError).code;
}

async function runEngine(
  dir: string,
  baseSha: string,
  headSha: string,
  config: ResolvedConfig = defaults(),
  patchMaxStdoutBytes?: number,
): Promise<Awaited<ReturnType<GitDiffEngine["run"]>>> {
  const { logger } = makeLogger();
  const engine =
    patchMaxStdoutBytes === undefined
      ? new GitDiffEngine({ logger })
      : new GitDiffEngine({ logger, patchMaxStdoutBytes });
  return engine.run({ repoDir: dir, baseSha, headSha, config });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("E01 typechange 120000 skips as unsupported-mode", () => {
  test("same-path regular file to symlink is unsupported-mode with empty hunks/lines/symbols", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/app.ts"), "const a = 1;\n");
      const appOutside = join(outside, "app");
      await writeFile(appOutside, "const a = 1;\n");
      const appBlob = await git(dir, ["hash-object", "-w", appOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${appBlob},src/app.ts`]);
      const base = await commitIndex(dir, "base");
      const targetOutside = join(outside, "target");
      await writeFile(targetOutside, "src/app.ts");
      const targetBlob = await git(dir, ["hash-object", "-w", targetOutside]);
      await git(dir, ["update-index", "--cacheinfo", `120000,${targetBlob},src/app.ts`]);
      const head = await commitIndex(dir, "head");
      // RED: currently throws PARSE_FAILED "patch has 2 file section(s) but metadata lists 1".
      const result = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      expect(file?.path).toBe("src/app.ts");
      expect(file?.skipReason).toBe("unsupported-mode");
      expect(file?.hunks).toEqual([]);
      expect(file?.commentableLines).toEqual([]);
      expect(file?.symbols).toEqual([]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E02 gitlink 160000 skips without contaminating app.ts", () => {
  test("vendor/sub unsupported-mode empty plus app.ts normal", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/app.ts"), "const a = 1;\n");
      const appOutside = join(outside, "app");
      await writeFile(appOutside, "const a = 1;\n");
      const appBlob = await git(dir, ["hash-object", "-w", appOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${appBlob},src/app.ts`]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/app.ts"), "const a = 2;\n");
      const app2Outside = join(outside, "app2");
      await writeFile(app2Outside, "const a = 2;\n");
      const app2Blob = await git(dir, ["hash-object", "-w", app2Outside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${app2Blob},src/app.ts`]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/sub`]);
      const head = await commitIndex(dir, "head");
      // RED: currently throws GIT_FAILED "cannot read head blob for vendor/sub".
      const result = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(2);
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      const sub = byPath.get("vendor/sub");
      expect(sub?.skipReason).toBe("unsupported-mode");
      expect(sub?.hunks).toEqual([]);
      expect(sub?.commentableLines).toEqual([]);
      expect(sub?.symbols).toEqual([]);
      const app = byPath.get("src/app.ts");
      expect(app?.skipReason).toBeUndefined();
      expect(app?.language).toBe("typescript");
      expect(app?.hunks).toEqual([
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "del", oldLine: 1, newLine: null, position: 1, text: "const a = 1;" },
            { kind: "add", oldLine: null, newLine: 1, position: 2, text: "const a = 2;" },
          ],
        },
      ]);
      expect(app?.commentableLines).toEqual([1]);
      expect(app?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 1, changedLines: [1] },
      ]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E03 patch cap seam with oversize lockfile", () => {
  test("default cap unchanged and per-stream; 64KiB patch overflows before lockfile skip", async () => {
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(26 * 1024 * 1024);
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/app.ts"), "const a = 1;\n");
      const appOutside = join(outside, "app");
      await writeFile(appOutside, "const a = 1;\n");
      const appBlob = await git(dir, ["hash-object", "-w", appOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${appBlob},src/app.ts`]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/app.ts"), "const a = 2;\n");
      const app2Outside = join(outside, "app2");
      await writeFile(app2Outside, "const a = 2;\n");
      const app2Blob = await git(dir, ["hash-object", "-w", app2Outside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${app2Blob},src/app.ts`]);
      const lockLines = Array.from({ length: 7000 }, (_, i) => `pkg-${i} ${"x".repeat(10)} ${i}`);
      const lockContent = `# lock\n${lockLines.join("\n")}\n`;
      expect(Buffer.byteLength(lockContent)).toBeGreaterThan(64 * 1024);
      await writeFile(join(dir, "yarn.lock"), lockContent);
      const lockOutside = join(outside, "lock");
      await writeFile(lockOutside, lockContent);
      const lockBlob = await git(dir, ["hash-object", "-w", lockOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${lockBlob},yarn.lock`]);
      const head = await commitIndex(dir, "head");
      const normal = await runEngine(dir, base, head);
      expect(normal.files.find((file) => file.path === "yarn.lock")?.skipReason).toBe("lockfile");
      // RED with the injectable 64KiB patch-only cap: currently GIT_FAILED output-limit overflow.
      const capped = await runEngine(dir, base, head, defaults(), 64 * 1024);
      const byPath = new Map(capped.files.map((file) => [file.path, file]));
      expect(byPath.get("yarn.lock")?.skipReason).toBe("lockfile");
      expect(byPath.get("yarn.lock")?.hunks).toEqual([]);
      expect(byPath.get("src/app.ts")?.skipReason).toBeUndefined();
      expect(byPath.get("src/app.ts")?.language).toBe("typescript");
      expect(byPath.get("src/app.ts")?.hunks).toEqual([
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "del", oldLine: 1, newLine: null, position: 1, text: "const a = 1;" },
            { kind: "add", oldLine: null, newLine: 1, position: 2, text: "const a = 2;" },
          ],
        },
      ]);
      expect(byPath.get("src/app.ts")?.commentableLines).toEqual([1]);
      expect(byPath.get("src/app.ts")?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 1, changedLines: [1] },
      ]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E04 oversize blob with smallest valid max_file_size_kb", () => {
  test("large.txt too-large plus app.ts normal under 64KiB patch cap", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/app.ts"), "const a = 1;\n");
      const appOutside = join(outside, "app");
      await writeFile(appOutside, "const a = 1;\n");
      const appBlob = await git(dir, ["hash-object", "-w", appOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${appBlob},src/app.ts`]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/app.ts"), "const a = 2;\n");
      const app2Outside = join(outside, "app2");
      await writeFile(app2Outside, "const a = 2;\n");
      const app2Blob = await git(dir, ["hash-object", "-w", app2Outside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${app2Blob},src/app.ts`]);
      const bigLines = Array.from({ length: 7000 }, (_, i) => `line-${i} ${"y".repeat(10)}`);
      const bigContent = `${bigLines.join("\n")}\n`;
      expect(Buffer.byteLength(bigContent)).toBeGreaterThan(64 * 1024);
      await writeFile(join(dir, "large.txt"), bigContent);
      const bigOutside = join(outside, "big");
      await writeFile(bigOutside, bigContent);
      const bigBlob = await git(dir, ["hash-object", "-w", bigOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${bigBlob},large.txt`]);
      const head = await commitIndex(dir, "head");
      // Smallest valid Zod value (positive int) below the 26623 ceiling.
      const config = defaults({ review: { max_file_size_kb: 1 } });
      expect(config.review.max_file_size_kb).toBe(1);
      // RED: currently GIT_FAILED overflow before the too-large filter runs.
      const result = await runEngine(dir, base, head, config, 64 * 1024);
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      expect(byPath.get("large.txt")?.skipReason).toBe("too-large");
      expect(byPath.get("large.txt")?.hunks).toEqual([]);
      expect(byPath.get("large.txt")?.commentableLines).toEqual([]);
      expect(byPath.get("large.txt")?.symbols).toEqual([]);
      expect(byPath.get("src/app.ts")?.skipReason).toBeUndefined();
      expect(byPath.get("src/app.ts")?.language).toBe("typescript");
      expect(byPath.get("src/app.ts")?.hunks).toEqual([
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "del", oldLine: 1, newLine: null, position: 1, text: "const a = 1;" },
            { kind: "add", oldLine: null, newLine: 1, position: 2, text: "const a = 2;" },
          ],
        },
      ]);
      expect(byPath.get("src/app.ts")?.commentableLines).toEqual([1]);
      expect(byPath.get("src/app.ts")?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 1, changedLines: [1] },
      ]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E05 deletion-only keeps hardcoded hunk and module symbol", () => {
  test("deleting guard line 2 yields @@ -1,4 +1,3 @@, commentable [1,2,3], empty changedLines", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      const baseContent = "export function f(x?: string) {\n  if (!x) return 0;\n  return x.length;\n}\n";
      await writeFile(join(dir, "src/f.ts"), baseContent);
      const baseOutside = join(outside, "base");
      await writeFile(baseOutside, baseContent);
      const baseBlob = await git(dir, ["hash-object", "-w", baseOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${baseBlob},src/f.ts`]);
      const base = await commitIndex(dir, "base");
      const headContent = "export function f(x?: string) {\n  return x.length;\n}\n";
      await writeFile(join(dir, "src/f.ts"), headContent);
      const headOutside = join(outside, "head");
      await writeFile(headOutside, headContent);
      const headBlob = await git(dir, ["hash-object", "-w", headOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${headBlob},src/f.ts`]);
      const head = await commitIndex(dir, "head");
      const result = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      expect(file?.path).toBe("src/f.ts");
      expect(file?.language).toBe("typescript");
      expect(file?.skipReason).toBeUndefined();
      expect(file?.hunks).toEqual([
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 1, text: "export function f(x?: string) {" },
            { kind: "del", oldLine: 2, newLine: null, position: 2, text: "  if (!x) return 0;" },
            { kind: "ctx", oldLine: 3, newLine: 2, position: 3, text: "  return x.length;" },
            { kind: "ctx", oldLine: 4, newLine: 3, position: 4, text: "}" },
          ],
        },
      ]);
      expect(file?.commentableLines).toEqual([1, 2, 3]);
      expect(file?.symbols).toEqual([
        { name: "<module>", kind: "module", startLine: 1, endLine: 3, changedLines: [] },
      ]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test.todo("Phase 3 anchors deletion-only module symbol to nearest surviving head-side line through hunk");
});

describe("E06 empty TypeScript file", () => {
  test("added empty .ts has no hunks, lines, or symbols", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/keep.ts"), "const a = 1;\n");
      const keepOutside = join(outside, "keep");
      await writeFile(keepOutside, "const a = 1;\n");
      const keepBlob = await git(dir, ["hash-object", "-w", keepOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${keepBlob},src/keep.ts`]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/empty.ts"), "");
      const emptyOutside = join(outside, "empty");
      await writeFile(emptyOutside, "");
      const emptyBlob = await git(dir, ["hash-object", "-w", emptyOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${emptyBlob},src/empty.ts`]);
      const head = await commitIndex(dir, "head");
      const result = await runEngine(dir, base, head);
      const added = result.files.find((file) => file.path === "src/empty.ts");
      expect(added).toMatchObject({ status: "added", oldPath: null, language: "typescript" });
      expect(added?.skipReason).toBeUndefined();
      expect(added?.hunks).toEqual([]);
      expect(added?.commentableLines).toEqual([]);
      expect(added?.symbols).toEqual([]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E07 mode-only change via update-index", () => {
  test("chmod +x keeps empty hunks and no symbol", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
      const runOutside = join(outside, "run");
      await writeFile(runOutside, "#!/bin/sh\necho hi\n");
      const runBlob = await git(dir, ["hash-object", "-w", runOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${runBlob},run.sh`]);
      const base = await commitIndex(dir, "base");
      await git(dir, ["update-index", "--chmod=+x", "run.sh"]);
      const head = await commitIndex(dir, "head");
      const result = await runEngine(dir, base, head);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ path: "run.sh", status: "modified" });
      expect(result.files[0]?.skipReason).toBeUndefined();
      expect(result.files[0]?.hunks).toEqual([]);
      expect(result.files[0]?.commentableLines).toEqual([]);
      expect(result.files[0]?.symbols).toEqual([]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E08 symlink target edit via plumbing", () => {
  test("symlink target change skips as unsupported-mode with empty hunks/lines/symbols", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/app.ts"), "const a = 1;\n");
      const appOutside = join(outside, "app");
      await writeFile(appOutside, "const a = 1;\n");
      const appBlob = await git(dir, ["hash-object", "-w", appOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${appBlob},src/app.ts`]);
      const linkAOutside = join(outside, "link-a");
      await writeFile(linkAOutside, "target-a");
      const linkABlob = await git(dir, ["hash-object", "-w", linkAOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `120000,${linkABlob},link`]);
      const base = await commitIndex(dir, "base");
      const linkBOutside = join(outside, "link-b");
      await writeFile(linkBOutside, "target-b");
      const linkBBlob = await git(dir, ["hash-object", "-w", linkBOutside]);
      await git(dir, ["update-index", "--cacheinfo", `120000,${linkBBlob},link`]);
      const head = await commitIndex(dir, "head");
      const result = await runEngine(dir, base, head);
      const link = result.files.find((file) => file.path === "link");
      expect(link?.status).toBe("modified");
      expect(link?.language).toBeNull();
      expect(link?.skipReason).toBe("unsupported-mode");
      expect(link?.hunks).toEqual([]);
      expect(link?.commentableLines).toEqual([]);
      expect(link?.symbols).toEqual([]);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("E09 CLI diff validation and INVALID_INPUT policy", () => {
  test("INVALID_INPUT maps to exit 2 and runtime stays 1", () => {
    expect(exitCodeForError(new ReviewerError({ code: "INVALID_INPUT", message: "bad rev" }))).toBe(2);
    expect(exitCodeForError(new ReviewerError({ code: "GIT_FAILED", message: "git" }))).toBe(1);
    expect(exitCodeForError(new ReviewerError({ code: "CONFIG_INVALID", message: "cfg" }))).toBe(2);
  });

  test("validation matrix exits 0/2/2/2/1/2/2/2 with HEAD~1 and INVALID_INPUT rows", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/a.ts"), "const a = 1;\n");
      const aOutside = join(outside, "a");
      await writeFile(aOutside, "const a = 1;\n");
      const aBlob = await git(dir, ["hash-object", "-w", aOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${aBlob},src/a.ts`]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/a.ts"), "const a = 2;\n");
      const a2Outside = join(outside, "a2");
      await writeFile(a2Outside, "const a = 2;\n");
      const a2Blob = await git(dir, ["hash-object", "-w", a2Outside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${a2Blob},src/a.ts`]);
      const head = await commitIndex(dir, "head");
      const valid = await runCli(["diff", "--base", base, "--head", head, "--repo", dir], dir);
      expect(valid.code).toBe(0);
      const parsed = JSON.parse(valid.stdout) as {
        baseSha: string;
        headSha: string;
        mergeBase: string;
        files: Array<{ path: string }>;
      };
      expect(parsed.baseSha).toBe(base.toLowerCase());
      expect(parsed.headSha).toBe(head.toLowerCase());
      expect(parsed.mergeBase).toBe(base.toLowerCase());
      expect(isFullCommitSha(parsed.baseSha)).toBe(true);
      expect(isFullCommitSha(parsed.headSha)).toBe(true);
      expect(parsed.files.map((file) => file.path)).toEqual(["src/a.ts"]);
      expect(valid.stderr.length).toBeGreaterThan(0);
      expect(await git(dir, ["rev-parse", "HEAD~1"])).toBe(base);
      const missingBase = await runCli(["diff", "--head", head, "--repo", dir], dir);
      expect(missingBase.code).toBe(2);
      const missingHead = await runCli(["diff", "--base", base, "--repo", dir], dir);
      expect(missingHead.code).toBe(2);
      const unknownFlag = await runCli(["diff", "--bogus"], dir);
      expect(unknownFlag.code).toBe(2);
      const malformed = await runCli(["diff", "--base", "not-a-sha", "--head", head, "--repo", dir], dir);
      expect(malformed.code).toBe(2);
      expect(malformed.stderr).toMatch(/INVALID_INPUT/);
      const missingCommit = "0123456789abcdef0123456789abcdef01234567";
      const unresolved = await runCli(["diff", "--base", base, "--head", missingCommit, "--repo", dir], dir);
      expect(unresolved.code).toBe(1);
      expect(unresolved.stderr).toMatch(/fetch sufficient history/i);
      expect(unresolved.stderr).toMatch(/headSha/);
      // RED: dash-prefixed input must reach revision validation as INVALID_INPUT exit 2,
      // not arg-parse rejection. Equals-form carries the dash value through to the engine.
      const dashPrefixed = await runCli(
        ["diff", "--base=--verify", "--head", head, "--repo", dir],
        dir,
      );
      expect(dashPrefixed.code).toBe(2);
      expect(dashPrefixed.stderr).toMatch(/INVALID_INPUT/);
      const blobId = await git(dir, ["hash-object", "-w", a2Outside]);
      const nonCommit = await runCli(["diff", "--base", blobId, "--head", head, "--repo", dir], dir);
      expect(nonCommit.code).toBe(2);
      expect(nonCommit.stderr).toMatch(/INVALID_INPUT/);
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("rev-parse policy uses verify with end-of-options and commit check", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/a.ts"), "const a = 1;\n");
      const aOutside = join(outside, "a");
      await writeFile(aOutside, "const a = 1;\n");
      const aBlob = await git(dir, ["hash-object", "-w", aOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${aBlob},src/a.ts`]);
      const head = await commitIndex(dir, "only");
      expect(isFullCommitSha(head)).toBe(true);
      expect(isFullCommitSha("--verify")).toBe(false);
      expect(normalizeCommitSha(head.toUpperCase(), "baseSha")).toBe(head.toLowerCase());
      // RED: dash-prefixed shape must be INVALID_INPUT naming the label, not GIT_FAILED.
      let dashError: unknown = null;
      try {
        normalizeCommitSha("--verify", "baseSha");
      } catch (error) {
        dashError = error;
      }
      expect(codeOf(dashError)).toBe("INVALID_INPUT");
      expect((dashError as Error).message).toMatch(/baseSha/);
      // Oldest supported Git understands --end-of-options for rev verification.
      const verified = await git(dir, ["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`]);
      expect(verified.toLowerCase()).toBe(head.toLowerCase());
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("abbreviated SHA resolves uniquely instead of failing as full-SHA-only", async () => {
    const { dir, cleanup } = await makeRepo();
    let outside: string | null = null;
    try {
      outside = await mkdtemp(join(tmpdir(), "codebleach-edge-out-"));
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/a.ts"), "const a = 1;\n");
      const aOutside = join(outside, "a");
      await writeFile(aOutside, "const a = 1;\n");
      const aBlob = await git(dir, ["hash-object", "-w", aOutside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${aBlob},src/a.ts`]);
      const base = await commitIndex(dir, "base");
      await writeFile(join(dir, "src/a.ts"), "const a = 2;\n");
      const a2Outside = join(outside, "a2");
      await writeFile(a2Outside, "const a = 2;\n");
      const a2Blob = await git(dir, ["hash-object", "-w", a2Outside]);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${a2Blob},src/a.ts`]);
      const head = await commitIndex(dir, "head");
      // RED: CLI must resolve a unique abbrev to its full commit; DiffEngine stays full-SHA-only.
      const abbrev = base.slice(0, 7);
      const resolved = await runCli(["diff", "--base", abbrev, "--head", head, "--repo", dir], dir);
      expect(resolved.code).toBe(0);
      expect(() => normalizeCommitSha(abbrev, "baseSha")).toThrow();
    } finally {
      if (outside !== null) await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  test.todo("ambiguous abbrev errors without a nondeterministic collision fixture");
});
