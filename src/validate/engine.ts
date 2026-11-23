import { ReviewerError } from "../core/errors.ts";
import type { Phase6ValidationEngine, ValidationEngine, ValidationOptions } from "../core/contracts.ts";
import type {
  AttributionBasis,
  ChangedFile,
  CheckResult,
  ConventionAdvisoryUnit,
  DiffResult,
  Finding,
  PendingAdvisoryCandidate,
  PrimaryValidationResult,
  ReviewUnit,
  ValidatedFinding,
  ValidationHandoffEntry,
} from "../types/index.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { GitValidationSnapshotReader } from "./snapshot.ts";
import type { ValidationSnapshotReader } from "./snapshot.ts";
import { makeCheck } from "./checks.ts";
import { validateFindingProvenance } from "./provenance.ts";
import { validateAdvisoryPolicy, validateAdvisoryProvenance } from "./advisory.ts";
import { validateEvidence, type EvidenceUnitView, type VerifiedEvidenceLocation } from "./evidence.ts";
import { validateLocation, type LocationUnitView } from "./location.ts";
import { validateAttribution, type AttributionUnitView } from "./attribution.ts";
import { validatePolicy, type PolicyInput, type PolicyResult } from "./policy.ts";
import { resolveDuplicates, selectWithinCap } from "./dedupe.ts";
import type { DedupeInput, DedupeVerdict } from "./dedupe.ts";

function internal(message: string): ReviewerError {
  return new ReviewerError({ code: "INTERNAL", message });
}

export interface ValidationReaderInput {
  repoDir: string;
  headSha: string;
  mergeBase: string;
}

export interface ValidationEngineOptions {
  repoDir: string;
  createReader?: ((input: ValidationReaderInput) => ValidationSnapshotReader) | undefined;
}

/** Composition-root seam: repo-bound engine, no global state or working-tree reads. */
export function createValidationEngine(options: ValidationEngineOptions): ValidationEngine {
  return new ValidationEngineImpl(options);
}

/**
 * Phase 6 internal entry (ADR 0043, plan 4.2): the same shared per-finding
 * core behind the pending/final type boundary. No batch policies here;
 * conflict suppression, advisory dedupe, and the advisory cap run in P6-05
 * orchestration before finalizeAdvisoryCandidates.
 */
export function createPhase6ValidationEngine(
  options: ValidationEngineOptions,
): ValidationEngine & Phase6ValidationEngine {
  return new ValidationEngineImpl(options);
}

interface PendingAccepted {
  index: number;
  finding: Finding;
  /** Base checks through policy; dedupe and cap checks append in the P5-07 stage. */
  checks: CheckResult[];
  candidate: DedupeInput;
  basis: AttributionBasis;
  /** Verified evidence locations from the shared core, both sides. */
  locations: VerifiedEvidenceLocation[];
}

/** Narrow unit data the shared per-finding stages read. Full review units
 * satisfy every view; advisory lean units arrive through an adapter. */
interface SharedCoreUnits {
  location: LocationUnitView;
  evidence: EvidenceUnitView;
  attribution: AttributionUnitView;
}

interface SharedCoreInput {
  finding: Finding;
  /** Provenance trail every later stage extends; identical for both domains. */
  provenanceChecks: CheckResult[];
  changedFile: ChangedFile;
  canonicalPath: string;
  units: SharedCoreUnits;
  symbolName: string;
  /** Primary policy or the isolated advisory projection; same input shape. */
  policy: (input: PolicyInput) => PolicyResult;
  config: ResolvedConfig;
  reader: ValidationSnapshotReader;
  signal?: AbortSignal | undefined;
}

type SharedCoreOutcome =
  | { kind: "complete"; validated: ValidatedFinding }
  | { kind: "pending"; pending: Omit<PendingAccepted, "index"> };

/**
 * Shared per-finding core (plan 10.1, ADR 0042/0043): location, evidence,
 * attribution, and policy run in the existing order with identical semantics
 * for primary and advisory findings. Only the unit views and the policy
 * projection differ per domain. Batch work (dedupe, cap, conflict, finalize)
 * stays outside.
 */
