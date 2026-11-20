import { describe, expect, test } from "bun:test";
import { ConfigFileSchema, type ResolvedConfig } from "../../src/config/schema.ts";
import type { Logger } from "../../src/core/logger.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import {
  fingerprintForFinding,
  normalizeFinding,
  normalizeRepoPath,
} from "../../src/review/normalize.ts";
import type { ReviewUnit } from "../../src/types/context.ts";
import type { RawFinding } from "../../src/types/finding.ts";
import type { Rule } from "../../src/types/rules.ts";

const OPT_IN = { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" };

function nullLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function rule(overrides: Partial<Rule> & { id: string }): Rule {
  return { kind: "security", text: `rule text for ${overrides.id}`, ...overrides };
}

function unit(overrides: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    id: "unit-1",
    file: {
      path: "src/auth.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [10, 11, 12],
    },
    diff: {
      hunks: [
        {
          oldStart: 8,
          oldLines: 5,
          newStart: 8,
          newLines: 5,
          lines: [
            { kind: "ctx", oldLine: 8, newLine: 8, position: 0, text: "export function check(" },
            { kind: "del", oldLine: 9, newLine: null, position: 1, text: "if (user) return true;" },
            { kind: "add", oldLine: null, newLine: 9, position: 2, text: "if (user != null) return true;" },
          ],
        },
      ],
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: {
      name: "check",
      kind: "function",
      container: "auth",
      startLine: 8,
      endLine: 14,
      changedLines: [9],
    },
    context: [],
    rules: [rule({ id: "no-truthy-auth", text: "Never use truthiness for auth checks." })],
    ...overrides,
  };
}

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/auth.ts",
    line: 9,
    description: "name may be null at runtime; trim would throw.",
    confidence: 0.9,
    evidence: [{ file: "src/auth.ts", startLine: 9, endLine: 9, quote: "name.trim()" }],
    introducedByPr: true,
    ...overrides,
  };
}

function configWith(llm: Record<string, number> = {}): ResolvedConfig {
  return ConfigFileSchema.parse({ llm });
}

describe("normalizeRepoPath", () => {
  test("accepts plain repo-relative paths", () => {
    expect(normalizeRepoPath("src/auth.ts")).toBe("src/auth.ts");
  });

  test("trims and normalizes separators", () => {
    expect(normalizeRepoPath("  src\\auth.ts  ")).toBe("src/auth.ts");
  });

  test("collapses duplicate slashes and dot prefixes", () => {
    expect(normalizeRepoPath("src//auth.ts")).toBe("src/auth.ts");
    expect(normalizeRepoPath("./src/auth.ts")).toBe("src/auth.ts");
  });

  test("rejects absolute paths", () => {
    expect(normalizeRepoPath("/etc/passwd")).toBeNull();
    expect(normalizeRepoPath("C:/Windows/x.ts")).toBeNull();
    expect(normalizeRepoPath("C:\\Windows\\x.ts")).toBeNull();
    expect(normalizeRepoPath("C:foo/bar.ts")).toBeNull();
  });

  test("rejects traversal segments", () => {
    expect(normalizeRepoPath("../secret.ts")).toBeNull();
    expect(normalizeRepoPath("src/../../etc/passwd")).toBeNull();
    expect(normalizeRepoPath("src/..\\x.ts")).toBeNull();
  });

  test("rejects blank paths", () => {
    expect(normalizeRepoPath("   ")).toBeNull();
  });
});

describe("finding fingerprint", () => {
  test("stable across title case and whitespace variants", () => {
    const base = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "check",
      category: "null-handling",
      title: "Null dereference on name",
    });
    const variant = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "check",
      category: "null-handling",
      title: "  null   DEREFERENCE\non  name ",
    });
    expect(variant).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });

  test("stable across path separator variants", () => {
    const posix = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "check",
      category: "null-handling",
      title: "Null dereference on name",
    });
    const windows = fingerprintForFinding({
      file: "src\\auth.ts",
      symbol: "check",
      category: "null-handling",
      title: "Null dereference on name",
    });
    expect(windows).toBe(posix);
  });

  test("differs across categories", () => {
    const a = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "check",
      category: "null-handling",
      title: "Null dereference on name",
    });
    const b = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "check",
      category: "security",
      title: "Null dereference on name",
    });
    expect(b).not.toBe(a);
  });

  test("differs across symbols", () => {
    const a = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "check",
      category: "null-handling",
      title: "Null dereference on name",
    });
    const b = fingerprintForFinding({
      file: "src/auth.ts",
      symbol: "verify",
      category: "null-handling",
      title: "Null dereference on name",
    });
    expect(b).not.toBe(a);
  });

  test("fallback collapses separators like the stored path", () => {
    const base = {
      symbol: "check",
      category: "null-handling",
      title: "Null dereference on name",
    };
    const collapsed = fingerprintForFinding({ ...base, file: "../src/auth.ts" });
    expect(fingerprintForFinding({ ...base, file: "..//src/auth.ts" })).toBe(collapsed);
    expect(fingerprintForFinding({ ...base, file: "./../src/auth.ts" })).toBe(collapsed);
  });
});

