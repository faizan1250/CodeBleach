import type { Category, Finding, Severity } from "../types/index.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { CheckResult } from "../types/validation.ts";
import { makeCheck } from "./checks.ts";
import { matchGlob } from "../utils/glob.ts";

export type PolicyConfigGroup = "bugs" | "security" | "performance" | "concurrency";

/** `convention` has no config toggle; it always passes the category gate. */
export type CategoryPolicyGroup = PolicyConfigGroup | "convention";

export const POLICY_CONFIG_GROUPS: readonly PolicyConfigGroup[] = ["bugs", "security", "performance", "concurrency"];

// Single typed home for the ADR 0028 category-to-toggle mapping. The review
// prompt derives its families from this map instead of keeping a second copy.
export const CATEGORY_POLICY_GROUP: Record<Category, CategoryPolicyGroup> = {
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
};

function memberCategories(group: PolicyConfigGroup): Category[] {
  const all = Object.keys(CATEGORY_POLICY_GROUP) as Category[];
  return all.filter((category) => CATEGORY_POLICY_GROUP[category] === group);
}

export const POLICY_GROUP_MEMBERS: Record<PolicyConfigGroup, readonly Category[]> = {
  bugs: memberCategories("bugs"),
  security: memberCategories("security"),
  performance: memberCategories("performance"),
  concurrency: memberCategories("concurrency"),
};

// Shared with P5-07 dedupe: winner order compares effective severity first.
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

// Stable check names; P5-08 owns the code set (category_disabled,
// rule_id_unknown, rule_path_mismatch, severity_below_threshold,
// confidence_below_threshold).
export type PolicyCheckName = "category_policy" | "rule_policy" | "severity_policy" | "confidence_policy";

export interface EffectivePolicy {
  categories: Record<PolicyConfigGroup, boolean>;
  /** Path-override value when a matching entry defines one; category/global fill the rest. */
  severityThreshold: Severity | undefined;
  confidenceThreshold: number | undefined;
}

export interface PolicyInput {
  finding: Finding;
  /** P5-02 head-side identity; overrides match this path, never the raw model path. */
  canonicalPath: string;
  config: ResolvedConfig;
}

export interface PolicySuccess {
  ok: true;
  checks: CheckResult[];
  /** Rule severity wins when the cited rule defines one; the finding itself is never mutated. */
  effectiveSeverity: Severity;
}

export interface PolicyFailure {
  ok: false;
  checks: CheckResult[];
}

export type PolicyResult = PolicySuccess | PolicyFailure;

/**
 * Merge matching `path_overrides` in config order over the global review
 * policy. Later matching entries win per field; unspecified fields fall
 * through. No consumer of these overrides existed before validation, so this
 * config-order last-wins merge is the shared resolver for all call sites.
 * Only policy fields merge here: `max_findings` belongs to P5-07 dedupe and
 * size/time budgets belong to their own stages.
 */
export function resolveEffectivePolicy(config: ResolvedConfig, canonicalPath: string): EffectivePolicy {
  const categories: Record<PolicyConfigGroup, boolean> = { ...config.review.categories };
  let severityThreshold: Severity | undefined;
  let confidenceThreshold: number | undefined;
  for (const override of config.path_overrides) {
    if (!override.paths.some((pattern) => matchGlob(canonicalPath, pattern))) continue;
    const review = override.review;
    if (review.categories !== undefined) {
      for (const group of POLICY_CONFIG_GROUPS) {
        const value = review.categories[group];
        if (value !== undefined) categories[group] = value;
      }
    }
    if (review.severity_threshold !== undefined) severityThreshold = review.severity_threshold;
    if (review.confidence_threshold !== undefined) confidenceThreshold = review.confidence_threshold;
  }
  return { categories, severityThreshold, confidenceThreshold };
}

