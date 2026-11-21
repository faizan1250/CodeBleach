import { ReviewerError } from "../core/errors.ts";
import type { ValidationEngine } from "../core/contracts.ts";
import type { DiffResult, Finding, ReviewUnit, ValidatedFinding } from "../types/index.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { GitValidationSnapshotReader } from "./snapshot.ts";
import type { ValidationSnapshotReader } from "./snapshot.ts";

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
 * Phase 5 validation engine, P5-01 wiring stage. Owns the per-run snapshot
 * reader lifecycle (create from the run's repoDir plus diff SHAs, clear after
 * the run) but performs no acceptance yet: provenance, location, evidence,
 * and attribution checks land in P5-02 through P5-07. Every finding stays
 * inconclusive with a fail-closed check until then, so no pipeline can mark
 * findings accepted on wiring alone.
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
    _units: ReviewUnit[],
    _config: ResolvedConfig,
  ): Promise<ValidatedFinding[]> {
    if (diff === null || diff === undefined || typeof diff !== "object") {
      throw internal("ValidationEngine requires a diff result");
    }
    const reader = this.createReader({ repoDir: this.repoDir, headSha: diff.headSha, mergeBase: diff.mergeBase });
    try {
      return findings.map(
        (finding): ValidatedFinding => ({
          finding,
          status: "inconclusive",
          checks: [
            {
              name: "snapshot_reader_wiring",
              passed: false,
              detail:
                "P5-01 wires exact-snapshot access only; provenance, location, evidence, and attribution land in P5-02 through P5-07",
            },
          ],
        }),
      );
    } finally {
      reader.clear();
    }
  }
}
