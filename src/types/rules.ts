import type { Severity } from "./finding.ts";

export const RULE_KINDS = [
  "architecture",
  "convention",
  "testing",
  "performance",
  "error_handling",
  "security",
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export interface Rule {
  id: string;
  kind: RuleKind;
  text: string;
  paths?: string[] | undefined;
  severity?: Severity | undefined;
}
