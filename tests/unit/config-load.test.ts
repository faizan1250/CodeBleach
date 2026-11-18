import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { DEFAULT_IGNORE_PATHS } from "../../src/config/defaults.ts";
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
  });

  test("example config parses", async () => {
    const repoDir = await makeRepo();
    const example = await readFile(".reviewer.yml.example", "utf8");
    await writeFile(join(repoDir, ".reviewer.yml"), example);
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.config.rules.map((rule) => rule.id)).toEqual(["arch-001"]);
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
  });

  test("version 2 fails unsupported", async () => {
    const repoDir = await makeRepo();
    await writeFile(join(repoDir, ".reviewer.yml"), "version: 2\n");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("CONFIG_UNSUPPORTED_VERSION");
  });

  test("malformed yaml fails invalid with path", async () => {
    const repoDir = await makeRepo();
    await writeConfig(repoDir, "malformed.yml");
    const result = await loadConfig(repoDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(codeOf(result)).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain(".reviewer.yml");
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
