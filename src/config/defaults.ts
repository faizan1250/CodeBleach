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
