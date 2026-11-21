import { describe, expect, test } from "bun:test";
import { ConfigFileSchema, type ResolvedConfig } from "../../src/config/schema.ts";
import type { Category, Finding, Severity } from "../../src/types/index.ts";
import {
  CATEGORY_POLICY_GROUP,
  POLICY_GROUP_MEMBERS,
  resolveEffectivePolicy,
  validatePolicy,
  type PolicyConfigGroup,
} from "../../src/validate/policy.ts";

function policyFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    fingerprint: "fp-finding-1",
    headSha: "c".repeat(40),
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "bug",
    file: "src/a.ts",
    line: 1,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "code" }],
    introducedByPr: true,
    ...overrides,
  };
}

function configWith(raw: unknown): ResolvedConfig {
  return ConfigFileSchema.parse(raw);
}

describe("category to toggle mapping", () => {
  test("covers every category with exactly one group outcome", () => {
    expect(CATEGORY_POLICY_GROUP).toEqual({
      bug: "bugs",
      "null-handling": "bugs",
      security: "security",
      concurrency: "concurrency",
      "error-handling": "bugs",
      "breaking-change": "bugs",
      "resource-leak": "bugs",
      performance: "performance",
      "api-usage": "bugs",
      convention: "convention",
    });
  });

  test("disabled toggle rejects its members and convention still passes", () => {
    const config = configWith({ review: { categories: { bugs: false } } });
    for (const category of ["bug", "null-handling", "error-handling"] as const) {
      const result = validatePolicy({ finding: policyFinding({ category }), canonicalPath: "src/a.ts", config });
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === "category_policy" && !check.passed)).toBe(true);
    }
    const convention = validatePolicy({
      finding: policyFinding({ category: "convention" }),
      canonicalPath: "src/a.ts",
      config: configWith({ review: { categories: { bugs: false, security: false } } }),
    });
    expect(convention.ok).toBe(true);
  });

  test("group members agree with the category map, each category exactly once", () => {
    const seen = new Set<Category>();
    for (const [group, members] of Object.entries(POLICY_GROUP_MEMBERS) as Array<
      [PolicyConfigGroup, readonly Category[]]
    >) {
      for (const category of members) {
        expect(seen.has(category)).toBe(false);
        seen.add(category);
        expect(CATEGORY_POLICY_GROUP[category]).toBe(group);
      }
    }
    expect(seen.size).toBe(Object.keys(CATEGORY_POLICY_GROUP).length - 1);
    expect(CATEGORY_POLICY_GROUP.convention).toBe("convention");
  });

  test("each group toggle gates only its own members", () => {
    const members: Array<{ group: "security" | "performance" | "concurrency"; category: Category }> = [
      { group: "security", category: "security" },
      { group: "performance", category: "performance" },
      { group: "concurrency", category: "concurrency" },
    ];
    for (const { group, category } of members) {
      const off = configWith({
        review: { categories: { bugs: true, security: true, performance: true, concurrency: true, [group]: false } },
      });
      expect(validatePolicy({ finding: policyFinding({ category }), canonicalPath: "src/a.ts", config: off }).ok).toBe(
        false,
      );
      const other = members.find((entry) => entry.group !== group) as { category: Category };
      expect(
        validatePolicy({ finding: policyFinding({ category: other.category }), canonicalPath: "src/a.ts", config: off })
          .ok,
      ).toBe(true);
    }
  });
});

