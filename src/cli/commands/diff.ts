import { loadConfig } from "../../config/load.ts";
import type { Logger } from "../../core/logger.ts";
import { ReviewerError } from "../../core/errors.ts";
import { GitDiffEngine } from "../../diff/git.ts";
import { exitCodeForError } from "../exit-codes.ts";

export interface DiffOptions {
  base?: string | undefined;
  head?: string | undefined;
  repo: string;
  logLevel: string;
  runId: string;
}

const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

function usageError(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
}

export async function runDiff(options: DiffOptions, logger: Logger): Promise<number> {
  if (!LOG_LEVELS.includes(options.logLevel)) {
    throw usageError(`unknown log level: ${options.logLevel}`);
  }
  const base = options.base ?? process.env["REVIEWER_BASE_SHA"];
  const head = options.head ?? process.env["REVIEWER_HEAD_SHA"];
  if (base === undefined || head === undefined) {
    throw usageError("diff requires --base and --head (or REVIEWER_BASE_SHA / REVIEWER_HEAD_SHA)");
  }

  try {
    const loaded = await loadConfig(options.repo);
    if (!loaded.ok) throw loaded.error;
    const engine = new GitDiffEngine({ logger });
    const result = await engine.run({
      repoDir: options.repo,
      baseSha: base,
      headSha: head,
      config: loaded.value.config,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof ReviewerError) {
      console.error(`diff failed [${error.code}]: ${error.message}`);
    } else {
      console.error(`diff failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return exitCodeForError(error);
  }
}
