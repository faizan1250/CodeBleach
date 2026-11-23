// Phase 6 advisory token-budget packer (P6-03, plan section 9.3).
//
// Packs lean-projected units into at most five advisory requests of at most
// three units each (fifteen units per run). Every emitted request is
// measured in its serialized prompt-bound form against the 6000-token input
// ceiling; overflow sheds lowest-ranked convention summaries first, then
// spills whole units to a later request. A unit that cannot fit even alone
// is skipped and counted: packing never fails a run (fail-closed).

import type {
  AdvisoryConventionSummary,
  ConventionAdvisoryBatchInput,
  ConventionAdvisoryUnit,
  InferredConvention,
} from "../types/conventions.ts";
import {
  MAX_ADVISORY_FIXED_INPUT_TOKENS,
  MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_REQUESTS_PER_RUN,
  MAX_ADVISORY_SUMMARIES_PER_REQUEST,
  MAX_ADVISORY_UNITS_PER_REQUEST,
  MAX_ADVISORY_UNITS_PER_RUN,
  MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST,
} from "./constants.ts";
import { orderAdvisoryUnits, serializeConventionAdvisoryUnit } from "./projection.ts";
import { countAdvisoryTokens } from "./token-budget.ts";

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Rank order mirrors the support selection (support desc via exact integer
// cross-product, matching desc, detector asc, stable id asc): rank position
// decides both summary retention and budget-overflow shedding.
function compareConventions(a: InferredConvention, b: InferredConvention): number {
  const supportOrder = b.matchingFiles * a.eligibleFiles - a.matchingFiles * b.eligibleFiles;
  if (supportOrder !== 0) return supportOrder;
  if (a.matchingFiles !== b.matchingFiles) return b.matchingFiles - a.matchingFiles;
  const detectorOrder = compareStrings(a.detector, b.detector);
  if (detectorOrder !== 0) return detectorOrder;
  return compareStrings(a.id, b.id);
}

function toSummary(convention: InferredConvention): AdvisoryConventionSummary {
  return {
    detector: convention.detector,
    pattern: convention.pattern,
    matchingFiles: convention.matchingFiles,
    eligibleFiles: convention.eligibleFiles,
    supportRatio: convention.supportRatio,
  };
}

// Highest-ranked summaries first, bounded to eight records and the 600-token
// convention sub-budget. Evidence arrays cannot cross this boundary by type:
// summaries carry pattern statements and aggregate counts only.
function selectSummaries(conventions: readonly InferredConvention[]): AdvisoryConventionSummary[] {
  const ranked = [...conventions].sort(compareConventions);
  const selected: AdvisoryConventionSummary[] = [];
  for (const convention of ranked) {
    if (selected.length >= MAX_ADVISORY_SUMMARIES_PER_REQUEST) break;
    const summary = toSummary(convention);
    if (countAdvisoryTokens(JSON.stringify([...selected, summary])) > MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST) break;
    selected.push(summary);
  }
  return selected;
}

// Measured cost of one request: the fixed template/schema framing reserve
// plus the serialized summaries and units. This is the fail-closed gate:
// every emitted batch must fit the per-request input ceiling.
export function measureAdvisoryRequest(input: ConventionAdvisoryBatchInput): number {
  const summariesTokens = countAdvisoryTokens(JSON.stringify(input.conventions));
  let unitsTokens = 0;
  for (const unit of input.units) unitsTokens += countAdvisoryTokens(serializeConventionAdvisoryUnit(unit));
  return MAX_ADVISORY_FIXED_INPUT_TOKENS + summariesTokens + unitsTokens;
}

function fitsRequest(
  units: readonly ConventionAdvisoryUnit[],
  summaries: readonly AdvisoryConventionSummary[],
): boolean {
  return (
    measureAdvisoryRequest({ units: [...units], conventions: [...summaries] }) <= MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST
  );
}

// Trims lowest-ranked summaries until the request fits (or none remain).
function fitBatch(
  units: readonly ConventionAdvisoryUnit[],
  summaries: readonly AdvisoryConventionSummary[],
): ConventionAdvisoryBatchInput {
  let kept = [...summaries];
  while (kept.length > 0 && !fitsRequest(units, kept)) kept = kept.slice(0, -1);
  return { units: [...units], conventions: kept };
}

export interface AdvisoryPackResult {
  batches: ConventionAdvisoryBatchInput[];
  skippedUnits: number;
}

export function packAdvisoryBatches(input: {
  units: readonly ConventionAdvisoryUnit[];
  conventions: readonly InferredConvention[];
}): AdvisoryPackResult {
  const ordered = orderAdvisoryUnits(input.units);
  const summaries = selectSummaries(input.conventions);
  const batches: ConventionAdvisoryBatchInput[] = [];
  let current: ConventionAdvisoryUnit[] = [];
  let packedCount = 0;
  let skippedUnits = 0;

  const flushCurrent = (): void => {
    if (current.length === 0) return;
    // Structural 5-request cap: unreachable under frozen constants (every
    // flush holds exactly 3 units, so 5 flushes pack 15 and the loop-top
    // guard skips the rest), but fail-closed if constants ever change.
    if (batches.length >= MAX_ADVISORY_REQUESTS_PER_RUN) {
      skippedUnits += current.length;
      current = [];
      return;
    }
    batches.push(fitBatch(current, summaries));
    packedCount += current.length;
    current = [];
  };

  for (const unit of ordered) {
    if (packedCount + current.length >= MAX_ADVISORY_UNITS_PER_RUN) {
      skippedUnits += 1;
      continue;
    }
    const trial = [...current, unit];
    if (trial.length <= MAX_ADVISORY_UNITS_PER_REQUEST && fitsRequest(trial, summaries)) {
      current = trial;
      continue;
    }
    flushCurrent();
    if (batches.length >= MAX_ADVISORY_REQUESTS_PER_RUN || packedCount >= MAX_ADVISORY_UNITS_PER_RUN) {
      skippedUnits += 1;
      continue;
    }
    const alone = fitBatch([unit], summaries);
    if (!fitsRequest(alone.units, alone.conventions)) {
      skippedUnits += 1;
      continue;
    }
    current = [unit];
  }
  flushCurrent();
  return { batches, skippedUnits };
}
