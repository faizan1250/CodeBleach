import { describe, expect, test } from "bun:test";
import {
  ADVISORY_SEVERITY_THRESHOLD,
  CONVENTION_DETECTOR_COMMON_WRAPPERS,
  CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION,
  CONVENTION_DETECTOR_ERROR_HANDLING,
  CONVENTION_DETECTOR_ERROR_HANDLING_VERSION,
  CONVENTION_DETECTOR_NAMING,
  CONVENTION_DETECTOR_NAMING_VERSION,
  INFERRED_CONVENTION_ID_PREFIX,
  MAX_ADVISORY_CONCURRENCY,
  MAX_ADVISORY_FINDINGS_PER_RUN,
  MAX_ADVISORY_FINDINGS_PER_UNIT,
  MAX_ADVISORY_FIXED_INPUT_TOKENS,
  MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_OUTPUT_TOKENS_PER_REQUEST,
  MAX_ADVISORY_REQUESTS_PER_RUN,
  MAX_ADVISORY_SYMBOL_SOURCE_TOKENS,
  MAX_ADVISORY_UNITS_PER_REQUEST,
  MAX_ADVISORY_UNITS_PER_RUN,
  MAX_ADVISORY_UNIT_TOKENS,
  MAX_CONVENTIONS_PER_RUN,
  MAX_CONVENTION_PATTERN_CHARS,
  MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST,
  MAX_EVIDENCE_PER_CONVENTION,
  MAX_SAMPLED_FILES,
  MAX_SAMPLED_FILE_BYTES,
  MAX_SAMPLED_TOTAL_BYTES,
  MIN_DOMINANCE_MARGIN,
  MIN_EVIDENCE_FILES,
  MIN_SUPPORT_RATIO,
  PHASE6_SAMPLED_EXTENSIONS,
  SAMPLING_HASH_DOMAIN,
  SAMPLING_POLICY_VERSION,
} from "../../../src/conventions/constants.ts";
import {
  ADVISORY_TOKEN_COUNTER_MODE,
  countAdvisoryTokens,
  fitsAdvisoryRequestBudget,
  fitsAdvisoryUnitBudget,
} from "../../../src/conventions/token-budget.ts";
import type {
  ConventionAdvisoryBatchInput,
  ConventionAdvisoryUnit,
  PendingAdvisoryCandidate,
  PrimaryValidationResult,
} from "../../../src/types/conventions.ts";
import type { ValidatedFinding } from "../../../src/types/validation.ts";

function unit(overrides: Partial<ConventionAdvisoryUnit> = {}): ConventionAdvisoryUnit {
  return {
    unitId: "unit-1",
    path: "src/a.ts",
    language: "typescript",
    symbol: { name: "f", kind: "function", signature: "f(): number", side: "head", startLine: 1 },
    diffHunks: [{ baseStartLine: 1, headStartLine: 1, lines: ["+return 2;"] }],
    changedSymbolSource: "export function f(): number {\n  return 2;\n}",
    ...overrides,
  };
}

describe("p6-00 sampling and support bounds", () => {
  test("pins merge-base sampling caps and policy version", () => {
    expect(MAX_SAMPLED_FILES).toBe(200);
    expect(MAX_SAMPLED_FILE_BYTES).toBe(131072);
    expect(MAX_SAMPLED_TOTAL_BYTES).toBe(8388608);
    expect(SAMPLING_POLICY_VERSION).toBe(2);
    expect(SAMPLING_HASH_DOMAIN).toBe("codebleach-phase6-base-sampling-v2");
    expect(MAX_SAMPLED_FILES * MAX_SAMPLED_FILE_BYTES).toBeGreaterThan(MAX_SAMPLED_TOTAL_BYTES);
  });

  test("pins support thresholds and evidence caps", () => {
    expect(MIN_SUPPORT_RATIO).toBe(0.75);
    expect(MIN_EVIDENCE_FILES).toBe(5);
    expect(MIN_DOMINANCE_MARGIN).toBe(0.2);
    expect(MAX_CONVENTIONS_PER_RUN).toBe(20);
    expect(MAX_EVIDENCE_PER_CONVENTION).toBe(8);
    expect(MAX_CONVENTION_PATTERN_CHARS).toBe(240);
    expect(INFERRED_CONVENTION_ID_PREFIX).toBe("inf-");
  });

  test("pins detector names and versions", () => {
    expect(CONVENTION_DETECTOR_NAMING).toBe("naming-exports");
    expect(CONVENTION_DETECTOR_NAMING_VERSION).toBe(1);
    expect(CONVENTION_DETECTOR_ERROR_HANDLING).toBe("error-handling");
    expect(CONVENTION_DETECTOR_ERROR_HANDLING_VERSION).toBe(1);
    expect(CONVENTION_DETECTOR_COMMON_WRAPPERS).toBe("common-wrappers");
    expect(CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION).toBe(1);
  });

  test("pins sampled language extensions", () => {
    expect([...PHASE6_SAMPLED_EXTENSIONS]).toEqual([".js", ".jsx", ".ts", ".tsx"]);
  });
});

