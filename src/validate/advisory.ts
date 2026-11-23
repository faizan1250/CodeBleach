import { ReviewerError } from "../core/errors.ts";
import type { ChangedFile, CheckResult, DiffResult, Finding } from "../types/index.ts";
import type { ConventionAdvisoryUnit } from "../types/conventions.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { ADVISORY_SEVERITY_THRESHOLD } from "../conventions/constants.ts";
import { makeCheck } from "./checks.ts";
import { validateFindingProvenance, type ProvenanceFailure, type ProvenanceUnitView } from "./provenance.ts";
import type { LocationUnitView } from "./location.ts";
import type { EvidenceUnitView } from "./evidence.ts";
import type { AttributionUnitView } from "./attribution.ts";
import { validatePolicy, type PolicyInput, type PolicyResult } from "./policy.ts";

function internal(message: string): ReviewerError {
  return new ReviewerError({ code: "INTERNAL", message });
}

/** Lean-unit views over the shared per-finding stages (plan 10.1). */
export interface AdvisoryValidationViews {
  location: LocationUnitView;
  evidence: EvidenceUnitView;
  attribution: AttributionUnitView;
  /** Engine-stamped symbol name for the primary-symbol fallback. */
  symbolName: string;
}

export interface AdvisoryProvenanceSuccess {
  ok: true;
  checks: CheckResult[];
  unit: ConventionAdvisoryUnit;
  changedFile: ChangedFile;
  canonicalPath: string;
  viaOldPath: boolean;
  views: AdvisoryValidationViews;
}

export type AdvisoryProvenanceResult = AdvisoryProvenanceSuccess | ProvenanceFailure;

function toProvenanceView(unit: ConventionAdvisoryUnit): ProvenanceUnitView {
  return {
    id: unit.unitId,
    file: { path: unit.path },
    symbol: { name: unit.symbol.name },
    // Lean projections carry no review context: advisory evidence may only
    // cite the unit's own path (plus a rename old path), never context files.
    context: [],
  };
}

// Changed-line sets recovered from unit-scoped diff hunks. The projector emits
// only +/-/space-prefixed lines; any other prefix advances both cursors like
// context so line accounting never stalls. Symbol scope and hunk scope
// coincide for lean units, so these sets play the role of the symbol line
// sets the shared location/attribution stages read from full review units.
export function deriveAdvisoryLineSets(unit: ConventionAdvisoryUnit): {
  changedLines: number[];
  deletedLines: number[];
} {
  const changed = new Set<number>();
  const deleted = new Set<number>();
  for (const hunk of unit.diffHunks) {
    let oldCursor = hunk.baseStartLine;
    let newCursor = hunk.headStartLine;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        changed.add(newCursor);
        newCursor += 1;
      } else if (line.startsWith("-")) {
        deleted.add(oldCursor);
        oldCursor += 1;
      } else {
        oldCursor += 1;
        newCursor += 1;
      }
    }
  }
  return {
    changedLines: [...changed].sort((a, b) => a - b),
    deletedLines: [...deleted].sort((a, b) => a - b),
  };
}

// Deleted-symbol anchor lines are not recoverable from lean hunks, so
// deletion-anchor findings fail closed at the location stage (never accepted,
// never guessed). This is documented, not silent: the location check records
// deletion_anchor_missing.
export function advisoryValidationViews(unit: ConventionAdvisoryUnit): AdvisoryValidationViews {
  const { changedLines, deletedLines } = deriveAdvisoryLineSets(unit);
  const symbol = { changedLines, deletedLines, anchorLine: undefined as number | undefined };
  return {
    location: { symbol },
    evidence: { context: [] },
    attribution: { symbol: { changedLines, deletedLines } },
    symbolName: unit.symbol.name,
  };
}

/**
 * Advisory provenance (plan 10.1/10.3). Runs the identical primary
 * provenance core over lean-unit views, so check names, order, and codes
 * match the primary trail exactly. Duplicate unitIds are excluded before the
 * trail, turning ambiguous associations into genuine origin_unit_missing
 * failures through the shared code path. Hunk-derived line sets travel
 * alongside for the shared location/attribution stages.
 */
export function validateAdvisoryProvenance(
  finding: Finding,
  diff: DiffResult,
  units: readonly ConventionAdvisoryUnit[],
): AdvisoryProvenanceResult {
  const counts = new Map<string, number>();
  for (const unit of units) {
    counts.set(unit.unitId, (counts.get(unit.unitId) ?? 0) + 1);
  }
  const views = units.filter((unit) => counts.get(unit.unitId) === 1).map(toProvenanceView);
  const trail = validateFindingProvenance(finding, diff, views);
  if (!trail.ok) return trail;
  const unit = units.find((candidate) => candidate.unitId === trail.unit.id);
  if (unit === undefined) {
    throw internal("advisory provenance lost its unit after a successful trail");
  }
  return {
    ok: true,
    checks: trail.checks,
    unit,
    changedFile: trail.changedFile,
    canonicalPath: trail.canonicalPath,
    viaOldPath: trail.viaOldPath,
    views: advisoryValidationViews(unit),
  };
}

function advisoryPolicyConfig(config: ResolvedConfig): ResolvedConfig {
  return {
    ...config,
    // Advisory severity is pinned to low (plan 10.2): the global threshold and
    // every path override resolve to low, so overrides can neither admit nor
    // evict advisory findings on severity. Category overrides are untouched
    // because the convention group never reads them; confidence thresholds
    // keep their path -> global precedence.
    review: { ...config.review, severity_threshold: ADVISORY_SEVERITY_THRESHOLD },
    path_overrides: config.path_overrides.map((override) =>
      override.review.severity_threshold === undefined
        ? override
        : { ...override, review: { ...override.review, severity_threshold: ADVISORY_SEVERITY_THRESHOLD } },
    ),
  };
}

/**
 * Isolated advisory policy projection (plan 10.2/16.3). Any rule reference is
 * rejected before validation, including a real configured rule ID, and only
 * exact low severity is admitted (info and above-low severities are
 * ineligible). The remaining checks reuse the primary policy core under the
 * pinned-low config view, so check names, order, and codes are unchanged.
 */
export function validateAdvisoryPolicy(input: PolicyInput): PolicyResult {
  if (input.finding.ruleId !== undefined) {
    return {
      ok: false,
      checks: [
        makeCheck(
          "rule_policy",
          "failed",
          "rule_id_unknown",
          `advisory findings must not reference rules, got ${JSON.stringify(input.finding.ruleId)}`,
        ),
      ],
    };
  }
  // Exactness lives here rather than in the threshold: a low threshold would
  // still admit medium and above by rank, but the advisory boundary admits
  // exact low only (plan 1.2/16.3). The closed code set carries no
  // exact-mismatch code, so the severity-family failure code applies with an
  // exact detail.
  if (input.finding.severity !== ADVISORY_SEVERITY_THRESHOLD) {
    return {
      ok: false,
      checks: [
        makeCheck(
          "severity_policy",
          "failed",
          "severity_below_threshold",
          `advisory severity must be exactly low, got ${input.finding.severity}`,
        ),
      ],
    };
  }
  return validatePolicy({
    finding: input.finding,
    canonicalPath: input.canonicalPath,
    config: advisoryPolicyConfig(input.config),
  });
}
