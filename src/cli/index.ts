import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { runConfigPrint, runConfigValidate } from "./commands/config.ts";
import { runDiff } from "./commands/diff.ts";
import { exitCodeForError } from "./exit-codes.ts";
import { runReview } from "./commands/review.ts";
import { runVersion } from "./commands/version.ts";
import { ReviewerError } from "../core/errors.ts";
import { createLogger, type LogLevel } from "../core/logger.ts";
import { collectLlmSecrets } from "../llm/training-gate.ts";

const USAGE = `codebleach - personal AI PR reviewer

usage:
  codebleach review --base <sha> --head <sha> [--repo .] [--out .reviewer-out] [--dry-run] [--no-llm] [--log-level info]
  codebleach review --demo --dry-run
  codebleach diff --base <sha> --head <sha> [--repo .] [--log-level info]
  codebleach config validate [--repo .]
  codebleach config print [--repo .]
  codebleach version

live review sends repo code to Muse Spark 1.3 Contributor (not zero-data-retention)
and needs OPENCODE_API_KEY + CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING=true.
--dry-run alone still calls the model; add --no-llm for a network-free preview.

env fallbacks: REVIEWER_BASE_SHA, REVIEWER_HEAD_SHA, REVIEWER_LOG_LEVEL`;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(value: string | undefined, fallback: string | undefined): LogLevel {
  const level = value ?? fallback ?? "info";
  if ((LOG_LEVELS as readonly string[]).includes(level)) return level as LogLevel;
  throw new ReviewerError({ code: "CONFIG_INVALID", message: `unknown log level: ${level}` });
}

async function runReviewCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      repo: { type: "string", default: "." },
      out: { type: "string", default: ".reviewer-out" },
      "dry-run": { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      "no-llm": { type: "boolean", default: false },
      "log-level": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (parsed.values["help"] === true) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.positionals.length > 0) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: `unexpected argument: ${parsed.positionals.join(" ")}`,
    });
  }
  const level = isLogLevel(parsed.values["log-level"], process.env["REVIEWER_LOG_LEVEL"]);
  const runId = randomUUID();
  const secrets = collectLlmSecrets(process.env);
  const logger = createLogger({ level, runId, secrets });
  return runReview(
    {
      base: parsed.values["base"],
      head: parsed.values["head"],
      repo: parsed.values["repo"] ?? ".",
      out: parsed.values["out"] ?? ".reviewer-out",
      dryRun: parsed.values["dry-run"] ?? false,
      demo: parsed.values["demo"] ?? false,
      noLlm: parsed.values["no-llm"] ?? false,
      logLevel: level,
      runId,
      secrets,
    },
    logger,
  );
}

async function runDiffCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      repo: { type: "string", default: "." },
      "log-level": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (parsed.values["help"] === true) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.positionals.length > 0) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: `unexpected argument: ${parsed.positionals.join(" ")}`,
    });
  }
  const level = isLogLevel(parsed.values["log-level"], process.env["REVIEWER_LOG_LEVEL"]);
  const runId = randomUUID();
  const logger = createLogger({ level, runId });
  return runDiff(
    {
      base: parsed.values["base"],
      head: parsed.values["head"],
      repo: parsed.values["repo"] ?? ".",
      logLevel: level,
      runId,
    },
    logger,
  );
}

async function runConfigCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "." },
      help: { type: "boolean", default: false },
    },
  });
  if (parsed.values["help"] === true) {
    console.log(USAGE);
    return 0;
  }
  const [subcommand, ...rest] = parsed.positionals;
  if ((subcommand !== "validate" && subcommand !== "print") || rest.length > 0) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "usage: codebleach config <validate|print> [--repo .]",
    });
  }
  const logger = createLogger({ level: "info", runId: randomUUID() });
  const repo = parsed.values["repo"] ?? ".";
  return subcommand === "validate"
    ? runConfigValidate(repo, logger)
    : runConfigPrint(repo, logger);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === undefined || command === "--help" || command === "-h") {
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (command === "version") {
      if (rest.length > 0) {
        throw new ReviewerError({ code: "CONFIG_INVALID", message: "version takes no arguments" });
      }
      return await runVersion();
    }
    if (command === "config") return await runConfigCommand(rest);
    if (command === "review") return await runReviewCommand(rest);
    if (command === "diff") return await runDiffCommand(rest);
    throw new ReviewerError({ code: "CONFIG_INVALID", message: `unknown command: ${command}` });
  } catch (error) {
    if (error instanceof ReviewerError) {
      console.error(`error [${error.code}]: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    console.error(USAGE);
    return exitCodeForError(error);
  }
}

process.exitCode = await main();