async function evaluateFinding(input: SharedCoreInput): Promise<SharedCoreOutcome> {
  const { finding, provenanceChecks, changedFile, canonicalPath, units, symbolName, policy, config, reader, signal } =
    input;
  const location = await validateLocation({
    finding,
    unit: units.location,
    changedFile,
    canonicalPath,
    reader,
    signal,
  });
  const checks = [...provenanceChecks, ...location.checks];
  if (!location.ok) {
    return {
      kind: "complete",
      validated: { finding, status: location.inconclusive ? "inconclusive" : "rejected", checks },
    };
  }
  const evidence = await validateEvidence({
    finding,
    unit: units.evidence,
    changedFile,
    canonicalPath,
    reader,
    signal,
  });
  const evidenceChecks = [...checks, ...evidence.checks];
  if (!evidence.ok) {
    return {
      kind: "complete",
      validated: {
        finding,
        status: evidence.inconclusive ? "inconclusive" : "rejected",
        checks: evidenceChecks,
        derivedTarget: location.target,
      },
    };
  }
  const attribution = validateAttribution({
    finding,
    unit: units.attribution,
    changedFile,
    canonicalPath,
    target: location.target,
    locations: evidence.locations,
  });
  const attributionChecks = [...evidenceChecks, ...attribution.checks];
  if (!attribution.ok) {
    return {
      kind: "complete",
      validated: {
        finding,
        status: "inconclusive",
        checks: attributionChecks,
        derivedAttribution: { introducedByPr: false },
        derivedTarget: location.target,
      },
    };
  }
  const policyResult = policy({ finding, canonicalPath, config });
  const policyChecks = [...attributionChecks, ...policyResult.checks];
  if (!policyResult.ok) {
    return {
      kind: "complete",
      validated: { finding, status: "rejected", checks: policyChecks, derivedTarget: location.target },
    };
  }
  return {
    kind: "pending",
    pending: {
      finding,
      checks: policyChecks,
      candidate: {
        finding,
        canonicalPath,
        symbol: symbolName,
        effectiveSeverity: policyResult.effectiveSeverity,
        target: location.target,
      },
      basis: attribution.basis,
      locations: evidence.locations,
    },
  };
}

function toHandoffEntry(findingId: string, locations: VerifiedEvidenceLocation[]): ValidationHandoffEntry {
  return {
    findingId,
    headLocations: locations
      .filter((location) => location.side === "head")
      .map((location) => ({ path: location.path, startLine: location.startLine, endLine: location.endLine })),
  };
}

// P5-07 batch policies over validated candidates only, shared by validate()
// and validatePrimaryWithHandoff so their primary findings are identical.
// Handoff entries cover retained accepted winners; head-side actuals only.
function settlePrimaryBatch(
  slotted: (ValidatedFinding | undefined)[],
  pending: PendingAccepted[],
  maxFindings: number,
): { findings: ValidatedFinding[]; handoff: ValidationHandoffEntry[] } {
  const handoff: ValidationHandoffEntry[] = [];
  // P5-07: dedupe and cap over validated candidates only. Losers stay
  // visible as rejected with a linking check; only winners may be accepted.
  if (pending.length > 0) {
    const verdicts = resolveDuplicates(pending.map((entry) => entry.candidate));
    const survivors: PendingAccepted[] = [];
    const survivorVerdicts: DedupeVerdict[] = [];
    pending.forEach((entry, position) => {
      const verdict = verdicts[position];
      if (verdict === undefined) throw internal(`dedupe lost pending finding at position ${position}`);
      if (!verdict.retained) {
        slotted[entry.index] = {
          finding: entry.finding,
          status: "rejected",
          checks: [...entry.checks, ...verdict.checks],
          derivedTarget: entry.candidate.target,
          duplicateOfId: verdict.duplicateOfId,
        };
      } else {
        survivors.push(entry);
        survivorVerdicts.push(verdict);
      }
    });
    const capped = selectWithinCap(
      survivors.map((entry) => entry.candidate),
      maxFindings,
    );
    survivors.forEach((entry, position) => {
      const kept = capped[position];
      const verdict = survivorVerdicts[position];
      if (kept === undefined || verdict === undefined) {
        throw internal(`cap lost survivor at position ${position}`);
      }
      if (kept.kept) {
        slotted[entry.index] = {
          finding: entry.finding,
          status: "accepted",
          checks: [...entry.checks, ...verdict.checks, makeCheck("max_findings", "passed", "max_findings_ok")],
          derivedAttribution: { introducedByPr: true, basis: entry.basis },
          derivedTarget: entry.candidate.target,
        };
        handoff.push(toHandoffEntry(entry.finding.id, entry.locations));
      } else {
        slotted[entry.index] = {
          finding: entry.finding,
          status: "rejected",
          checks: [
            ...entry.checks,
            ...verdict.checks,
            makeCheck(
              "max_findings",
              "failed",
              "max_findings_exceeded",
              `max_findings ${maxFindings} exceeded: ranked ${kept.rank} of ${survivors.length} accepted candidates`,
            ),
          ],
          derivedTarget: entry.candidate.target,
        };
      }
    });
  }
  return {
    findings: slotted.map((entry, position) => {
      if (entry === undefined) throw internal(`validation lost finding at index ${position}`);
      return entry;
    }),
    handoff,
  };
}