describe("normalizeFinding", () => {
  test("attaches code-owned metadata", () => {
    const found = normalizeFinding(raw(), { unit: unit({ id: "u-1" }), headSha: "head-abc" });
    expect(found?.symbol).toBe("check");
    expect(found?.origin).toEqual({ pass: "code-review-v1", unitId: "u-1" });
    expect(found?.headSha).toBe("head-abc");
    expect(found?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(found?.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  test("accepts a known ruleId", () => {
    const found = normalizeFinding(raw({ ruleId: "no-truthy-auth" }), {
      unit: unit(),
      headSha: "head-abc",
    });
    expect(found?.ruleId).toBe("no-truthy-auth");
  });

  test("rejects unknown ruleId", () => {
    expect(
      normalizeFinding(raw({ ruleId: "no-such-rule" }), { unit: unit(), headSha: "h" }),
    ).toBeNull();
  });

  test("rejects absolute finding paths", () => {
    expect(
      normalizeFinding(raw({ file: "/etc/passwd" }), { unit: unit(), headSha: "h" }),
    ).toBeNull();
  });

  test("rejects traversal in evidence paths", () => {
    expect(
      normalizeFinding(
        raw({ evidence: [{ file: "../secret.ts", startLine: 1, endLine: 1, quote: "x" }] }),
        { unit: unit(), headSha: "h" },
      ),
    ).toBeNull();
  });

  test("rejects blank evidence quotes", () => {
    expect(
      normalizeFinding(
        raw({ evidence: [{ file: "src/auth.ts", startLine: 9, endLine: 9, quote: "   " }] }),
        { unit: unit(), headSha: "h" },
      ),
    ).toBeNull();
  });

  test("rejects blank titles", () => {
    expect(normalizeFinding(raw({ title: "   " }), { unit: unit(), headSha: "h" })).toBeNull();
  });

  test("preserves introducedByPr as unverified model assertion", () => {
    const yes = normalizeFinding(raw({ introducedByPr: true }), { unit: unit(), headSha: "h" });
    const no = normalizeFinding(raw({ introducedByPr: false }), { unit: unit(), headSha: "h" });
    expect(yes?.introducedByPr).toBe(true);
    expect(no?.introducedByPr).toBe(false);
  });
});

describe("engine normalization", () => {
  test("drops absolute-path findings but keeps valid siblings", async () => {
    const provider = new FakeProvider([
      {
        respond: {
          findings: [
            { ...raw(), file: "/etc/passwd" },
            { ...raw(), title: "Real bug here" },
          ],
        },
      },
    ]);
    const engine = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { ...OPT_IN },
      headSha: "head-abc",
    });
    const { findings } = await engine.review([unit()], configWith());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Real bug here");
    expect(findings[0]?.file).toBe("src/auth.ts");
  });

  test("drops unknown-ruleId findings", async () => {
    const provider = new FakeProvider([
      { respond: { findings: [{ ...raw(), ruleId: "invented-rule" }] } },
    ]);
    const engine = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { ...OPT_IN },
      headSha: "head-abc",
    });
    await expect(engine.review([unit()], configWith()).then((result) => result.findings)).resolves.toEqual([]);
  });

  test("ids differ between runs while fingerprints stay stable", async () => {
    const provider = new FakeProvider([
      { respond: { findings: [{ ...raw() }] } },
      { respond: { findings: [{ ...raw() }] } },
    ]);
    const engine = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { ...OPT_IN },
      headSha: "head-abc",
    });
    const first = (await engine.review([unit()], configWith())).findings;
    const second = (await engine.review([unit()], configWith())).findings;
    expect(first[0]?.fingerprint).toBe(second[0]?.fingerprint);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  test("headSha and origin come from code, never model output", async () => {
    const provider = new FakeProvider([
      {
        respond: {
          findings: [{ ...raw(), id: "model-id", fingerprint: "deadbeef", headSha: "evil" }],
        },
      },
      { respond: { findings: [{ ...raw() }] } },
    ]);
    const engine = new ReviewEngineImpl({
      provider,
      logger: nullLogger(),
      env: { ...OPT_IN },
      headSha: "head-abc",
    });
    const [finding] = (await engine.review([unit({ id: "u-9" })], configWith())).findings;
    expect(provider.calls).toHaveLength(2);
    expect(finding?.headSha).toBe("head-abc");
    expect(finding?.origin).toEqual({ pass: "code-review-v1", unitId: "u-9" });
    expect(finding?.symbol).toBe("check");
  });
});
