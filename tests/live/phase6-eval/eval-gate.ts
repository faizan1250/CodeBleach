// Phase 6 usefulness evaluation gate (P6-05, plan 15/16.5).
//
// Pure adjudication math over human labels joined against the harness's
// emitted real-PR advisory candidates. No I/O, no network, no model calls:
// the live harness collects candidates, operators label them, and gate.ts
// supplies the emitted records while this module applies the rules. Seeded
// fixtures never reach this function; only real-PR emitted records count.
//
// Authority is derived from the emitted record (category/severity/ruleId),
// never from label metadata: labels carry only the PR URL, finding ID,
// adjudicated label, and optional notes.

export type AdvisoryLabel = "useful" | "technically-correct-but-not-actionable" | "incorrect/unsupported";

export interface LabeledAdvisoryCandidate {
  prUrl: string;
  findingId: string;
  label: AdvisoryLabel;
  notes?: string | undefined;
}

// Emitted truth for one advisory candidate, transcribed from the harness
// per-PR result records. category/severity/ruleId here are authoritative.
export interface EmittedAdvisoryCandidate {
  prUrl: string;
  findingId: string;
  category: string;
  severity: string;
  ruleId?: string | undefined;
}

// Plan 16.5 hard gates: at least 30 emitted real-PR candidates, at least 80%
// useful precision, zero authority violations.
export const MIN_EVAL_CANDIDATES = 30;
export const MIN_USEFUL_PRECISION = 0.8;

// Max identities named inline in a single reason; full lists stay in the
// structured missing/unmatched/duplicates fields. Keeps reports bounded.
const MAX_NAMED_IDENTITIES = 5;

export interface EvalGateResult {
  passed: boolean;
  /** Unique emitted real-PR candidates; the 30-count applies here, never to labels. */
  totalCandidates: number;
  useful: number;
  usefulPrecision: number;
  violations: number;
  /** Emitted identities with no label: every emitted candidate needs exactly one. */
  missing: string[];
  /** Label identities with no emitted record: invented or mistyped labels. */
  unmatched: string[];
  /** Identities labeled more than once. */
  duplicates: string[];
  reasons: string[];
}

function identityOf(prUrl: string, findingId: string): string {
  return `${prUrl}#${findingId}`;
}

function nameIdentities(identities: readonly string[]): string {
  const shown = identities.slice(0, MAX_NAMED_IDENTITIES).join(", ");
  return identities.length > MAX_NAMED_IDENTITIES
    ? `${shown}, and ${identities.length - MAX_NAMED_IDENTITIES} more`
    : shown;
}

function duplicatesOf(identities: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([identity]) => identity)
    .sort();
}

/**
 * Applies the plan 16.5 gate over labels joined against emitted records.
 * knownPrUrls is the corpus truth: when provided, labels or emitted records
 * for any other PR URL fail as unknown. Useful precision counts only
 * `useful` labels; the other two labels are non-useful but not violations.
 */
export function evaluateGate(input: {
  labels: readonly LabeledAdvisoryCandidate[];
  emitted: readonly EmittedAdvisoryCandidate[];
  knownPrUrls?: readonly string[] | undefined;
}): EvalGateResult {
  const reasons: string[] = [];
  const known = input.knownPrUrls === undefined ? null : new Set(input.knownPrUrls);

  const emittedIdentities = input.emitted.map((candidate) => identityOf(candidate.prUrl, candidate.findingId));
  const emittedByIdentity = new Map<string, EmittedAdvisoryCandidate>();
  for (const candidate of input.emitted) {
    const identity = identityOf(candidate.prUrl, candidate.findingId);
    if (!emittedByIdentity.has(identity)) emittedByIdentity.set(identity, candidate);
  }
  const uniqueEmitted = [...emittedByIdentity.keys()].sort();

  const labelIdentities = input.labels.map((candidate) => identityOf(candidate.prUrl, candidate.findingId));

  const duplicateEmitted = duplicatesOf(emittedIdentities);
  if (duplicateEmitted.length > 0) {
    reasons.push(`duplicate emitted finding(s): ${nameIdentities(duplicateEmitted)}`);
  }

  const duplicates = duplicatesOf(labelIdentities);
  if (duplicates.length > 0) {
    reasons.push(`duplicate label(s): ${nameIdentities(duplicates)}`);
  }

  if (known !== null) {
    const unknownLabels = [...new Set(input.labels.filter((c) => !known.has(c.prUrl)).map((c) => c.prUrl))].sort();
    if (unknownLabels.length > 0) {
      reasons.push(`unknown PR URL(s) in labels: ${nameIdentities(unknownLabels)}`);
    }
    const unknownEmitted = [...new Set(input.emitted.filter((c) => !known.has(c.prUrl)).map((c) => c.prUrl))].sort();
    if (unknownEmitted.length > 0) {
      reasons.push(`unknown PR URL(s) in emitted results: ${nameIdentities(unknownEmitted)}`);
    }
  }

  const emittedSet = new Set(uniqueEmitted);
  const labeledSet = new Set(labelIdentities);
  const unmatched = labelIdentities.filter((identity) => !emittedSet.has(identity));
  const uniqueUnmatched = [...new Set(unmatched)].sort();
  if (uniqueUnmatched.length > 0) {
    reasons.push(`label(s) for never-emitted finding(s): ${nameIdentities(uniqueUnmatched)}`);
  }
  const missing = uniqueEmitted.filter((identity) => !labeledSet.has(identity));
  if (missing.length > 0) {
    reasons.push(`emitted finding(s) with no label: ${nameIdentities(missing)}`);
  }

  let useful = 0;
  let violations = 0;
  const violationNotes: string[] = [];
  const seenForUseful = new Set<string>();
  for (const candidate of input.labels) {
    const identity = identityOf(candidate.prUrl, candidate.findingId);
    if (seenForUseful.has(identity)) continue;
    seenForUseful.add(identity);
    const emitted = emittedByIdentity.get(identity);
    if (emitted === undefined) continue;
    if (candidate.label === "useful") useful += 1;
    // Authority derives from the emitted record, never label metadata.
    if (emitted.category !== "convention" || emitted.severity !== "low" || emitted.ruleId !== undefined) {
      violations += 1;
      violationNotes.push(
        `${identity} (category=${emitted.category}, severity=${emitted.severity}` +
          `${emitted.ruleId === undefined ? "" : `, ruleId=${emitted.ruleId}`})`,
      );
    }
  }
  const matched = uniqueEmitted.filter((identity) => labeledSet.has(identity)).length;
  const usefulPrecision = matched === 0 ? 0 : useful / matched;
  violationNotes.sort();
  if (violations > 0) {
    reasons.push(
      `${violations} authority violation(s) (expected convention/low/no ruleId): ${nameIdentities(violationNotes)}`,
    );
  }

  const totalCandidates = uniqueEmitted.length;
  if (totalCandidates < MIN_EVAL_CANDIDATES) {
    reasons.push(
      `insufficient evaluation: ${totalCandidates} emitted real-PR candidates, need at least ${MIN_EVAL_CANDIDATES}`,
    );
  }
  if (usefulPrecision < MIN_USEFUL_PRECISION) {
    reasons.push(
      `useful precision ${(usefulPrecision * 100).toFixed(1)}% below ${(MIN_USEFUL_PRECISION * 100).toFixed(0)}% floor`,
    );
  }
  return {
    passed: reasons.length === 0,
    totalCandidates,
    useful,
    usefulPrecision,
    violations,
    missing,
    unmatched: uniqueUnmatched,
    duplicates,
    reasons,
  };
}