/**
 * Phase 5 validation engine, P5-08 stage. Owns the per-run snapshot
 * reader lifecycle (create from the run's repoDir plus diff SHAs, clear after
 * the run) and enforces P5-02 provenance before any snapshot read: a finding
 * with failed provenance is rejected. P5-03 location resolves the head-side
 * target, P5-04 verifies every evidence quote against its exact snapshot
 * side via redactSource, and P5-05 derives code-owned introducedByPr from
 * verified evidence intersecting PR added/deleted lines. P5-06 enforces
 * config policy (category gate, rule reference, severity/confidence
 * thresholds), and P5-07 resolves same-run duplicates over the survivors
 * (reusing the Phase 4 fingerprint verbatim, never re-minting) and enforces
 * `max_findings` on accepted candidates only. Rejected and inconclusive
 * findings never enter dedupe and consume nothing.
 * Provenance performs no reads, so an unproven path can never become a Git
 * lookup; location reads only the P5-02 canonical path at head, evidence
 * reads only provenance-allowed paths at their diff side, and attribution is
 * pure (no reads, model boolean ignored).
 */
export class ValidationEngineImpl implements ValidationEngine, Phase6ValidationEngine {
  readonly repoDir: string;
  private readonly createReader: (input: ValidationReaderInput) => ValidationSnapshotReader;

  constructor(options: ValidationEngineOptions) {
    if (options === null || options === undefined || typeof options !== "object") {
      throw internal("ValidationEngine requires an options object");
    }
    if (typeof options.repoDir !== "string" || options.repoDir.length === 0) {
      throw internal("ValidationEngine requires repoDir to be a non-empty path");
    }
    this.repoDir = options.repoDir;
    this.createReader = options.createReader ?? ((input) => new GitValidationSnapshotReader({ ...input }));
  }

  async validate(
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig,
    options?: ValidationOptions | undefined,
  ): Promise<ValidatedFinding[]> {
    if (diff === null || diff === undefined || typeof diff !== "object") {
      throw internal("ValidationEngine requires a diff result");
    }
    // The SAME caller signal reaches every location and evidence read, then
    // the underlying Git subprocess: abort yields inconclusive findings (never
    // accepted) and the reader is still released in the finally below.
    const signal = options?.signal;
    const reader = this.createReader({ repoDir: this.repoDir, headSha: diff.headSha, mergeBase: diff.mergeBase });
    try {
      const slotted: (ValidatedFinding | undefined)[] = new Array(findings.length);
      const pending: PendingAccepted[] = [];
      for (const [slot, finding] of findings.entries()) {
        const provenance = validateFindingProvenance(finding, diff, units);
        if (!provenance.ok) {
          slotted[slot] = { finding, status: "rejected", checks: provenance.checks };
          continue;
        }
        const outcome = await evaluateFinding({
          finding,
          provenanceChecks: provenance.checks,
          changedFile: provenance.changedFile,
          canonicalPath: provenance.canonicalPath,
          units: { location: provenance.unit, evidence: provenance.unit, attribution: provenance.unit },
          symbolName: finding.symbol ?? provenance.unit.symbol.name,
          policy: validatePolicy,
          config,
          reader,
          signal,
        });
        if (outcome.kind === "complete") slotted[slot] = outcome.validated;
        else pending.push({ index: slot, ...outcome.pending });
      }
      return settlePrimaryBatch(slotted, pending, config.review.max_findings).findings;
    } finally {
      reader.clear();
    }
  }

