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

export const DEFAULT_MAX_CHANGED_LINES_PER_FILE = 1500;

export const DEFAULT_IGNORE_PATHS: readonly string[] = [
  "**/*.lock",
  "dist/**",
  "build/**",
  "node_modules/**",
  "**/*.generated.*",
  "**/*.snap",
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
