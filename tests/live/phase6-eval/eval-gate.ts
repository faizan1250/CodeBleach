// Phase 6 usefulness evaluation gate (P6-05, plan 15/16.5).
//
// Pure adjudication math over independently labeled real-PR advisory
// candidates. No I/O, no network, no model calls: the live harness collects
// candidates, operators label them, and gate.ts applies these rules. Seeded
// fixtures never reach this function; only real-PR labels count.

export type AdvisoryLabel = "useful" | "technically-correct-but-not-actionable" | "incorrect/unsupported";

export interface LabeledAdvisoryCandidate {
  prUrl: string;
  findingId: string;
  label: AdvisoryLabel;
  category: string;
  severity: string;
  ruleId?: string | undefined;
  notes?: string | undefined;
}

// Plan 16.5 hard gates: at least 30 emitted real-PR candidates, at least 80%
// useful precision, zero non-low/authority violations.
export const MIN_EVAL_CANDIDATES = 30;
export const MIN_USEFUL_PRECISION = 0.8;

export interface EvalGateResult {
  passed: boolean;
  totalCandidates: number;
  useful: number;
  usefulPrecision: number;
  violations: number;
  reasons: string[];
}

function isAuthorityViolation(candidate: LabeledAdvisoryCandidate): boolean {
  return candidate.category !== "convention" || candidate.severity !== "low" || candidate.ruleId !== undefined;
}

/**
 * Applies the plan 16.5 gate. Fewer than MIN_EVAL_CANDIDATES means
 * insufficient evaluation, never a pass. Useful precision counts only
 * `useful` labels; the other two labels are non-useful but not violations.
 */
export function evaluateGate(input: { labels: readonly LabeledAdvisoryCandidate[] }): EvalGateResult {
  const totalCandidates = input.labels.length;
  let useful = 0;
  let violations = 0;
  for (const candidate of input.labels) {
    if (candidate.label === "useful") useful += 1;
    if (isAuthorityViolation(candidate)) violations += 1;
  }
  const usefulPrecision = totalCandidates === 0 ? 0 : useful / totalCandidates;
  const reasons: string[] = [];
  if (totalCandidates < MIN_EVAL_CANDIDATES) {
    reasons.push(
      `insufficient evaluation: ${totalCandidates} labeled real-PR candidates, need at least ${MIN_EVAL_CANDIDATES}`,
    );
  }
  if (usefulPrecision < MIN_USEFUL_PRECISION) {
    reasons.push(
      `useful precision ${(usefulPrecision * 100).toFixed(1)}% below ${(MIN_USEFUL_PRECISION * 100).toFixed(0)}% floor`,
    );
  }
  if (violations > 0) {
    reasons.push(`${violations} authority violation(s): expected category convention, severity low, no ruleId`);
  }
  return { passed: reasons.length === 0, totalCandidates, useful, usefulPrecision, violations, reasons };
}