  /**
   * Primary validation plus transient handoff (plan 4.2, ADR 0043). The final
   * findings are identical to validate(); handoff carries verified head-side
   * intervals for retained accepted winners only. Empty headLocations is
   * valid (base-only evidence) and means no head-side overlap is possible.
   */
  async validatePrimaryWithHandoff(
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig,
    options?: ValidationOptions | undefined,
  ): Promise<PrimaryValidationResult> {
    if (diff === null || diff === undefined || typeof diff !== "object") {
      throw internal("ValidationEngine requires a diff result");
    }
    const signal = options?.signal;
    const reader = this.createReader({ repoDir: this.repoDir, headSha: diff.headSha, mergeBase: diff.mergeBase });
    try {
      const slotted: (ValidatedFinding | undefined)[] = new Array(findings.length);
      const pending: PendingAccepted[] = [];
      for (const [slot, finding] of findings.entries()) {
        const provenance = validateFindingProvenance(finding, diff, units);
        if (!provenance.ok) {
          slotted[slot] = { finding, status: "rejected", checks: provenance.checks };
          continue;
        }
        const outcome = await evaluateFinding({
          finding,
          provenanceChecks: provenance.checks,
          changedFile: provenance.changedFile,
          canonicalPath: provenance.canonicalPath,
          units: { location: provenance.unit, evidence: provenance.unit, attribution: provenance.unit },
          symbolName: finding.symbol ?? provenance.unit.symbol.name,
          policy: validatePolicy,
          config,
          reader,
          signal,
        });
        if (outcome.kind === "complete") slotted[slot] = outcome.validated;
        else pending.push({ index: slot, ...outcome.pending });
      }
      return settlePrimaryBatch(slotted, pending, config.review.max_findings);
    } finally {
      reader.clear();
    }
  }

  /**
   * Advisory candidate validation (plan 4.2/10). Runs the shared per-finding
   * core under the isolated advisory policy and returns pending candidates
   * for per-finding-validated findings only: rejected or inconclusive
   * outcomes are dropped, never materialized. No dedupe, cap, conflict
   * suppression, or ValidatedFinding construction happens here; P6-05 owns
   * those filters before finalizeAdvisoryCandidates.
   */
  async validateAdvisoryCandidates(
    findings: Finding[],
    diff: DiffResult,
    units: ConventionAdvisoryUnit[],
    config: ResolvedConfig,
    options?: ValidationOptions | undefined,
  ): Promise<PendingAdvisoryCandidate[]> {
    if (diff === null || diff === undefined || typeof diff !== "object") {
      throw internal("ValidationEngine requires a diff result");
    }
    const signal = options?.signal;
    const reader = this.createReader({ repoDir: this.repoDir, headSha: diff.headSha, mergeBase: diff.mergeBase });
    try {
      const candidates: PendingAdvisoryCandidate[] = [];
      for (const finding of findings) {
        const provenance = validateAdvisoryProvenance(finding, diff, units);
        if (!provenance.ok) continue;
        const outcome = await evaluateFinding({
          finding,
          provenanceChecks: provenance.checks,
          changedFile: provenance.changedFile,
          canonicalPath: provenance.canonicalPath,
          units: provenance.views,
          symbolName: finding.symbol ?? provenance.views.symbolName,
          policy: validateAdvisoryPolicy,
          config,
          reader,
          signal,
        });
        if (outcome.kind !== "pending") continue;
        const entry = outcome.pending;
        candidates.push({
          phase: "pending-advisory-resolution",
          findingId: finding.id,
          pendingFields: {
            finding: entry.finding,
            checks: entry.checks,
            derivedAttribution: { introducedByPr: true, basis: entry.basis },
            derivedTarget: entry.candidate.target,
          },
          handoff: toHandoffEntry(finding.id, entry.locations),
        });
      }
      return candidates;
    } finally {
      reader.clear();
    }
  }

  /**
   * Materializes surviving pending candidates after orchestration-side
   * conflict suppression, advisory dedupe, and advisory cap (P6-05). Pure and
   * order-preserving: the sole constructor of advisory ValidatedFinding
   * values.
   */
  finalizeAdvisoryCandidates(candidates: PendingAdvisoryCandidate[]): ValidatedFinding[] {
    return candidates.map((candidate) => ({ ...candidate.pendingFields, status: "accepted" as const }));
  }
}
