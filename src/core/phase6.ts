import type { Phase6PipelineDeps } from "./contracts.ts";
import type { Logger } from "./logger.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { MAX_ADVISORY_CONCURRENCY } from "../conventions/constants.ts";
import { packAdvisoryBatches } from "../conventions/packer.ts";
import type {
  ConventionAdvisoryBatchInput,
  ConventionAdvisoryProjectionResult,
  ConventionAdvisoryUnit,
  AdvisoryConflictMetadata,
  ConventionBuildResult,
  PrimaryValidationResult,
} from "../types/conventions.ts";
import type { DiffResult, Finding, ReviewUnit, ValidatedFinding } from "../types/index.ts";
import { gateAdvisoryBoundary, resolveAdvisoryMerge } from "../validate/conflict.ts";

export interface AdvisoryPassDiagnostics {
  codes: string[];
  projectedUnits: number;
  skippedUnits: number;
  batches: number;
  candidates: number;
  boundaryRejected: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AdvisoryPassResult {
  findings: Finding[];
  units: ConventionAdvisoryUnit[];
  diagnostics: AdvisoryPassDiagnostics;
}

export interface AdvisoryMergeResult {
  advisory: ValidatedFinding[];
  metadata: AdvisoryConflictMetadata;
  diagnostics: { codes: string[] };
}

function pushCode(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

function emptyPassDiagnostics(): AdvisoryPassDiagnostics {
  return {
    codes: [],
    projectedUnits: 0,
    skippedUnits: 0,
    batches: 0,
    candidates: 0,
    boundaryRejected: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

// Bounded fan-out over advisory batches: at most two requests in flight, and
// the run-scoped shared limiter caps the combined primary + advisory ceiling
// at the provider-call boundary. Slots preserve batch order, so completion
// order cannot affect output order. Per-batch failures are recorded, never
// thrown; caller abort is rethrown after the join.
async function reviewBatchesLimited(input: {
  review: Phase6PipelineDeps["advisoryReview"];
  batches: ConventionAdvisoryBatchInput[];
  config: ResolvedConfig;
  signal: AbortSignal | undefined;
  headSha: string;
  limit: number;
}): Promise<{
  slots: Array<{ candidates: Finding[]; inputTokens: number; outputTokens: number } | undefined>;
  failures: number;
}> {
  const slots: Array<{ candidates: Finding[]; inputTokens: number; outputTokens: number } | undefined> = new Array(
    input.batches.length,
  );
  let next = 0;
  let failures = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(input.limit, input.batches.length)) }, async () => {
    for (;;) {
      if (input.signal?.aborted === true) return;
      const index = next;
      next += 1;
      if (index >= input.batches.length) return;
      const batch = input.batches[index];
      if (batch === undefined) return;
      try {
        const result = await input.review.reviewBatch(batch, input.config, {
          signal: input.signal,
          headSha: input.headSha,
        });
        slots[index] = {
          candidates: result.candidates.map((candidate) => candidate.finding),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      } catch {
        input.signal?.throwIfAborted();
        failures += 1;
      }
    }
  });
  await Promise.all(workers);
  input.signal?.throwIfAborted();
  return { slots, failures };
}

/**
 * Advisory model pass (plan 3.1, 9.3-9.6, 12.1). Starts once conventions are
 * ready without waiting for primary review; the pipeline joins both paths with
 * allSettled semantics. Fail-open: every ordinary convention, projection, or
 * provider failure yields empty findings while primary review continues.
 * Caller abort still cancels the run.
 */
export async function runPhase6AdvisoryPass(input: {
  phase6: Phase6PipelineDeps;
  repoDir: string;
  diff: DiffResult;
  units: ReviewUnit[];
  config: ResolvedConfig;
  signal?: AbortSignal | undefined;
  logger: Logger;
}): Promise<AdvisoryPassResult> {
  const diagnostics = emptyPassDiagnostics();
  const signal = input.signal;
  const fail = (code: string): AdvisoryPassResult => {
    pushCode(diagnostics.codes, code);
    return { findings: [], units: [], diagnostics };
  };
  // Pre-aborted signals cancel before any convention, projection, or provider work.
  signal?.throwIfAborted();
  let built: ConventionBuildResult;
  try {
    built = await input.phase6.conventions.build({
      repoDir: input.repoDir,
      diff: input.diff,
      config: input.config,
      signal,
    });
  } catch {
    signal?.throwIfAborted();
    input.logger.warn("advisory conventions build failed open", {});
    return fail("advisory_conventions_failed");
  }
  if (built.conventions.length === 0) {
    return fail("advisory_skipped_no_conventions");
  }
  let projected: ConventionAdvisoryProjectionResult;
  try {
    projected = await input.phase6.advisoryProjector.project({ units: input.units, diff: input.diff, signal });
  } catch {
    signal?.throwIfAborted();
    input.logger.warn("advisory projection failed open", {});
    return fail("advisory_projection_failed");
  }
  diagnostics.projectedUnits = projected.units.length;
  diagnostics.skippedUnits = projected.skippedUnits;
  if (projected.units.length === 0) {
    return fail("advisory_skipped_no_units");
  }
  try {
    const packed = packAdvisoryBatches({ units: projected.units, conventions: built.conventions });
    diagnostics.skippedUnits += packed.skippedUnits;
    diagnostics.batches = packed.batches.length;
    if (packed.batches.length === 0) {
      return fail("advisory_skipped_no_batches");
    }
    const limit = Math.max(1, Math.min(MAX_ADVISORY_CONCURRENCY, input.config.llm.max_concurrent_requests));
    const settled = await reviewBatchesLimited({
      review: input.phase6.advisoryReview,
      batches: packed.batches,
      config: input.config,
      signal,
      headSha: input.diff.headSha,
      limit,
    });
    if (settled.failures > 0) pushCode(diagnostics.codes, "advisory_batch_failed");
    const batchedUnits: ConventionAdvisoryUnit[] = [];
    const seenUnits = new Set<string>();
    for (const batch of packed.batches) {
      for (const unit of batch.units) {
        if (seenUnits.has(unit.unitId)) continue;
        seenUnits.add(unit.unitId);
        batchedUnits.push(unit);
      }
    }
    const ordered: Finding[] = [];
    for (const slot of settled.slots) {
      if (slot === undefined) continue;
      diagnostics.inputTokens += slot.inputTokens;
      diagnostics.outputTokens += slot.outputTokens;
      ordered.push(...slot.candidates);
    }
    const gated = gateAdvisoryBoundary(ordered);
    diagnostics.candidates = gated.passed.length;
    diagnostics.boundaryRejected = gated.rejected;
    if (gated.rejected > 0) pushCode(diagnostics.codes, "advisory_boundary_rejected");
    if (gated.passed.length === 0) pushCode(diagnostics.codes, "advisory_candidates_none");
    input.logger.info("advisory pass completed", {
      conventions: built.conventions.length,
      projectedUnits: diagnostics.projectedUnits,
      skippedUnits: diagnostics.skippedUnits,
      batches: diagnostics.batches,
      candidates: diagnostics.candidates,
      boundaryRejected: diagnostics.boundaryRejected,
      inputTokens: diagnostics.inputTokens,
      outputTokens: diagnostics.outputTokens,
      codes: diagnostics.codes,
    });
    return { findings: gated.passed, units: batchedUnits, diagnostics };
  } catch {
    signal?.throwIfAborted();
    input.logger.warn("advisory pass failed open", {
      codes: [...diagnostics.codes, "advisory_pass_failed"],
    });
    return fail("advisory_pass_failed");
  }
}

/**
 * Advisory merge (plan 12 steps 3-8). Validates gated candidates through the
 * shared per-finding core, then applies suppression, advisory-only dedupe,
 * and the advisory cap before materializing final records. Fail-open: any
 * validation or merge failure discards advisories; primaries are untouched.
 */
export async function mergePhase6Advisory(input: {
  phase6: Phase6PipelineDeps;
  primary: PrimaryValidationResult;
  gated: { findings: Finding[]; units: ConventionAdvisoryUnit[] };
  diff: DiffResult;
  config: ResolvedConfig;
  signal?: AbortSignal | undefined;
  logger: Logger;
}): Promise<AdvisoryMergeResult> {
  const codes: string[] = [];
  const emptyMetadata: AdvisoryConflictMetadata = {
    suppressed: 0,
    advisoryDuplicates: 0,
    unmappableExcluded: 0,
    codes: [],
  };
  if (input.gated.findings.length === 0) {
    pushCode(codes, "advisory_skipped_no_candidates");
    return { advisory: [], metadata: emptyMetadata, diagnostics: { codes } };
  }
  try {
    input.signal?.throwIfAborted();
    const pending = await input.phase6.validation.validateAdvisoryCandidates(
      input.gated.findings,
      input.diff,
      input.gated.units,
      input.config,
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    const merged = resolveAdvisoryMerge(input.primary, pending);
    const advisory = input.phase6.validation.finalizeAdvisoryCandidates(merged.retained);
    for (const code of merged.metadata.codes) pushCode(codes, code);
    input.logger.info("advisory merge completed", {
      candidates: input.gated.findings.length,
      retained: advisory.length,
      suppressed: merged.metadata.suppressed,
      advisoryDuplicates: merged.metadata.advisoryDuplicates,
      unmappableExcluded: merged.metadata.unmappableExcluded,
      codes,
    });
    return { advisory, metadata: merged.metadata, diagnostics: { codes } };
  } catch (error) {
    input.signal?.throwIfAborted();
    input.logger.warn("advisory merge failed open", { codes: [...codes, "advisory_validation_failed"] });
    pushCode(codes, "advisory_validation_failed");
    void error;
    return { advisory: [], metadata: emptyMetadata, diagnostics: { codes } };
  }
}
