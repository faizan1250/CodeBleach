import type { Severity } from "./finding.ts";

export type RuleKind =
  | "architecture"
  | "convention"
  | "testing"
  | "performance"
  | "error_handling"
  | "security";

export interface Rule {
  id: string;
  kind: RuleKind;
  text: string;
  paths?: string[] | undefined;
  severity?: Severity | undefined;
}
