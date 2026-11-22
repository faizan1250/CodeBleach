import {
  DEMO_BASE_SHA,
  DEMO_HEAD_SHA,
  demoContextEngine,
  demoDiffEngine,
  demoPublisher,
  demoReviewEngine,
  demoValidationEngine,
} from "../../core/demo.ts";
import { ReviewerError } from "../../core/errors.ts";
import { GitDiffEngine } from "../../diff/git.ts";
import { ContextEngineImpl } from "../../context/engine.ts";
import { loadConfig } from "../../config/load.ts";
import type { LoadConfigFn, ValidationEngine } from "../../core/contracts.ts";
import { FIXED_MODEL_ID, FIXED_PROVIDER, TRAINING_OPT_IN_ENV } from "../../llm/constants.ts";
import type { Logger } from "../../core/logger.ts";
import { runPipeline } from "../../core/pipeline.ts";
import { OpenCodeProvider } from "../../providers/opencode.ts";
import { ReviewEngineImpl } from "../../review/engine.ts";
import { skippedReviewResult } from "../../review/result.ts";
import { stubPublisher, stubValidationEngine } from "../../core/stubs.ts";
import { createValidationEngine } from "../../validate/engine.ts";
import { readVersion } from "./version.ts";
import { exitCodeForError } from "../exit-codes.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationSummary } from "../../types/index.ts";

export interface ReviewOptions {
  base?: string | undefined;
  head?: string | undefined;
  repo: string;
  out: string;
  dryRun: boolean;
  demo: boolean;
  /** Explicit offline preview: diff + context only, review/validation skipped. */
  noLlm: boolean;
  /** Phase 6 opt-in (default false); demo and --no-llm ignore it. P6-00: live use fails closed. */
  conventionAdvisory?: boolean | undefined;
  logLevel: string;
  runId: string;
  /** Exact key bytes for logger/artifact redaction; never logged itself. */
  secrets?: string[] | undefined;
  /** Test seam for gates and provider construction; defaults to process.env. */
  env?: Record<string, string | undefined> | undefined;
}

