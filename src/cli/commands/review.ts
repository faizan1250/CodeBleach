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
import type { LoadConfigFn, Phase6PipelineDeps, Publisher, ValidationEngine } from "../../core/contracts.ts";
import { ConventionEngineImpl } from "../../conventions/engine.ts";
import { createPinnedAdvisoryProjector } from "../../conventions/projection.ts";
import { FIXED_MODEL_ID, FIXED_PROVIDER, TRAINING_OPT_IN_ENV } from "../../llm/constants.ts";
import type { Logger } from "../../core/logger.ts";
import { runPipeline } from "../../core/pipeline.ts";
import { OpenCodeProvider } from "../../providers/opencode.ts";
import { RunConcurrencyLimiter } from "../../providers/limiter.ts";
import { ConventionAdvisoryReviewEngineImpl } from "../../review/convention-engine.ts";
import { ReviewEngineImpl } from "../../review/engine.ts";
import { skippedReviewResult } from "../../review/result.ts";
import { stubPublisher, stubValidationEngine } from "../../core/stubs.ts";
import { createPhase6ValidationEngine, createValidationEngine } from "../../validate/engine.ts";
import { readVersion } from "./version.ts";
import { exitCodeForError } from "../exit-codes.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrMeta, PublishResult, ValidationSummary } from "../../types/index.ts";
import { createGitHubClient, resolveGitHubToken } from "../../github/client.ts";
import { createGitHubPublisher } from "../../github/publish.ts";
import { assertPrMetaMatchesDiff, resolvePrMetaFromEnv } from "../../github/pr-meta.ts";
import { normalizePublishResult, type LegacyPublishResult } from "../../core/run-artifact.ts";

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
  /** Run-scoped shared ceiling; when present the provider is wrapped so its
   * complete() calls contend with the advisory pass for the same permits. */
  limiter?: RunConcurrencyLimiter | undefined;
}

/** Composition root for live review: fixed provider + engine, one opaque session per run. */
export function createRealReviewEngine(input: RealReviewEngineInput): ReviewEngineImpl {
  const sessionId = `ses_${input.runId.replace(/-/g, "")}`;
  const inner = new OpenCodeProvider({
    env: input.env,
    sessionId,
    version: input.version,
    maxRetries: input.maxRetries,
    timeoutMs: input.timeoutMs,
    fetchFn: input.fetchFn,
  });
  const provider = input.limiter === undefined ? inner : input.limiter.wrap(inner);
  return new ReviewEngineImpl({
    provider,
    logger: input.logger,
    env: input.env,
    secrets: input.secrets,
  });
}

export interface AdvisoryReviewEngineInput {
  runId: string;
  version: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Same run-scoped instance the primary engine wraps: combined in-flight
   * calls stay within the configured ceiling. Sessions stay separate. */
  limiter?: RunConcurrencyLimiter | undefined;
}

