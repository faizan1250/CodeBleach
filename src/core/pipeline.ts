import { randomUUID } from "node:crypto";
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
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const stages: StageResult[] = [];

  let configSource: ConfigSource = "unavailable";
  let config: ResolvedConfig | undefined;
  let diff: DiffResult | undefined;
  let units: ReviewUnit[] = [];
  let findings: Finding[] = [];
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
      findings,
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
    const load = deps.loadConfig ?? defaultLoadConfig;
    const loaded = await load(input.repoDir);
    if (!loaded.ok) {
      await persist("failed", loaded.error);
      throw loaded.error;
    }
    config = loaded.value.config;
    configSource = loaded.value.source;
    const resolved = config;

    const diffResult = await runStage(
      "diff",
      () => deps.diff.run({ repoDir: input.repoDir, baseSha: input.baseSha, headSha: input.headSha, config: resolved }),
      (result) => result.files.length,
    );
    diff = diffResult;
    await persist("running");

    const unitList = await runStage(
      "context",
      () => deps.context.build(diffResult, resolved, input.repoDir),
      (result) => result.length,
    );
    units = unitList;
    await persist("running");

    findings = await runStage(
      "review",
      () => deps.review.review(unitList, resolved),
      (result) => result.length,
    );
    await persist("running");

    const validatedList = await runStage(
      "validation",
      () => deps.validation.validate(findings, diffResult, unitList, resolved),
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
