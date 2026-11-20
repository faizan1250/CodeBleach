export const CONFIG_VERSION = 1 as const;

export const DEFAULT_ENABLED = true;

export const DEFAULT_CATEGORIES = {
  bugs: true,
  security: true,
  performance: false,
  concurrency: true,
} as const;

export const DEFAULT_SEVERITY_THRESHOLD = "medium" as const;

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

export const DEFAULT_MAX_FINDINGS = 10;

export const DEFAULT_MAX_RUN_TIME_MS = 120000;

export const DEFAULT_MAX_PARSE_TIME_MS = 2000;

export const DEFAULT_MAX_TOTAL_PARSE_TIME_MS = 30000;

export const MIN_MAX_RUN_TIME_MS = 5000;

export const MAX_MAX_RUN_TIME_MS = 600000;

export const MIN_MAX_PARSE_TIME_MS = 100;

export const MAX_MAX_PARSE_TIME_MS = 30000;

export const MIN_MAX_TOTAL_PARSE_TIME_MS = 1000;

export const MAX_MAX_TOTAL_PARSE_TIME_MS = 180000;

export const DEFAULT_MAX_TOKENS_PER_UNIT = 12000;

export const MIN_MAX_TOKENS_PER_UNIT = 1000;

export const MAX_MAX_TOKENS_PER_UNIT = 24000;

// Non-secret llm.* runtime controls (fixed model; no provider/model selectors).
// Token ceilings are starting defaults: P4-02 clamps them to the authenticated
// model limit.* at runtime, never the reverse.
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 90000;

export const MIN_LLM_REQUEST_TIMEOUT_MS = 1000;

export const MAX_LLM_REQUEST_TIMEOUT_MS = 600000;

export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 32768;

export const MIN_LLM_MAX_OUTPUT_TOKENS = 1;

// Third-party-reported limit.output; provisional until the P4-02 catalog read.
export const MAX_LLM_MAX_OUTPUT_TOKENS = 131072;

export const DEFAULT_LLM_MAX_RETRIES = 2;

export const MIN_LLM_MAX_RETRIES = 0;

export const MAX_LLM_MAX_RETRIES = 5;

export const DEFAULT_LLM_MAX_CONCURRENT_REQUESTS = 3;

export const MIN_LLM_MAX_CONCURRENT_REQUESTS = 1;

export const MAX_LLM_MAX_CONCURRENT_REQUESTS = 10;

export const DEFAULT_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS = 64000;

export const MIN_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS = 1000;

// Near the third-party-reported context size; provisional, runtime-clamped.
export const MAX_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS = 1000000;

export const DEFAULT_MAX_CHANGED_LINES_PER_FILE = 1500;

export const DEFAULT_MAX_FILE_SIZE_KB = 500;

// Absolute ceiling for review.max_file_size_kb: headBlobContent reads
// min(sizeBytes+1, 26MiB), so an accepted max must satisfy
// max*1024+1 <= 26MiB, i.e. max <= floor((26*1024*1024-1)/1024) = 26623.
// Larger values would admit a blob whose show overflows the per-stream
// spawn cap and fails as GIT_FAILED instead of skipping as too-large.
export const MAX_MAX_FILE_SIZE_KB = 26623;

export const DEFAULT_IGNORE_PATHS: readonly string[] = [
  "**/*.lock",
  "dist/**",
  "build/**",
  "node_modules/**",
  "**/*.generated.*",
  "**/*.snap",
  "**/*.min.*",
];

export const DEFAULT_LANGUAGE = "typescript" as const;

/**
 * Merge user-supplied ignore paths after the built-in defaults.
 * Defaults come first, then user extras in file order; duplicates drop.
 * An absent or empty user list still yields the full defaults.
 */
export function mergeIgnorePaths(userPaths: readonly string[] | undefined): string[] {
  const merged = [...DEFAULT_IGNORE_PATHS];
  for (const entry of userPaths ?? []) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return merged;
}
