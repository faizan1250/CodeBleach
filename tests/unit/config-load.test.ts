import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { DEFAULT_IGNORE_PATHS } from "../../src/config/defaults.ts";
import { exitCodeForError } from "../../src/cli/exit-codes.ts";
import type { ReviewerError } from "../../src/core/errors.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codebleach-config-"));
  tempDirs.push(dir);
  return dir;
}

async function writeConfig(repoDir: string, name: string): Promise<void> {
  const source = await readFile(join("tests", "fixtures", "config", name), "utf8");
  await writeFile(join(repoDir, ".reviewer.yml"), source);
}

function codeOf(result: { ok: false; error: ReviewerError }): string {
  return result.error.code;
}

describe("loadConfig", () => {
  test("missing file returns defaults", async () => {
    const repoDir = await makeRepo();
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.source).toBe("defaults");
    expect(result.value.path).toBeUndefined();
    expect(result.value.config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS]);
    expect(result.value.config.rules).toEqual([]);
  });

  test("missing repo directory fails invalid", async () => {
    const repoDir = await makeRepo();
    const missing = join(repoDir, "does-not-exist");
    const result = await loadConfig(missing);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain("does not exist");
  });

  test("minimal file resolves defaults with file source", async () => {
    const repoDir = await makeRepo();
    await writeFile(join(repoDir, ".reviewer.yml"), "version: 1\n");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.source).toBe("file");
    expect(result.value.path).toContain(".reviewer.yml");
    expect(result.value.config.review.max_findings).toBe(10);
  });

  test("full fixture parses", async () => {
    const repoDir = await makeRepo();
    await writeConfig(repoDir, "valid-full.yml");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.config.review.severity_threshold).toBe("high");
    expect(result.value.config.repository.language).toBe("tsx");
    expect(result.value.config.rules).toHaveLength(1);
    expect(result.value.config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS, "gen/**"]);
  });

  test("example config parses", async () => {
    const repoDir = await makeRepo();
    const example = await readFile(".reviewer.yml.example", "utf8");
    await writeFile(join(repoDir, ".reviewer.yml"), example);
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.config.rules.map((rule) => rule.id)).toEqual(["arch-001"]);
    expect(result.value.config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS]);
  });

  test("typo key fails with dotted path", async () => {
    const repoDir = await makeRepo();
    await writeConfig(repoDir, "invalid-typo.yml");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain(".reviewer.yml");
  });

  test("wrong type and bad threshold fail invalid", async () => {
    const repoDir = await makeRepo();
    await writeFile(join(repoDir, ".reviewer.yml"), "version: 1\nreview:\n  max_findings: many\n");
    const wrongType = await loadConfig(repoDir);
    expect(wrongType.ok).toBe(false);

    await writeConfig(repoDir, "invalid-threshold.yml");
    const badThreshold = await loadConfig(repoDir);
    expect(badThreshold.ok).toBe(false);
    if (badThreshold.ok) throw new Error("unreachable");
    expect(codeOf(badThreshold)).toBe("CONFIG_INVALID");
    expect(badThreshold.error.message).toContain("review.confidence_threshold");
  });

  test("duplicate rule ids fail", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, ".reviewer.yml"),
      "rules:\n  - id: dup\n    kind: convention\n    text: a\n  - id: dup\n    kind: convention\n    text: b\n",
    );
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain("dup");
    expect(result.error.message).toContain("rules: duplicate");
    expect(result.error.message).not.toContain("rules.rules");
  });

  test("version 2 fails unsupported", async () => {
    const repoDir = await makeRepo();
    await writeFile(join(repoDir, ".reviewer.yml"), "version: 2\n");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("CONFIG_UNSUPPORTED_VERSION");
  });

  test("malformed yaml reports path and parser message without coords", async () => {
    const repoDir = await makeRepo();
    await writeConfig(repoDir, "malformed.yml");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain(".reviewer.yml: invalid YAML: ");
    expect(result.error.message).not.toMatch(/\.reviewer\.yml:\d+:\d+:/);
    const detail = result.error.message.split("invalid YAML: ")[1];
    expect(detail !== undefined && detail.length > 0).toBe(true);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect(exitCodeForError(result.error)).toBe(2);
  });

  test("malformed yaml at different lines reports no call-site coords", async () => {
    const repoDir = await makeRepo();
    const bodies = [
      "bad: [oops\n",
      "# pad\n# pad\n# pad\nbad: [oops\n",
      "# pad\n# pad\n# pad\n# pad\n# pad\n# pad\nbad: [oops\n",
    ];
    const prefixes = new Set<string>();
    for (const body of bodies) {
      await writeFile(join(repoDir, ".reviewer.yml"), body);
      const result = await loadConfig(repoDir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(codeOf(result)).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain(".reviewer.yml: invalid YAML: ");
      expect(result.error.message).not.toMatch(/\.reviewer\.yml:\d+:\d+:/);
      const prefix = result.error.message.split("invalid YAML:")[0];
      expect(prefix !== undefined).toBe(true);
      if (prefix !== undefined) prefixes.add(prefix);
    }
    expect(prefixes.size).toBe(1);
  });

  // Windows requires elevated privilege for file symlinks; Linux CI covers this case.
  const symlinkTest = process.platform === "win32" ? test.skip : test;
  symlinkTest("symlink escaping repo is rejected", async () => {
    const outside = await makeRepo();
    await writeFile(join(outside, "real.yml"), "version: 1\n");
    const repoDir = await makeRepo();
    await symlink(join(outside, "real.yml"), join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
  });

  symlinkTest("dangling symlink fails invalid instead of defaults", async () => {
    const repoDir = await makeRepo();
    await symlink(join(repoDir, "no-such-target.yml"), join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
  });

  symlinkTest("external symlink to a directory is rejected as escaping", async () => {
    const outside = await makeRepo();
    const repoDir = await makeRepo();
    await symlink(outside, join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain("repository root");
  });

  symlinkTest("symlink to a root file is accepted", async () => {
    const repoDir = await makeRepo();
    await writeFile(join(repoDir, "real.yml"), "version: 1\n");
    await symlink("real.yml", join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.source).toBe("file");
  });

  symlinkTest("relative symlink to a nested config is accepted", async () => {
    const repoDir = await makeRepo();
    await mkdir(join(repoDir, "config"));
    await writeFile(join(repoDir, "config", "reviewer.yml"), "version: 1\n");
    await symlink(join("config", "reviewer.yml"), join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.source).toBe("file");
  });

  symlinkTest("nested relative symlink with dotdot is accepted", async () => {
    const repoDir = await makeRepo();
    await mkdir(join(repoDir, "sub"));
    await writeFile(join(repoDir, "real.yml"), "version: 1\n");
    await symlink(join("sub", "..", "real.yml"), join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.source).toBe("file");
  });

  symlinkTest("absolute symlink inside repo is accepted", async () => {
    const repoDir = await makeRepo();
    await writeFile(join(repoDir, "real.yml"), "version: 1\n");
    await symlink(join(repoDir, "real.yml"), join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.source).toBe("file");
  });

  symlinkTest("symlink loop is rejected", async () => {
    const repoDir = await makeRepo();
    await symlink(join(repoDir, "b.yml"), join(repoDir, "a.yml"));
    await symlink(join(repoDir, "a.yml"), join(repoDir, "b.yml"));
    await symlink(join(repoDir, "a.yml"), join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
  });

  symlinkTest("symlink to a directory inside repo is rejected", async () => {
    const repoDir = await makeRepo();
    await mkdir(join(repoDir, "configdir"));
    await symlink("configdir", join(repoDir, ".reviewer.yml"));
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain("regular file");
  });

  test("malformed glob fails invalid with a path-specific message", async () => {
    const repoDir = await makeRepo();
    await writeFile(
      join(repoDir, ".reviewer.yml"),
      'version: 1\nignore:\n  paths:\n    - "src/{a,b}.ts"\n',
    );
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain("ignore.paths");
    expect(result.error.message).toContain("src/{a,b}.ts");
    expect(exitCodeForError(result.error)).toBe(2);
  });

  test("resolved config serializes to JSON", async () => {
    const repoDir = await makeRepo();
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const roundTripped = JSON.parse(JSON.stringify(result.value.config));
    expect(roundTripped.version).toBe(1);
  });

  test("Bun YAML parser is available", () => {
    expect(typeof Bun.YAML.parse).toBe("function");
    expect(Bun.YAML.parse("a: 1")).toMatchObject({ a: 1 });
  });
});
