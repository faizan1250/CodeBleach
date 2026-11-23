// Phase 6 frozen bounds (P6-00, ADR 0043). Values mirror
// implementation-phase6.md sections 5.3, 7, and 9.3 exactly; any change is a
// contract change requiring a plan update plus a new ADR.

// Merge-base sampling (plan 5.3).
export const MAX_SAMPLED_FILES = 200;
export const MAX_SAMPLED_FILE_BYTES = 131072;
export const MAX_SAMPLED_TOTAL_BYTES = 8388608;
export const SAMPLING_POLICY_VERSION = 2;
// Ranking hash domain: sha256(domain + NUL + canonicalPath), ascending.
export const SAMPLING_HASH_DOMAIN = "codebleach-phase6-base-sampling-v2" as const;
// First-cut population: already-supported JavaScript/TypeScript extensions.
export const PHASE6_SAMPLED_EXTENSIONS: readonly [".js", ".jsx", ".ts", ".tsx"] = [".js", ".jsx", ".ts", ".tsx"];

// Support filtering and stable records (plan 7).
export const MIN_SUPPORT_RATIO = 0.75;
export const MIN_EVIDENCE_FILES = 5;
export const MIN_DOMINANCE_MARGIN = 0.2;
export const MAX_CONVENTIONS_PER_RUN = 20;
export const MAX_EVIDENCE_PER_CONVENTION = 8;
export const MAX_CONVENTION_PATTERN_CHARS = 240;
export const INFERRED_CONVENTION_ID_PREFIX = "inf-" as const;

// First-cut detector identities (plan 6). Filename-only and test-layout
// detectors are excluded; these three families are the complete set.
export const CONVENTION_DETECTOR_NAMING = "naming-exports" as const;
export const CONVENTION_DETECTOR_NAMING_VERSION = 1;
export const CONVENTION_DETECTOR_ERROR_HANDLING = "error-handling" as const;
export const CONVENTION_DETECTOR_ERROR_HANDLING_VERSION = 1;
export const CONVENTION_DETECTOR_COMMON_WRAPPERS = "common-wrappers" as const;
export const CONVENTION_DETECTOR_COMMON_WRAPPERS_VERSION = 1;

// Advisory request budgets and concurrency (plan 9.3).
export const MAX_ADVISORY_REQUESTS_PER_RUN = 5;
export const MAX_ADVISORY_UNITS_PER_REQUEST = 3;
export const MAX_ADVISORY_SUMMARIES_PER_REQUEST = 8;
export const MAX_ADVISORY_UNITS_PER_RUN = 15;
export const MAX_ADVISORY_UNIT_TOKENS = 1500;
export const MAX_ADVISORY_FIXED_INPUT_TOKENS = 900;
export const MAX_CONVENTION_SUMMARY_TOKENS_PER_REQUEST = 600;
export const MAX_ADVISORY_INPUT_TOKENS_PER_REQUEST = 6000;
export const MAX_ADVISORY_OUTPUT_TOKENS_PER_REQUEST = 1200;
export const MAX_ADVISORY_FINDINGS_PER_UNIT = 1;
export const MAX_ADVISORY_FINDINGS_PER_RUN = 5;
export const MAX_ADVISORY_CONCURRENCY = 2;
export const MAX_ADVISORY_SYMBOL_SOURCE_TOKENS = 800;

// Isolated advisory policy projection (plan 10.2): severity threshold pinned
// to low, no inherited path/category severity overrides.
export const ADVISORY_SEVERITY_THRESHOLD = "low" as const;
