import { ReviewerError } from "../../src/core/errors.ts";
import type {
  ContextEngine,
  DiffEngine,
  LoadConfigFn,
  Publisher,
  ReviewEngine,
  StageName,
  ValidationEngine,
} from "../../src/core/contracts.ts";
import { ConfigFileSchema, type ResolvedConfig } from "../../src/config/schema.ts";
import { ok, err } from "../../src/core/result.ts";
import { emptyReviewUsage } from "../../src/review/result.ts";
import type {
  DiffResult,
  Finding,
  ReviewBuildResult,
  ReviewUnit,
  ValidatedFinding,
} from "../../src/types/index.ts";

/** Configurable engines for pipeline tests: record calls, inject failures, embed secrets. */
export interface FixtureOptions {
  failAt?: StageName | undefined;
  failure?: ReviewerError | undefined;
  secret?: string | undefined;
}

export interface FixtureEngines {
  diff: DiffEngine;
  context: ContextEngine;
  review: ReviewEngine;
  validation: ValidationEngine;
  publisher: Publisher;
  loadConfig: LoadConfigFn;
  order: string[];
  config: ResolvedConfig;
}

/** Deterministic empty review result for tests that only exercise other stages. */
export function emptyReviewResult(): ReviewBuildResult {
  return {
    status: "complete",
    findings: [],
    diagnostics: [],
    usage: emptyReviewUsage(),
    unitsSubmitted: 0,
    unitsReviewed: 0,
    unitsFailed: 0,
    promptVersion: "test-pass",
    promptHash: "test-hash",
    model: "test-model",
  };
}

function maybeFail(order: string[], stage: StageName, options: FixtureOptions): void {
  order.push(stage);
  if (options.failAt === stage) {
    throw options.failure ?? new ReviewerError({ code: "GIT_FAILED", message: `${stage} exploded` });
  }
}

export function createFixtureEngines(options: FixtureOptions = {}): FixtureEngines {
  const order: string[] = [];
  const config = ConfigFileSchema.parse({});

  const diffResult: DiffResult = { baseSha: "base", headSha: "head", mergeBase: "base", files: [] };
  const unit: ReviewUnit = {
    id: "unit-1",
    file: {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [1],
    },
    diff: {
      hunks: [],
      originalHunkCount: 0,
      includedHunkCount: 0,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: { name: "f", kind: "function", startLine: 1, endLine: 2, changedLines: [1] },
    context: [],
    rules: [],
  };
  const contextResult = {
    units: [unit],
    status: "complete" as const,
    diagnostics: {
      elapsedMs: 0,
      deadlineExceeded: false,
      parseBudgetExceeded: false,
      filesConsidered: 0,
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
  const secret = options.secret ?? "nothing-secret";
  const finding: Finding = {
    id: "finding-1",
    fingerprint: "fp-1",
    headSha: "head",
    origin: { pass: "test", unitId: "unit-1" },
    title: "uses secret",
    severity: "high",
    category: "security",
    file: "src/a.ts",
    line: 1,
    description: `value is ${secret}`,
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "q" }],
    introducedByPr: true,
  };
  const accepted: ValidatedFinding = {
    finding,
    status: "accepted",
    checks: [{ name: "schema", passed: true }],
  };

  const loadConfig = ((_repoDir: string) => Promise.resolve(ok({ config, source: "defaults" as const }))) as LoadConfigFn;

  return {
    order,
    config,
    loadConfig,
    diff: {
      run: () => {
        maybeFail(order, "diff", options);
        return Promise.resolve(diffResult);
      },
    },
    context: {
      build: () => {
        maybeFail(order, "context", options);
        return Promise.resolve(contextResult);
      },
    },
    review: {
      // Fixture review never touches the network: canned findings only.
      requiresLlm: false,
      review: (units) => {
        maybeFail(order, "review", options);
        return Promise.resolve({
          ...emptyReviewResult(),
          findings: [finding],
          usage: { ...emptyReviewUsage(), requests: 1 },
          unitsSubmitted: units.length,
          unitsReviewed: units.length,
          unitsFailed: 0,
        });
      },
    },
    validation: {
      validate: () => {
        maybeFail(order, "validation", options);
        return Promise.resolve([accepted]);
      },
    },
    publisher: {
      publish: () => {
        maybeFail(order, "publish", options);
        return Promise.resolve({ published: 1, skipped: 0, failures: [] });
      },
    },
  };
}

export function failingLoadConfig(code: "CONFIG_INVALID" | "CONFIG_UNSUPPORTED_VERSION"): LoadConfigFn {
  return ((_repoDir: string) =>
    Promise.resolve(
      err(new ReviewerError({ code, message: "bad config" })),
    )) as LoadConfigFn;
}
