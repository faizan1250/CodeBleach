import { ReviewerError } from "../core/errors.ts";
import type { ValidationEngine } from "../core/contracts.ts";
import type { DiffResult, Finding, ReviewUnit, ValidatedFinding } from "../types/index.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { GitValidationSnapshotReader } from "./snapshot.ts";
import type { ValidationSnapshotReader } from "./snapshot.ts";
import { validateFindingProvenance } from "./provenance.ts";
import { validateLocation } from "./location.ts";

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
 * Phase 5 validation engine, P5-03 stage. Owns the per-run snapshot
 * reader lifecycle (create from the run's repoDir plus diff SHAs, clear after
 * the run) and enforces P5-02 provenance before any snapshot read: a finding
 * with failed provenance is rejected, and a finding with passing provenance
 * stays inconclusive until evidence, attribution, and policy checks land in
 * P5-04 through P5-07. P5-03 location resolves the head-side target but keeps
 * the inconclusive ceiling, so wiring alone can never mark findings accepted.
 * Provenance performs no reads, so an unproven path can never become a Git
 * lookup; location reads only the P5-02 canonical path at head.
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
    _config: ResolvedConfig,
  ): Promise<ValidatedFinding[]> {
    if (diff === null || diff === undefined || typeof diff !== "object") {
      throw internal("ValidationEngine requires a diff result");
    }
    const reader = this.createReader({ repoDir: this.repoDir, headSha: diff.headSha, mergeBase: diff.mergeBase });
    try {
      const results: ValidatedFinding[] = [];
      for (const finding of findings) {
        const provenance = validateFindingProvenance(finding, diff, units);
        if (!provenance.ok) {
          results.push({ finding, status: "rejected", checks: provenance.checks });
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
          results.push({ finding, status: location.inconclusive ? "inconclusive" : "rejected", checks });
          continue;
        }
        results.push({ finding, status: "inconclusive", checks });
      }
      return results;
    } finally {
      reader.clear();
    }
  }
}