describe("p6-00 advisory budgets", () => {
  test("pins request, unit, and concurrency ceilings", () => {
    expect(MAX_ADVISORY_REQUESTS_PER_RUN).toBe(5);
    expect(MAX_ADVISORY_UNITS_PER_REQUEST).toBe(3);
    expect(MAX_ADVISORY_UNITS_PER_RUN).toBe(15);
    expect(MAX_ADVISORY_UNIT_TOKENS).toBe(1500);
    expect(MAX_ADVISORY_FIXED_INPUT_TOKENS).toBe(900);
    expect(MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST).toBe(600);
    expect(MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST).toBe(6000);
    expect(MAX_ADVISORY_OUTPUT_TOKENS_PER_REQUEST).toBe(1200);
    expect(MAX_ADVISORY_FINDINGS_PER_UNIT).toBe(1);
    expect(MAX_ADVISORY_FINDINGS_PER_RUN).toBe(5);
    expect(MAX_ADVISORY_CONCURRENCY).toBe(2);
    expect(MAX_ADVISORY_SYMBOL_SOURCE_TOKENS).toBe(800);
    expect(ADVISORY_SEVERITY_THRESHOLD).toBe("low");
    expect(MAX_ADVISORY_FIXED_INPUT_TOKENS + MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST).toBe(1500);
    expect(
      MAX_ADVISORY_FIXED_INPUT_TOKENS +
        MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST +
        MAX_ADVISORY_UNITS_PER_REQUEST * MAX_ADVISORY_UNIT_TOKENS,
    ).toBe(MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST);
  });
});

describe("p6-00 advisory token counter", () => {
  const batch: ConventionAdvisoryBatchInput = {
    units: [unit()],
    conventions: [
      {
        detector: CONVENTION_DETECTOR_NAMING,
        pattern: "Modules predominantly use named exports.",
        matchingFiles: 9,
        eligibleFiles: 10,
        supportRatio: 0.9,
      },
    ],
  };

  test("uses the documented conservative upper-bound counter", () => {
    expect(ADVISORY_TOKEN_COUNTER_MODE).toBe("utf8-byte-upper-bound");
    expect(countAdvisoryTokens("")).toBe(0);
    expect(countAdvisoryTokens("abcd")).toBe(2);
  });

  test("golden: small batch measures under budget", () => {
    expect(fitsAdvisoryUnitBudget(batch.units[0] as ConventionAdvisoryUnit)).toBe(true);
    expect(fitsAdvisoryRequestBudget(batch)).toBe(true);
  });

  test("golden: oversized symbol source exceeds the unit ceiling", () => {
    const oversized = unit({ changedSymbolSource: `${"x".repeat(6000)}\n` });
    expect(fitsAdvisoryUnitBudget(oversized)).toBe(false);
    expect(fitsAdvisoryRequestBudget({ units: [oversized], conventions: [] })).toBe(true);
    expect(
      fitsAdvisoryRequestBudget({ units: [oversized, oversized, oversized], conventions: [] }),
    ).toBe(false);
  });
});

describe("p6-00 validation handoff types", () => {
  test("empty headLocations is a valid no-overlap handoff", () => {
    const result: PrimaryValidationResult = {
      findings: [],
      handoff: [{ findingId: "finding-1", headLocations: [] }],
    };
    expect(result.handoff).toHaveLength(1);
  });

  test("pending candidates are not assignable to final findings", () => {
    const pending = {
      phase: "pending-advisory-resolution",
      findingId: "finding-9",
      pendingFields: {
        finding: {
          id: "finding-9",
          fingerprint: "fp-9",
          headSha: "head",
          origin: { pass: "convention-advisory", unitId: "unit-1" },
          title: "t",
          severity: "low",
          category: "convention",
          file: "src/a.ts",
          line: 1,
          description: "d",
          confidence: 0.9,
          evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
          introducedByPr: true,
        },
        checks: [],
      },
      handoff: { findingId: "finding-9", headLocations: [] },
    } as PendingAdvisoryCandidate;
    // @ts-expect-error - pending advisory candidates must never persist as final findings
    const final: ValidatedFinding = pending;
    expect(final === (pending as unknown)).toBe(true);
  });
});