/** Advisory composition: zero-retry provider on its own session, sharing the run limiter. */
export function createAdvisoryReviewEngine(input: AdvisoryReviewEngineInput): ConventionAdvisoryReviewEngineImpl {
  const inner = new OpenCodeProvider({
    env: input.env,
    sessionId: `ses_${input.runId.replace(/-/g, "")}-advisory`,
    version: input.version,
    maxRetries: 0,
    timeoutMs: input.timeoutMs,
    fetchFn: input.fetchFn,
  });
  const provider = input.limiter === undefined ? inner : input.limiter.wrap(inner);
  return new ConventionAdvisoryReviewEngineImpl({ provider, env: input.env });
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

/**
 * One-line CLI publish counts; null when publish did not run (null result).
 * Only counts and stable run-level codes — never finding text, raw API
 * messages, or PR-controlled strings.
 */
export function formatPublishLine(result: PublishResult): string {
  const runCodes = result.runFailures.map((failure) => failure.code).join(",");
  const suffix = runCodes.length === 0 ? "none" : runCodes;
  return (
    `publish: ${result.published} published, ${result.skipped} skipped, ` +
    `${result.failures.length} failure(s); run failures: ${suffix}`
  );
}

/** Stderr warning when publish ran but its summary cannot be rendered. */
export function publishSummaryUnavailableWarning(outDir: string): string {
  return (
    `review completed but publish summary unavailable: ${join(outDir, "run.json")} unreadable or unparseable; ` +
    `see the artifact for details`
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
  // The synthetic PR identity satisfies the live-publish gate; the canned
  // publisher never leaves the process (no GitHub client, no token).
  if (options.demo) {
    const demoPr: PrMeta = { owner: "demo", repo: "demo", number: 1, baseSha: base, headSha: head };
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
      demoPr,
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

  // Live review: load config once for provider bounds, then reuse the same
  // loaded value inside the pipeline so CLI and stages cannot disagree.
  const loaded = await loadConfig(options.repo);
  if (!loaded.ok) throw loaded.error;
  // P7-04: PR identity preflight before expensive model work. Dry-run stays
  // offline (no token required, no GitHub calls); a requested live publish
  // fails here on missing token/meta instead of after the review.
  const prMeta = resolvePrMetaFromEnv(env);
  let publisher: Publisher;
  let pr: PrMeta | undefined;
  if (options.dryRun) {
    if (prMeta !== null) assertPrMetaMatchesDiff(prMeta, base, head);
    publisher = stubPublisher;
    pr = prMeta ?? undefined;
  } else {
    if (prMeta === null) {
      throw usageError(
        "live publish requires pull-request metadata: set GITHUB_REPOSITORY, CODEBLEACH_PR_NUMBER, CODEBLEACH_BASE_SHA, and CODEBLEACH_HEAD_SHA",
      );
    }
    assertPrMetaMatchesDiff(prMeta, base, head);
    const token = resolveGitHubToken(env);
    if (token === undefined) {
      throw usageError("live publish requires GITHUB_TOKEN: set it to a write-capable token for live publish");
    }
    // One Octokit instance per run; GitHub calls never consume the LLM limiter.
    publisher = createGitHubPublisher({ api: createGitHubClient({ token }) });
    pr = prMeta;
  }
  // Phase 6 (P6-05, ADR 0043): the flag composes the optional advisory
  // bundle. Demo and --no-llm bypass it above; the pipeline preflight
  // rejects a flagged run whose bundle is missing, so a live flagged run
  // always carries one.
  let phase6: Phase6PipelineDeps | undefined;
  // Run-scoped shared limiter (one instance per live run): the primary and
  // advisory providers contend for the same max_concurrent_requests permits,
  // so their combined in-flight calls never exceed it. Sessions and retry
  // policies stay separate; only the ceiling is shared.
  const limiter = new RunConcurrencyLimiter(loaded.value.config.llm.max_concurrent_requests);
  if (options.conventionAdvisory === true) {
    // Advisory-specific provider: zero retries and its own session, sharing
    // the operator env (training gate, key) with the primary provider. Batch
    // fan-out stays within the advisory concurrency cap orchestration-side.
    phase6 = {
      conventions: new ConventionEngineImpl(),
      advisoryProjector: createPinnedAdvisoryProjector(options.repo),
      advisoryReview: createAdvisoryReviewEngine({
        runId: options.runId,
        version: await readVersion(),
        env,
        timeoutMs: loaded.value.config.llm.request_timeout_ms,
        limiter,
      }),
      validation: createPhase6ValidationEngine({ repoDir: options.repo }),
    };
  }
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
    limiter,
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
      // P7-04: live non-dry-run publishes through the GitHub publisher (one
      // Octokit per run, constructed above); dry-run keeps the stub and the
      // pipeline skips publish, so no GitHub calls occur.
      publisher,
      ...(phase6 === undefined ? {} : { phase6 }),
    },
    loadAgain,
    { ...options, base, head },
    logger,
    pr,
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

/**
 * Prints the one-line publish summary from the run artifact. No output when
 * publish did not run (null result: dry-run/--no-llm/skipped). Warns on
 * stderr (exit stays 0) when the artifact is missing or unparseable.
 */
export async function printPublishSummary(outDir: string): Promise<void> {
  try {
    const raw = await readFile(join(outDir, "run.json"), "utf8");
    const artifact = JSON.parse(raw) as {
      publishResult?: LegacyPublishResult | null | undefined;
    };
    const result = normalizePublishResult(artifact.publishResult ?? null);
    if (result === null) return;
    console.log(formatPublishLine(result));
  } catch {
    console.error(publishSummaryUnavailableWarning(outDir));
  }
}

/**
 * Phase 6 opt-in for the pipeline (P6-00, ADR 0043): live path only. Demo
 * and --no-llm ignore the flag and run without a Phase 6 bundle, so
 * forwarding it there would trip the pipeline preflight.
 */
export function pipelineConventionAdvisoryEnabled(options: {
  conventionAdvisory?: boolean | undefined;
  demo: boolean;
  noLlm: boolean;
}): boolean {
  return options.conventionAdvisory === true && !options.demo && !options.noLlm;
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
    publisher: Publisher;
    phase6?: Phase6PipelineDeps | undefined;
  },
  loadConfig: LoadConfigFn | undefined,
  options: ResolvedReviewOptions,
  logger: Logger,
  prMeta?: PrMeta | undefined,
): Promise<number> {
  try {
    const summary = await runPipeline(
      { ...engines, logger, ...(loadConfig === undefined ? {} : { loadConfig }) },
      {
        repoDir: options.repo,
        baseSha: options.base,
        headSha: options.head,
        ...(prMeta === undefined ? {} : { pr: prMeta }),
        dryRun: options.dryRun,
        outDir: options.out,
        runId: options.runId,
        options: { conventionAdvisoryEnabled: pipelineConventionAdvisoryEnabled(options) },
        secrets: options.secrets,
        env: options.env,
      },
    );
    console.log(`review ${summary.status}: ${summary.stages.length} stages, ${summary.configSource} config`);
    await printValidationSummary(options.out);
    await printPublishSummary(options.out);
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