describe("severity thresholds", () => {
  test("severity order critical above high above medium above low above info", () => {
    const config = configWith({ review: { severity_threshold: "medium" } });
    const expectations: Array<{ severity: Severity; ok: boolean }> = [
      { severity: "critical", ok: true },
      { severity: "high", ok: true },
      { severity: "medium", ok: true },
      { severity: "low", ok: false },
      { severity: "info", ok: false },
    ];
    for (const { severity, ok } of expectations) {
      const result = validatePolicy({ finding: policyFinding({ severity }), canonicalPath: "src/a.ts", config });
      expect(result.ok).toBe(ok);
      expect(result.checks.some((check) => check.name === "severity_policy" && check.passed === ok)).toBe(true);
    }
  });

  test("below threshold rejects with a stable code, never silently", () => {
    const config = configWith({ review: { severity_threshold: "critical" } });
    const result = validatePolicy({
      finding: policyFinding({ severity: "high" }),
      canonicalPath: "src/a.ts",
      config,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find((entry) => entry.name === "severity_policy");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("high");
    expect(check?.detail).toContain("critical");
  });
});

describe("confidence thresholds", () => {
  test("at threshold passes and just below fails", () => {
    const config = configWith({ review: { confidence_threshold: 0.7 } });
    expect(validatePolicy({ finding: policyFinding({ confidence: 0.7 }), canonicalPath: "src/a.ts", config }).ok).toBe(
      true,
    );
    const below = validatePolicy({
      finding: policyFinding({ confidence: 0.69 }),
      canonicalPath: "src/a.ts",
      config,
    });
    expect(below.ok).toBe(false);
    expect(below.checks.some((check) => check.name === "confidence_policy" && !check.passed)).toBe(true);
  });
});

describe("threshold precedence", () => {
  test("category override beats the global threshold", () => {
    const config = configWith({
      review: {
        severity_threshold: "critical",
        category_overrides: { bugs: { severity_threshold: "low" } },
      },
    });
    expect(
      validatePolicy({
        finding: policyFinding({ severity: "low", category: "bug" }),
        canonicalPath: "src/a.ts",
        config,
      }).ok,
    ).toBe(true);
    expect(
      validatePolicy({
        finding: policyFinding({ severity: "low", category: "security" }),
        canonicalPath: "src/a.ts",
        config,
      }).ok,
    ).toBe(false);
  });

  test("path override beats the category override", () => {
    const config = configWith({
      review: {
        severity_threshold: "low",
        category_overrides: { bugs: { severity_threshold: "low" } },
      },
      path_overrides: [{ paths: ["src/**"], review: { severity_threshold: "critical" } }],
    });
    const strict = validatePolicy({
      finding: policyFinding({ severity: "high", category: "bug" }),
      canonicalPath: "src/a.ts",
      config,
    });
    expect(strict.ok).toBe(false);
    const elsewhere = validatePolicy({
      finding: policyFinding({ severity: "high", category: "bug" }),
      canonicalPath: "lib/a.ts",
      config,
    });
    expect(elsewhere.ok).toBe(true);
  });

  test("overlapping path overrides merge in config order, later wins per field", () => {
    const config = configWith({
      review: { severity_threshold: "low", confidence_threshold: 0.1 },
      path_overrides: [
        { paths: ["src/**"], review: { severity_threshold: "critical", confidence_threshold: 0.99 } },
        { paths: ["src/a.ts"], review: { severity_threshold: "low" } },
      ],
    });
    const effective = resolveEffectivePolicy(config, "src/a.ts");
    expect(effective.severityThreshold).toBe("low");
    expect(effective.confidenceThreshold).toBe(0.99);
  });

  test("path override merges categories per toggle without touching the rest", () => {
    const config = configWith({
      path_overrides: [{ paths: ["tests/**"], review: { categories: { performance: false } } }],
    });
    const effective = resolveEffectivePolicy(config, "tests/a.ts");
    expect(effective.categories.performance).toBe(false);
    expect(effective.categories.bugs).toBe(true);
    expect(effective.categories.security).toBe(true);
  });

  test("canonical head-side path selects overrides, not the raw model path", () => {
    const config = configWith({
      path_overrides: [{ paths: ["src/new.ts"], review: { severity_threshold: "critical" } }],
    });
    const renamed = validatePolicy({
      finding: policyFinding({ severity: "high", file: "src/old.ts" }),
      canonicalPath: "src/new.ts",
      config,
    });
    expect(renamed.ok).toBe(false);
    const oldPath = validatePolicy({
      finding: policyFinding({ severity: "high", file: "src/old.ts" }),
      canonicalPath: "src/old.ts",
      config,
    });
    expect(oldPath.ok).toBe(true);
  });
});

describe("explicit rule references", () => {
  const ruleConfig = configWith({
    rules: [{ id: "arch-001", kind: "architecture", text: "No logic in controllers.", paths: ["src/**"] }],
  });

  test("unknown rule id fails closed", () => {
    const result = validatePolicy({
      finding: policyFinding({ ruleId: "ghost-rule" }),
      canonicalPath: "src/a.ts",
      config: ruleConfig,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.name === "rule_policy" && !check.passed)).toBe(true);
  });

  test("rule path mismatch fails", () => {
    const result = validatePolicy({
      finding: policyFinding({ ruleId: "arch-001" }),
      canonicalPath: "lib/a.ts",
      config: ruleConfig,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.name === "rule_policy" && !check.passed)).toBe(true);
  });

  test("matching rule passes and unscoped rules apply everywhere", () => {
    const unscoped = configWith({ rules: [{ id: "any", kind: "testing", text: "Cover it." }] });
    const scoped = validatePolicy({
      finding: policyFinding({ ruleId: "arch-001" }),
      canonicalPath: "src/a.ts",
      config: ruleConfig,
    });
    expect(scoped.ok).toBe(true);
    const anywhere = validatePolicy({
      finding: policyFinding({ ruleId: "any" }),
      canonicalPath: "lib/a.ts",
      config: unscoped,
    });
    expect(anywhere.ok).toBe(true);
  });

  test("rule severity is the effective severity and is recorded, never mutated", () => {
    const config = configWith({
      review: { severity_threshold: "medium" },
      rules: [{ id: "soft", kind: "convention", text: "Prefer early returns.", severity: "low" }],
    });
    const finding = policyFinding({ severity: "high", ruleId: "soft" });
    const result = validatePolicy({ finding, canonicalPath: "src/a.ts", config });
    expect(result.ok).toBe(false);
    expect(finding.severity).toBe("high");
    const check = result.checks.find((entry) => entry.name === "rule_policy");
    expect(check?.passed).toBe(true);
    expect(check?.detail).toContain("low");
  });

  test("no rule id stays valid when every other check passes", () => {
    const result = validatePolicy({
      finding: policyFinding(),
      canonicalPath: "src/a.ts",
      config: configWith({}),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.name === "rule_policy" && check.passed)).toBe(true);
  });
});
