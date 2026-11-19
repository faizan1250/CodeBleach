import type { Rule } from "../types/rules.ts";
import { matchGlob } from "../utils/glob.ts";

// Explicit `.reviewer.yml` rules only. No inference: output is always a
// filtered view of the validated config, in configuration order.
export function ruleAppliesToFile(rule: Rule, filePath: string): boolean {
  const patterns = rule.paths;
  if (patterns === undefined || patterns.length === 0) return true;
  return patterns.some((pattern) => matchGlob(filePath, pattern));
}

/** Applicable explicit rules for one repo-relative file, verbatim and in config order. */
export function selectRulesForFile(rules: readonly Rule[], filePath: string): Rule[] {
  return rules.filter((rule) => ruleAppliesToFile(rule, filePath));
}