export interface RealReviewEngineInput {
  runId: string;
  version: string;
  env: Record<string, string | undefined>;
  secrets: string[];
  logger: Logger;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

/** Composition root for live review: fixed provider + engine, one opaque session per run. */
export function createRealReviewEngine(input: RealReviewEngineInput): ReviewEngineImpl {
  const sessionId = `ses_${input.runId.replace(/-/g, "")}`;
  const provider = new OpenCodeProvider({
    env: input.env,
    sessionId,
    version: input.version,
    maxRetries: input.maxRetries,
    timeoutMs: input.timeoutMs,
    fetchFn: input.fetchFn,
  });
  return new ReviewEngineImpl({
    provider,
    logger: input.logger,
    env: input.env,
    secrets: input.secrets,
  });
}

const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/**
 * Scope disclaimer for Phase 5 deterministic validation (ADR 0028 D1): counts
 * verify diff/path/location/evidence/provenance/policy only, never semantic
 * correctness of the bug claim.
 */
export const VALIDATION_SCOPE_NOTE =
  "validation verifies diff/path/location/evidence/provenance/policy only; it does not prove a finding is semantically correct.";

/**
 * Stderr warning when the run completes but run.json cannot be read/parsed.
 * Names the configured artifact path (the stage line above carries no path),
 * static text plus path only — never contents, validation counts, or the
 * raw error.
 */
export function validationSummaryUnavailableWarning(outDir: string): string {
  return (
    `review completed but validation summary unavailable: ${join(outDir, "run.json")} unreadable or unparseable; ` +
    `validation may still have run, see the artifact for details`
  );
}

/** One-line CLI validation counts; null when validation did not run (skipped review). */
export function formatValidationLine(args: {
  outDir: string;
  findingsTotal: number;
  summary: ValidationSummary | null;
}): string | null {
  if (args.summary === null) return null;
  const summary = args.summary;
  return (
    `validation: ${args.findingsTotal} finding(s): ${summary.accepted} accepted, ` +
    `${summary.rejected} rejected, ${summary.inconclusive} inconclusive, ` +
    `${summary.duplicates} duplicate(s), ${summary.policyFiltered} policy-filtered; ` +
    `details in ${join(args.outDir, "run.json")}`
  );
}

function usageError(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
}

export async function runReview(options: ReviewOptions, logger: Logger): Promise<number> {
  if (!LOG_LEVELS.includes(options.logLevel)) {
    throw usageError(`unknown log level: ${options.logLevel}`);
  }
  const base = options.base ?? process.env["REVIEWER_BASE_SHA"] ?? (options.demo ? DEMO_BASE_SHA : undefined);
  const head = options.head ?? process.env["REVIEWER_HEAD_SHA"] ?? (options.demo ? DEMO_HEAD_SHA : undefined);
  if (base === undefined || head === undefined) {
    throw usageError("review requires --base and --head (or REVIEWER_BASE_SHA / REVIEWER_HEAD_SHA)");
  }

  const env = options.env ?? process.env;
  const secrets = options.secrets ?? [];

  // Demo is fully canned and never touches the network, with or without --no-llm.
  if (options.demo) {
    return runEngines(
      {
        diff: demoDiffEngine,
        context: demoContextEngine,
        review: demoReviewEngine,
        validation: demoValidationEngine,
        publisher: demoPublisher,
      },
      undefined,
      { ...options, base, head },
      logger,
    );
  }

  // --no-llm precedes provider initialization: no OpenCodeProvider is built or
  // health-checked, so no key or training opt-in is required and zero provider
  // calls are possible. The pipeline records the explicit skips.
  if (options.noLlm) {
    return runEngines(
      {
        diff: new GitDiffEngine({ logger }),
        context: new ContextEngineImpl({ logger }),
        review: { review: () => Promise.resolve(skippedReviewResult()), requiresLlm: false },
        validation: stubValidationEngine,
        publisher: stubPublisher,
      },
      undefined,
      { ...options, base, head },
      logger,
    );
  }

  // Phase 6 (P6-00, ADR 0043): demo and --no-llm bypass the bundle regardless
  // of the flag. Live use with the flag fails closed here: P6-00 locks
  // contracts only, and orchestration lands in P6-05.
  if (options.conventionAdvisory === true) {
    throw usageError("--convention-advisory runtime lands in P6-05 (P6-00 locks contracts only)");
  }

  // Live review: load config once for provider bounds, then reuse the same
  // loaded value inside the pipeline so CLI and stages cannot disagree.
  const loaded = await loadConfig(options.repo);
  if (!loaded.ok) throw loaded.error;
  logger.warn(
    `live review sends repository code to ${FIXED_MODEL_ID} (${FIXED_PROVIDER}), ` +
      `which is not zero-data-retention: prompts/completions may train future models; ` +
      `continuing requires ${TRAINING_OPT_IN_ENV}=true and the workspace training-data toggle`,
  );
  const review = createRealReviewEngine({
    runId: options.runId,
    version: await readVersion(),
    env,
    secrets,
    logger,
    maxRetries: loaded.value.config.llm.max_retries,
    timeoutMs: loaded.value.config.llm.request_timeout_ms,
  });
  const loadAgain: LoadConfigFn = async () => loaded;
  return runEngines(
    {
      diff: new GitDiffEngine({ logger }),
      context: new ContextEngineImpl({ logger }),
      review,
      // P5-09: live runs use the deterministic validator bound to this run's
      // repo; the reader is created per validation from the diff SHAs and
      // released after. --no-llm keeps the stub (review skipped, so the
      // validator never runs); demo keeps its canned engine.
      validation: createValidationEngine({ repoDir: options.repo }),
      publisher: stubPublisher,
    },
    loadAgain,
    { ...options, base, head },
    logger,
  );
}

interface ResolvedReviewOptions extends ReviewOptions {
  base: string;
  head: string;
}

/**
 * Prints the one-line validation summary from the run artifact. Warns on
 * stderr (exit stays 0) when the artifact is missing or unparseable.
 */
export async function printValidationSummary(outDir: string): Promise<void> {
  // Bounded CLI visibility (P5-10): counts only, never evidence quotes or
  // source text. The artifact holds per-finding reasons.
  try {
    const raw = await readFile(join(outDir, "run.json"), "utf8");
    const artifact = JSON.parse(raw) as {
      findings?: unknown[] | undefined;
      validationSummary?: ValidationSummary | null | undefined;
    };
    const line = formatValidationLine({
      outDir,
      findingsTotal: Array.isArray(artifact.findings) ? artifact.findings.length : 0,
      summary: artifact.validationSummary ?? null,
    });
    if (line !== null) {
      console.log(line);
      console.log(VALIDATION_SCOPE_NOTE);
    }
  } catch {
    // Static text plus the artifact path only — never the raw error,
    // evidence, or source — and no validation counts are claimed.
    console.error(validationSummaryUnavailableWarning(outDir));
  }
}

async function runEngines(
  engines: {
    diff: GitDiffEngine | typeof demoDiffEngine;
    context: ContextEngineImpl | typeof demoContextEngine;
    review:
      | ReviewEngineImpl
      | typeof demoReviewEngine
      | { review: () => Promise<ReturnType<typeof skippedReviewResult>>; requiresLlm?: boolean | undefined };
    validation: ValidationEngine;
    publisher: typeof demoPublisher | typeof stubPublisher;
  },
  loadConfig: LoadConfigFn | undefined,
  options: ResolvedReviewOptions,
  logger: Logger,
): Promise<number> {
  try {
    const summary = await runPipeline(
      { ...engines, logger, ...(loadConfig === undefined ? {} : { loadConfig }) },
      {
        repoDir: options.repo,
        baseSha: options.base,
        headSha: options.head,
        dryRun: options.dryRun,
        outDir: options.out,
        runId: options.runId,
        secrets: options.secrets,
        env: options.env,
      },
    );
    console.log(`review ${summary.status}: ${summary.stages.length} stages, ${summary.configSource} config`);
    await printValidationSummary(options.out);
    if (options.noLlm && !options.demo) {
      console.log("offline preview: no model review or validation occurred (--no-llm)");
    }
    return 0;
  } catch (error) {
    if (error instanceof ReviewerError) {
      console.error(`review failed [${error.code}]: ${error.message}`);
    } else {
      console.error(`review failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return exitCodeForError(error);
  }
}
