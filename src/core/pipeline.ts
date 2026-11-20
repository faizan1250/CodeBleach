import { loadConfig as defaultLoadConfig } from "../config/load.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { ReviewerError } from "./errors.ts";
import type {
  ConfigSource,
  PipelineDeps,
  PipelineInput,
  RunSummary,
  StageName,
  StageResult,
} from "./contracts.ts";
import { RUN_ARTIFACT_SCHEMA_VERSION, writeArtifact, type RunArtifact } from "./run-artifact.ts";
import type {
  DiffResult,
  Finding,
  PrMeta,
  PublishResult,
  ReviewUnit,
  ValidatedFinding,
} from "../types/index.ts";
import type { ContextBuildDiagnostics } from "../types/context.ts";
import type { ReviewBuildResult } from "../types/review.ts";

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
      () => deps.review.review(contextResult.units, resolved, { headSha: diffResult.headSha }),
      (value) => value.findings.length,
    );
    findings = result.findings;
    reviewResult = result;
    if (result.status === "skipped") {
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

    const validatedList = await runStage(
      "validation",
      () => deps.validation.validate(findings, diffResult, contextResult.units, resolved),
      (result) => result.filter((item) => item.status === "accepted").length,
    );
    validated = validatedList;
    await persist("running");

    if (input.dryRun) {
      stages.push({ name: "publish", status: "skipped", ms: 0, reason: "dry-run" });
    } else {
      const accepted = validatedList.filter((item) => item.status === "accepted");
      const meta: PrMeta = input.pr ?? {
        owner: "unknown",
        repo: "unknown",
        number: 0,
        baseSha: input.baseSha,
        headSha: input.headSha,
      };
      publishResult = await runStage(
        "publish",
        () => deps.publisher.publish(accepted, diffResult, meta),
        (result) => result.published,
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
