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
import type { Logger } from "../../core/logger.ts";
import { runPipeline } from "../../core/pipeline.ts";
import {
  stubContextEngine,
  stubDiffEngine,
  stubPublisher,
  stubReviewEngine,
  stubValidationEngine,
} from "../../core/stubs.ts";

export interface ReviewOptions {
  base?: string | undefined;
  head?: string | undefined;
  repo: string;
  out: string;
  dryRun: boolean;
  demo: boolean;
  logLevel: string;
}

const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

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

  const engines = options.demo
    ? {
        diff: demoDiffEngine,
        context: demoContextEngine,
        review: demoReviewEngine,
        validation: demoValidationEngine,
        publisher: demoPublisher,
      }
    : {
        diff: stubDiffEngine,
        context: stubContextEngine,
        review: stubReviewEngine,
        validation: stubValidationEngine,
        publisher: stubPublisher,
      };

  try {
    const summary = await runPipeline(
      { ...engines, logger },
      {
        repoDir: options.repo,
        baseSha: base,
        headSha: head,
        dryRun: options.dryRun,
        outDir: options.out,
      },
    );
    console.log(
      `review ${summary.status}: ${summary.stages.length} stages, ${summary.configSource} config`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ReviewerError) {
      console.error(`review failed [${error.code}]: ${error.message}`);
      return error.code === "CONFIG_INVALID" || error.code === "CONFIG_UNSUPPORTED_VERSION" ? 2 : 1;
    }
    console.error(`review failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
