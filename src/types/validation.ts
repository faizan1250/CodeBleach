import { z } from "zod";
import type { Finding } from "./finding.ts";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string | undefined;
}

export const LlmVerdictSchema = z.strictObject({
  verdict: z.enum(["confirmed", "refuted", "inconclusive"]),
  reasoning: z.string().min(1),
});

export type LlmVerdict = z.infer<typeof LlmVerdictSchema>;

export interface ValidatedFinding {
  finding: Finding;
  status: "accepted" | "rejected" | "inconclusive";
  checks: CheckResult[];
  llmVerdict?: LlmVerdict | undefined;
  /**
   * P5-05 code-derived attribution; absent when attribution never ran. The
   * model `Finding.introducedByPr` never decides acceptance (ADR 0028 D3).
   */
  derivedAttribution?: DerivedAttribution | undefined;
}

export type AttributionBasisKind = "added-lines" | "deleted-lines";

export interface AttributionBasis {
  kind: AttributionBasisKind;
  evidenceIndex: number;
  file: string;
  lines: number[];
}

export interface DerivedAttribution {
  introducedByPr: boolean;
  basis?: AttributionBasis | undefined;
}
