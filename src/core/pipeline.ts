import { loadConfig as defaultLoadConfig } from "../config/load.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { ReviewerError } from "./errors.ts";
import type { ConfigSource, PipelineDeps, PipelineInput, RunSummary, StageName, StageResult } from "./contracts.ts";
import { isAcceptedFinding, isConventionAdvisoryFinding } from "./contracts.ts";
import {
  RUN_ARTIFACT_SCHEMA_VERSION,
  normalizePublishResult,
  summarizeValidation,
  writeArtifact,
  type RunArtifact,
} from "./run-artifact.ts";
import type { ValidationSummary } from "../types/index.ts";
import { requireLlmPreflight } from "../llm/preflight.ts";
import type { DiffResult, Finding, PrMeta, PublishResult, ReviewUnit, ValidatedFinding } from "../types/index.ts";
import type { ContextBuildDiagnostics } from "../types/context.ts";
import type { ReviewBuildResult } from "../types/review.ts";
import { mergePhase6Advisory, runPhase6AdvisoryPass, type AdvisoryPassResult } from "./phase6.ts";

function toReviewerError(error: unknown, stage: string): ReviewerError {
  if (error instanceof ReviewerError) return error;
  return new ReviewerError({
    code: "INTERNAL",
    message: `${stage} stage failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
  });
}

/** Run config → diff → context → review → validation → publish, persisting an artifact. */
export async function runPipeline(deps: PipelineDeps, input: PipelineInput): Promise<RunSummary> {
  const runId = input.runId;
  const startedAt = new Date().toISOString();
  const stages: StageResult[] = [];

  let configSource: ConfigSource = "unavailable";
  let config: ResolvedConfig | undefined;
  let diff: DiffResult | undefined;
  let units: ReviewUnit[] = [];
  let contextStatus: "complete" | "partial" | "failed" | null = null;
  let contextDiagnostics: ContextBuildDiagnostics | null = null;
  let findings: Finding[] = [];
  let reviewResult: ReviewBuildResult | null = null;
  let validated: ValidatedFinding[] = [];
  let validationSummary: ValidationSummary | null = null;
  let publishResult: PublishResult | null = null;

  const persist = async (status: RunArtifact["status"], failure?: ReviewerError): Promise<void> => {
    const artifact: RunArtifact = {
      schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      baseSha: input.baseSha,
      headSha: input.headSha,
      configSource,
      status,
      stages: [...stages],
      config: config ?? null,
      diff: diff ?? null,
      units,
      contextStatus,
      contextDiagnostics,
      findings,
      reviewStatus: reviewResult?.status ?? null,
      reviewPromptVersion: reviewResult?.promptVersion ?? null,
      reviewPromptHash: reviewResult?.promptHash ?? null,
      reviewModel: reviewResult?.model ?? null,
      reviewUnitsSubmitted: reviewResult?.unitsSubmitted ?? null,
      reviewUnitsReviewed: reviewResult?.unitsReviewed ?? null,
      reviewUnitsFailed: reviewResult?.unitsFailed ?? null,
      reviewUsage: reviewResult?.usage ?? null,
      reviewDiagnostics: reviewResult?.diagnostics ?? null,
      validated,
      validationSummary,
      publishResult,
      ...(failure === undefined
        ? {}
        : { error: { code: failure.code, message: failure.message, retryable: failure.retryable } }),
    };
    try {
      await writeArtifact(input.outDir, artifact, input.secrets ?? []);
    } catch (writeError) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: `failed to write run artifact: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        cause: failure ?? writeError,
      });
    }
  };

  const runStage = async <T>(
    name: StageName,
    fn: () => Promise<T>,
    count: (value: T) => number | undefined,
  ): Promise<T> => {
    const start = Date.now();
    try {
      const value = await fn();
      const itemCount = count(value);
      stages.push({
        name,
        status: "completed",
        ms: Date.now() - start,
        ...(itemCount === undefined ? {} : { count: itemCount }),
      });
      deps.logger.info("stage completed", { runId, stage: name, ms: Date.now() - start });
      return value;
    } catch (error) {
      stages.push({ name, status: "failed", ms: Date.now() - start });
      throw error;
    }
  };

  try {
    const loaded = await runStage(
      "config",
      async () => {
        const load = deps.loadConfig ?? defaultLoadConfig;
        const result = await load(input.repoDir);
        if (!result.ok) throw result.error;
        return result.value;
      },
      () => undefined,
    );
    config = loaded.config;
    configSource = loaded.source;
    const resolved = config;
    await persist("running");

    // LLM preflight (ADR 0025): runs that will call the model fail here —
    // before diff (git spawns) and context (parse over changed files) — on
    // missing consent/key or unusable budgets. Offline/canned review engines
    // (requiresLlm === false) skip it. Engine/provider gates stay as
    // defense-in-depth; no new stage is recorded, so a preflight failure
    // leaves stages at [config completed].
    if (deps.review.requiresLlm !== false) {
      requireLlmPreflight({ config: resolved, env: input.env });
    }

    // Phase 6 opt-in preflight (P6-00, ADR 0043): the flag requires the
    // optional bundle; without it the run fails closed, never downgrades.
    // Offline review engines (demo, --no-llm) bypass Phase 6 regardless of the
    // flag, so a stale bundle with an offline engine stays primary-only.
    if (input.options?.conventionAdvisoryEnabled === true) {
      if (deps.phase6 === undefined) {
        throw new ReviewerError({
          code: "CONFIG_INVALID",
          message:
            "convention advisory enabled without Phase 6 dependencies: explicit composition required, never silent downgrade",
        });
      }
    }
    const phase6Active =
      input.options?.conventionAdvisoryEnabled === true &&
      deps.phase6 !== undefined &&
      deps.review.requiresLlm !== false;
    let advisoryGated: AdvisoryPassResult | null = null;

    const diffResult = await runStage(
      "diff",
      () => deps.diff.run({ repoDir: input.repoDir, baseSha: input.baseSha, headSha: input.headSha, config: resolved }),
      (result) => result.files.length,
    );
    diff = diffResult;
    await persist("running");

    const contextResult = await runStage(
      "context",
      () => deps.context.build(diffResult, resolved, input.repoDir),
      (result) => result.units.length,
    );
    units = contextResult.units;
    contextStatus = contextResult.status;
    contextDiagnostics = contextResult.diagnostics;
    await persist("running");

    const result = await runStage(
      "review",
      // The exact head SHA comes from the diff, not the CLI flag: callers may
      // pass symbolic refs, and the engine must attribute code-owned metadata
      // to the resolved commit.
      async () => {
        if (!phase6Active || deps.phase6 === undefined) {
          return {
            primary: await deps.review.review(contextResult.units, resolved, { headSha: diffResult.headSha }),
            advisory: null as AdvisoryPassResult | null,
          };
        }
        // Phase 6 (plan 3.1, 12.1): the primary model pass starts immediately
        // and the advisory pass starts as soon as conventions are ready,
        // without awaiting primary completion. allSettled join: an advisory
        // failure can never fail or erase a successful primary review.
        const primaryPromise = deps.review.review(contextResult.units, resolved, { headSha: diffResult.headSha });
        const advisoryPromise = runPhase6AdvisoryPass({
          phase6: deps.phase6,
          repoDir: input.repoDir,
          diff: diffResult,
          units: contextResult.units,
          config: resolved,
          signal: input.signal,
          logger: deps.logger,
        });
        const [primarySettled, advisorySettled] = await Promise.allSettled([primaryPromise, advisoryPromise]);
        if (primarySettled.status === "rejected") throw primarySettled.reason;
        let advisory: AdvisoryPassResult | null = null;
        if (advisorySettled.status === "fulfilled") advisory = advisorySettled.value;
        else {
          input.signal?.throwIfAborted();
          deps.logger.warn("advisory pass failed open", {});
        }
        return { primary: primarySettled.value, advisory };
      },
      (value) => value.primary.findings.length,
    );
    findings = result.primary.findings;
    advisoryGated = result.advisory;
    reviewResult = result.primary;
    if (reviewResult.status === "skipped") {
      // --no-llm preview: nothing exists to validate or publish. Replace the
      // "completed" record runStage just added with an explicit skip, then
      // skip validation/publish with reasons instead of entering Phase 5 stubs.
      const completed = stages.pop();
      stages.push({
        name: "review",
        status: "skipped",
        ms: completed?.ms ?? 0,
        reason: "no_llm_flag",
      });
      stages.push({ name: "validation", status: "skipped", ms: 0, reason: "review_skipped_no_llm" });
      if (input.dryRun) {
        stages.push({ name: "publish", status: "skipped", ms: 0, reason: "dry-run" });
      } else {
        stages.push({ name: "publish", status: "skipped", ms: 0, reason: "review_skipped_no_llm" });
      }
      await persist("completed");
      return { runId, status: "completed", baseSha: input.baseSha, headSha: input.headSha, configSource, stages };
    }
    await persist("running");

    // P5-09: the deterministic validator is wired. Any validation failure
    // fails the stage, dry-run included; the Phase 4 NOT_IMPLEMENTED
    // tolerance is removed. With Phase 6 active, primaries finalize exactly
    // as Phase 5, then validated advisories merge after them (plan 12).
    const validatedList: ValidatedFinding[] = await runStage(
      "validation",
      async () => {
        if (!phase6Active || deps.phase6 === undefined || advisoryGated === null) {
          return deps.validation.validate(findings, diffResult, contextResult.units, resolved, {
            signal: input.signal,
          });
        }
        const primary = await deps.phase6.validation.validatePrimaryWithHandoff(
          findings,
          diffResult,
          contextResult.units,
          resolved,
          { signal: input.signal },
        );
        const merged = await mergePhase6Advisory({
          phase6: deps.phase6,
          primary,
          gated: { findings: advisoryGated.findings, units: advisoryGated.units },
          diff: diffResult,
          config: resolved,
          signal: input.signal,
          logger: deps.logger,
        });
        return [...primary.findings, ...merged.advisory];
      },
      (result) => result.filter(isAcceptedFinding).length,
    );
    validated = validatedList;
    // Fail closed on a broken engine contract: a status-accepted item that
    // fails the complete publish invariant (valid target + introduced-by-PR
    // basis) is never published or counted — the stage count above already
    // excludes it via the same guard, and the run fails here instead.
    const incompleteAccepted = validatedList.filter((item) => item.status === "accepted" && !isAcceptedFinding(item));
    if (incompleteAccepted.length > 0) {
      throw new ReviewerError({
        code: "INTERNAL",
        message: `validation contract violation: ${incompleteAccepted.length} finding(s) accepted without the complete publish invariant`,
      });
    }
    validationSummary = summarizeValidation(validatedList);
    await persist("running");

    if (input.dryRun) {
      stages.push({ name: "publish", status: "skipped", ms: 0, reason: "dry-run" });
    } else {
      const accepted = validatedList.filter(isAcceptedFinding);
      // Advisory publish boundary (default off): generation never implies
      // publication. Without the explicit publish opt-in, advisories are
      // withheld here with a count-only diagnostic; primaries publish alone.
      const advisoryPublishEnabled = input.options?.conventionAdvisoryPublishEnabled === true;
      const publishable = advisoryPublishEnabled
        ? accepted
        : accepted.filter((item) => !isConventionAdvisoryFinding(item));
      const withheld = accepted.length - publishable.length;
      if (withheld > 0) {
        deps.logger.warn("advisory publish withheld", { withheld });
      }
      // No placeholder fallback: a live publish needs explicit PR identity.
      // Demo and --no-llm never reach here (early return above); --dry-run
      // skips publish entirely.
      if (input.pr === undefined) {
        throw new ReviewerError({
          code: "CONFIG_INVALID",
          message:
            "live publish requires explicit pull-request metadata; set GITHUB_REPOSITORY, CODEBLEACH_PR_NUMBER, CODEBLEACH_BASE_SHA, and CODEBLEACH_HEAD_SHA",
        });
      }
      const meta: PrMeta = input.pr;
      // Destructive reconciliation runs only after a fully successful pass:
      // complete context, complete review, zero failed units, and zero
      // inconclusive validations (run-wide, fail-closed per ADR 0045 D10).
      const reconcileStale =
        contextStatus === "complete" &&
        reviewResult?.status === "complete" &&
        (reviewResult?.unitsFailed ?? 1) === 0 &&
        (validationSummary?.inconclusive ?? 1) === 0;
      publishResult = await runStage(
        "publish",
        // Normalize at the persist boundary: the required runFailures
        // contract (ADR 0045) holds even for out-of-tree publishers that
        // predate it. No behavior change for conforming publishers.
        async () =>
          normalizePublishResult(await deps.publisher.publish(publishable, diffResult, meta, { reconcileStale })),
        (result) => result?.published,
      );
    }

    await persist("completed");
    return { runId, status: "completed", baseSha: input.baseSha, headSha: input.headSha, configSource, stages };
  } catch (error) {
    const failure = toReviewerError(error, "pipeline");
    try {
      await persist("failed", failure);
    } catch (persistError) {
      throw persistError;
    }
    deps.logger.error("pipeline failed", { runId, code: failure.code });
    throw failure;
  }
}
