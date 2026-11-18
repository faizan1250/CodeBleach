import type { loadConfig } from "../config/load.ts";
import type { Logger } from "./logger.ts";
import type {
  DiffResult,
  Finding,
  PrMeta,
  PublishResult,
  ReviewUnit,
  ValidatedFinding,
} from "../types/index.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { Result } from "./result.ts";
import type { ConfigLoadResult } from "../config/load.ts";
import type { ReviewerError } from "./errors.ts";

export interface DiffEngine {
  run(input: {
    repoDir: string;
    baseSha: string;
    headSha: string;
    config: ResolvedConfig;
  }): Promise<DiffResult>;
}

export interface ContextEngine {
  build(diff: DiffResult, config: ResolvedConfig, repoDir: string): Promise<ReviewUnit[]>;
}

export interface ReviewEngine {
  review(units: ReviewUnit[], config: ResolvedConfig): Promise<Finding[]>;
}

export interface ValidationEngine {
  validate(
    findings: Finding[],
    diff: DiffResult,
    units: ReviewUnit[],
    config: ResolvedConfig,
  ): Promise<ValidatedFinding[]>;
}

export interface Publisher {
  publish(findings: ValidatedFinding[], diff: DiffResult, meta: PrMeta): Promise<PublishResult>;
}

export type StageName = "config" | "diff" | "context" | "review" | "validation" | "publish";

export type StageStatus = "completed" | "failed" | "skipped";

export interface StageResult {
  name: StageName;
  status: StageStatus;
  ms: number;
  count?: number | undefined;
  reason?: string | undefined;
}

export type ConfigSource = "file" | "defaults" | "unavailable";

export interface RunSummary {
  runId: string;
  status: "completed" | "failed";
  baseSha: string;
  headSha: string;
  configSource: ConfigSource;
  stages: StageResult[];
}

export interface PipelineInput {
  repoDir: string;
  baseSha: string;
  headSha: string;
  pr?: PrMeta | undefined;
  dryRun: boolean;
  outDir: string;
  /** Single execution id, minted once by the CLI and shared by logger + artifact. */
  runId: string;
  secrets?: string[] | undefined;
}

export type LoadConfigFn = typeof loadConfig;

export interface PipelineDeps {
  diff: DiffEngine;
  context: ContextEngine;
  review: ReviewEngine;
  validation: ValidationEngine;
  publisher: Publisher;
  logger: Logger;
  loadConfig?: LoadConfigFn | undefined;
}

export type { ConfigLoadResult, ResolvedConfig, Result, ReviewerError };
