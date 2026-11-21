import { ReviewerError } from "../core/errors.ts";
import type { ValidationEngine } from "../core/contracts.ts";
import type {
  AttributionBasis,
  CheckResult,
  DiffResult,
  Finding,
  ReviewUnit,
  ValidatedFinding,
} from "../types/index.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { GitValidationSnapshotReader } from "./snapshot.ts";
import type { ValidationSnapshotReader } from "./snapshot.ts";
import { validateFindingProvenance } from "./provenance.ts";
import { validateEvidence } from "./evidence.ts";
import { validateLocation } from "./location.ts";
import { validateAttribution } from "./attribution.ts";
import { validatePolicy } from "./policy.ts";
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

interface PendingAccepted {
  index: number;
  finding: Finding;
  /** Base checks through policy; dedupe and cap checks append in the P5-07 stage. */
  checks: CheckResult[];
  candidate: DedupeInput;
  basis: AttributionBasis;
}

/**
 * Phase 5 validation engine, P5-05 stage. Owns the per-run snapshot
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
export class ValidationEngineImpl implements ValidationEngine {
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
  ): Promise<ValidatedFinding[]> {
    if (diff === null || diff === undefined || typeof diff !== "object") {
      throw internal("ValidationEngine requires a diff result");
    }
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
        const location = await validateLocation({
          finding,
          unit: provenance.unit,
          changedFile: provenance.changedFile,
          canonicalPath: provenance.canonicalPath,
          reader,
        });
        const checks = [...provenance.checks, ...location.checks];
        if (!location.ok) {
          slotted[slot] = { finding, status: location.inconclusive ? "inconclusive" : "rejected", checks };
          continue;
        }
        const evidence = await validateEvidence({
          finding,
          unit: provenance.unit,
          changedFile: provenance.changedFile,
          canonicalPath: provenance.canonicalPath,
          reader,
        });
        const evidenceChecks = [...checks, ...evidence.checks];
        if (!evidence.ok) {
          slotted[slot] = {
            finding,
            status: evidence.inconclusive ? "inconclusive" : "rejected",
            checks: evidenceChecks,
          };
          continue;
        }
        const attribution = validateAttribution({
          finding,
          unit: provenance.unit,
          changedFile: provenance.changedFile,
          canonicalPath: provenance.canonicalPath,
          target: location.target,
          sides: evidence.sides,
        });
        const attributionChecks = [...evidenceChecks, ...attribution.checks];
        if (!attribution.ok) {
          slotted[slot] = {
            finding,
            status: "inconclusive",
            checks: attributionChecks,
            derivedAttribution: { introducedByPr: false },
          };
          continue;
        }
        const policy = validatePolicy({ finding, canonicalPath: provenance.canonicalPath, config });
        const policyChecks = [...attributionChecks, ...policy.checks];
        if (!policy.ok) {
          slotted[slot] = { finding, status: "rejected", checks: policyChecks };
          continue;
        }
        pending.push({
          index: slot,
          finding,
          checks: policyChecks,
          candidate: {
            finding,
            canonicalPath: provenance.canonicalPath,
            symbol: finding.symbol ?? provenance.unit.symbol.name,
            effectiveSeverity: policy.effectiveSeverity,
            target: location.target,
          },
          basis: attribution.basis,
        });
      }
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
            };
          } else {
            survivors.push(entry);
            survivorVerdicts.push(verdict);
          }
        });
        const capped = selectWithinCap(
          survivors.map((entry) => entry.candidate),
          config.review.max_findings,
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
              checks: [...entry.checks, ...verdict.checks, { name: "max_findings", passed: true }],
              derivedAttribution: { introducedByPr: true, basis: entry.basis },
            };
          } else {
            slotted[entry.index] = {
              finding: entry.finding,
              status: "rejected",
              checks: [
                ...entry.checks,
                ...verdict.checks,
                {
                  name: "max_findings",
                  passed: false,
                  detail: `max_findings ${config.review.max_findings} exceeded: ranked ${kept.rank} of ${survivors.length} accepted candidates`,
                },
              ],
            };
          }
        });
      }
      return slotted.map((entry, position) => {
        if (entry === undefined) throw internal(`validation lost finding at index ${position}`);
        return entry;
      });
    } finally {
      reader.clear();
    }
  }
}
