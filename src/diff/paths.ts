import { ReviewerError } from "../core/errors.ts";
import type { Language } from "../types/diff.ts";

// Git emits repo-relative `/`-separated paths; never resolve them against the
// working tree. Rejects only what the contract forbids: empty, NUL,
// absolute, and `..` segments.
export function normalizeRepoPath(path: string): string {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
    throw new ReviewerError({
      code: "PARSE_FAILED",
      message: `invalid repository path ${JSON.stringify(path)}`,
    });
  }
  return path;
}

const EXTENSION_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

export function detectLanguage(path: string): Language | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSION_LANGUAGE[base.slice(dot).toLowerCase()] ?? null;
}
