import type { ChangedFile, ChangedSymbol, DiffHunk } from "./diff.ts";
import type { Rule } from "./rules.ts";

export interface ContextItem {
  id: string;
  kind: "definition" | "caller" | "callee" | "type" | "test" | "config" | "similar" | "rule";
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  tokens: number;
  reason: string;
}

export interface ReviewUnit {
  id: string;
  file: ReviewUnitFile;
  diff: ReviewUnitDiff;
  symbol: ChangedSymbol;
  context: ContextItem[];
  rules: Rule[];
}

/** Lightweight file projection for budgeted review payloads (P3-10, wired in P3-11). */
export interface ReviewUnitFile {
  path: string;
  oldPath: string | null;
  status: ChangedFile["status"];
  language: ChangedFile["language"];
  commentableLines: number[];
}

/** Whole-hunk diff slice for one unit; never a partial hunk. */
export interface ReviewUnitDiff {
  hunks: DiffHunk[];
  originalHunkCount: number;
  includedHunkCount: number;
  omittedHunkCount: number;
  truncated: boolean;
}

export type UnitSkipReason =
  | "mandatory-budget-exceeded"
  | "diff-exceeds-budget"
  | "run-deadline"
  | "parse-cancelled"
  | "parse-budget-exceeded"
  | "candidate-cap-exceeded";

export interface UnitSkip {
  path: string;
  symbol: string;
  reason: UnitSkipReason;
  requiredTokens?: number | undefined;
  maxTokens?: number | undefined;
}

export type ContextDiagnosticStage = "snapshot" | "parse" | "import" | "caller" | "callee" | "test";

export interface ContextDiagnostic {
  stage: ContextDiagnosticStage;
  path: string;
  symbol?: string | undefined;
  code: string;
  reason: string;
}

export interface ContextBuildDiagnostics {
  elapsedMs: number;
  deadlineExceeded: boolean;
  parseBudgetExceeded: boolean;
  filesConsidered: number;
  filesParsed: number;
  filesParseTimedOut: number;
  unitsCreated: number;
  unitsSkipped: UnitSkip[];
  unitsWithTruncatedDiff: number;
  unitsWithTruncatedDefinition: number;
  candidateFilesSkippedByCap: number;
  queryTimeouts: number;
  gitCalls: number;
  blobsFetched: number;
  blobCacheHits: number;
  batchFetches: number;
  parseCacheHits: number;
  parseCacheMisses: number;
  parseCacheEntries: number;
  diagnostics: ContextDiagnostic[];
}

export interface ContextBuildResult {
  units: ReviewUnit[];
  status: "complete" | "partial" | "failed";
  diagnostics: ContextBuildDiagnostics;
}