/**
 * P5-06 policy: category gate, explicit-rule reference, then severity and
 * confidence thresholds with path → category → global precedence. Pure, no
 * reads. Failures reject (policy-filtered, never silent); only a fully
 * passing finding stays accepted. Never reads the model `introducedByPr`.
 */
export function validatePolicy(input: PolicyInput): PolicyResult {
  const { finding, canonicalPath, config } = input;
  const checks: CheckResult[] = [];
  const fail = (name: PolicyCheckName, code: CheckResult["code"], detail: string): PolicyFailure => {
    checks.push(makeCheck(name, "failed", code, detail));
    return { ok: false, checks };
  };

  const effective = resolveEffectivePolicy(config, canonicalPath);
  const group = CATEGORY_POLICY_GROUP[finding.category];
  if (group === "convention") {
    checks.push(
      makeCheck("category_policy", "passed", "category_enabled", "convention has no toggle; category gate passes"),
    );
  } else {
    if (!effective.categories[group]) {
      return fail(
        "category_policy",
        "category_disabled",
        `category ${finding.category} is disabled via the ${group} toggle`,
      );
    }
    checks.push(makeCheck("category_policy", "passed", "category_enabled"));
  }

  let effectiveSeverity: Severity = finding.severity;
  if (finding.ruleId !== undefined) {
    const rule = config.rules.find((candidate) => candidate.id === finding.ruleId);
    if (rule === undefined) {
      return fail("rule_policy", "rule_id_unknown", `unknown ruleId ${JSON.stringify(finding.ruleId)}`);
    }
    if (rule.paths !== undefined && rule.paths.length > 0) {
      const applies = rule.paths.some((pattern) => matchGlob(canonicalPath, pattern));
      if (!applies) {
        return fail(
          "rule_policy",
          "rule_path_mismatch",
          `rule ${JSON.stringify(rule.id)} does not apply to ${canonicalPath}`,
        );
      }
    }
    if (rule.severity !== undefined) {
      effectiveSeverity = rule.severity;
      checks.push(
        makeCheck(
          "rule_policy",
          "passed",
          "rule_ok",
          `rule ${JSON.stringify(rule.id)} applies; effective severity ${rule.severity} (model: ${finding.severity})`,
        ),
      );
    } else {
      checks.push(makeCheck("rule_policy", "passed", "rule_ok", `rule ${JSON.stringify(rule.id)} applies`));
    }
  } else {
    checks.push(makeCheck("rule_policy", "passed", "rule_ok", "no explicit rule claimed"));
  }

  // Documented policy (.reviewer.yml.example): a violation may use the rule
  // severity, so the threshold compares against the effective severity above.
  // Precedence per field: path override → category override → global.
  const groupOverride = group === "convention" ? undefined : config.review.category_overrides[group];
  const severityThreshold =
    effective.severityThreshold ?? groupOverride?.severity_threshold ?? config.review.severity_threshold;
  if (SEVERITY_RANK[effectiveSeverity] < SEVERITY_RANK[severityThreshold]) {
    return fail(
      "severity_policy",
      "severity_below_threshold",
      `severity ${effectiveSeverity} is below threshold ${severityThreshold}`,
    );
  }
  checks.push(
    makeCheck("severity_policy", "passed", "severity_ok", `severity ${effectiveSeverity} meets ${severityThreshold}`),
  );

  const confidenceThreshold =
    effective.confidenceThreshold ?? groupOverride?.confidence_threshold ?? config.review.confidence_threshold;
  if (!(finding.confidence >= confidenceThreshold)) {
    return fail(
      "confidence_policy",
      "confidence_below_threshold",
      `confidence ${finding.confidence} is below threshold ${confidenceThreshold}`,
    );
  }
  checks.push(
    makeCheck(
      "confidence_policy",
      "passed",
      "confidence_ok",
      `confidence ${finding.confidence} meets ${confidenceThreshold}`,
    ),
  );

  return { ok: true, checks, effectiveSeverity };
}
