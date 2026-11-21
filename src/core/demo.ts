import type { ContextEngine, DiffEngine, Publisher, ReviewEngine, ValidationEngine } from "./contracts.ts";
import type { ChangedFile, ContextBuildResult, Finding, ReviewUnit, ValidatedFinding } from "../types/index.ts";

export const DEMO_BASE_SHA = "demo-base";
export const DEMO_HEAD_SHA = "demo-head";

const DEMO_FILE = "src/demo.ts";

function demoChangedFile(): ChangedFile {
  return {
    path: DEMO_FILE,
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [
      {
        oldStart: 8,
        oldLines: 2,
        newStart: 8,
        newLines: 3,
        lines: [
          { kind: "ctx", oldLine: 8, newLine: 8, position: 1, text: "export function greet(name: string | null) {" },
          { kind: "ctx", oldLine: 9, newLine: 9, position: 2, text: '  const prefix = "hello";' },
          { kind: "add", oldLine: null, newLine: 10, position: 3, text: "  return name.trim().toUpperCase();" },
        ],
      },
    ],
    commentableLines: [8, 9, 10],
    symbols: [
      {
        name: "greet",
        kind: "function",
        startLine: 8,
        endLine: 12,
        changedLines: [10],
      },
    ],
  };
}

function demoFindings(unit: ReviewUnit): Finding[] {
  const base = {
    file: unit.file.path,
    line: 10,
    endLine: 10,
    headSha: DEMO_HEAD_SHA,
    origin: { pass: "demo", unitId: unit.id },
  } as const;
  return [
    {
      ...base,
      id: "demo-finding-1",
      fingerprint: "demo-fp-1",
      symbol: unit.symbol.name,
      title: "Possible null dereference on name",
      severity: "high",
      category: "null-handling",
      description: "name may be null at runtime; trim would throw.",
      suggestion: "Guard against null before trimming.",
      confidence: 0.9,
      evidence: [{ file: unit.file.path, startLine: 10, endLine: 10, quote: "name.trim()" }],
      introducedByPr: true,
    },
    {
      ...base,
      id: "demo-finding-2",
      fingerprint: "demo-fp-2",
      symbol: unit.symbol.name,
      title: "Missing return type annotation",
      severity: "low",
      category: "convention",
      description: "Exported function lacks an explicit return type.",
      confidence: 0.75,
      evidence: [
        { file: unit.file.path, startLine: 8, endLine: 8, quote: "export function greet(name: string): string {" },
      ],
      introducedByPr: true,
    },
  ];
}

/** Deterministic offline engines for `--demo`. Never touches git or the network. */
export const demoDiffEngine: DiffEngine = {
  run: (input) =>
    Promise.resolve({
      baseSha: input.baseSha,
      headSha: input.headSha,
      mergeBase: input.baseSha,
      files: [demoChangedFile()],
    }),
};

export const demoContextEngine: ContextEngine = {
  build: (diff) => {
    const file = diff.files[0];
    if (file === undefined || file.symbols[0] === undefined) {
      return Promise.resolve({
        units: [],
        status: "complete",
        diagnostics: {
          elapsedMs: 0,
          deadlineExceeded: false,
          parseBudgetExceeded: false,
          filesConsidered: 0,
          filesParsed: 0,
          filesParseTimedOut: 0,
          unitsCreated: 0,
          unitsSkipped: [],
          unitsWithTruncatedDiff: 0,
          unitsWithTruncatedDefinition: 0,
          candidateFilesSkippedByCap: 0,
          queryTimeouts: 0,
          gitCalls: 0,
          blobsFetched: 0,
          blobCacheHits: 0,
          batchFetches: 0,
          parseCacheHits: 0,
          parseCacheMisses: 0,
          parseCacheEntries: 0,
          diagnostics: [],
        },
      });
    }
    const symbol = file.symbols[0];
    const unit: ReviewUnit = {
      id: "demo-unit-1",
      file: {
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        language: file.language,
        commentableLines: [...file.commentableLines],
      },
      diff: {
        hunks: file.hunks,
        originalHunkCount: file.hunks.length,
        includedHunkCount: file.hunks.length,
        omittedHunkCount: 0,
        truncated: false,
      },
      symbol,
      context: [
        {
          id: "demo-ctx-definition",
          kind: "definition",
          file: file.path,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          text: "export function greet(name: string | null) {",
          score: 1,
          tokens: 12,
          reason: "changed symbol definition",
        },
      ],
      rules: [],
    };
    const result: ContextBuildResult = {
      units: [unit],
      status: "complete",
      diagnostics: {
        elapsedMs: 0,
        deadlineExceeded: false,
        parseBudgetExceeded: false,
        filesConsidered: 1,
        filesParsed: 0,
        filesParseTimedOut: 0,
        unitsCreated: 1,
        unitsSkipped: [],
        unitsWithTruncatedDiff: 0,
        unitsWithTruncatedDefinition: 0,
        candidateFilesSkippedByCap: 0,
        queryTimeouts: 0,
        gitCalls: 0,
        blobsFetched: 0,
        blobCacheHits: 0,
        batchFetches: 0,
        parseCacheHits: 0,
        parseCacheMisses: 0,
        parseCacheEntries: 0,
        diagnostics: [],
      },
    };
    return Promise.resolve(result);
  },
};

export const demoReviewEngine: ReviewEngine = {
  // Canned and network-free: no consent, key, or preflight needed.
  requiresLlm: false,
  review: (units) => {
    const findings = units.flatMap((unit) => demoFindings(unit));
    return Promise.resolve({
      status: "complete" as const,
      findings,
      diagnostics: [],
      usage: {
        requests: 0,
        retries: 0,
        repairRequests: 0,
        incompleteRetries: 0,
        costKnown: false,
      },
      unitsSubmitted: units.length,
      unitsReviewed: units.length,
      unitsFailed: 0,
      promptVersion: "demo",
      promptHash: "demo",
      model: "demo",
    });
  },
};

export const demoValidationEngine: ValidationEngine = {
  validate: (findings) => {
    const validated: ValidatedFinding[] = findings.map((finding, index) => ({
      finding,
      status: index === 0 ? ("accepted" as const) : ("rejected" as const),
      checks: [
        { name: "schema", outcome: "passed", code: "evidence_bounds_ok" },
        { name: "file-in-diff", outcome: "passed", code: "finding_path_resolved" },
        ...(index === 0
          ? [{ name: "evidence", outcome: "passed", code: "evidence_quote_verified" } as const]
          : [
              {
                name: "evidence",
                outcome: "failed",
                code: "evidence_quote_not_found",
                detail: "quote not found in context",
              } as const,
            ]),
      ],
    }));
    return Promise.resolve(validated);
  },
};

export const demoPublisher: Publisher = {
  publish: (findings) =>
    Promise.resolve({
      published: findings.filter((finding) => finding.status === "accepted").length,
      skipped: 0,
      failures: [],
    }),
};
