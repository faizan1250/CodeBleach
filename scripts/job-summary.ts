import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ErrorCode } from "../src/core/errors.ts";
import { normalizePublishResult, type LegacyPublishResult } from "../src/core/run-artifact.ts";
import type { PublishRunFailureCode } from "../src/types/publish.ts";

/**
 * Job-summary renderer for the PR review workflow (P7-06, ADR 0045 D16).
 * Reads only the redacted run.json artifact, appends a concise result to
 * $GITHUB_STEP_SUMMARY, and emits at most one ::warning::/::error:: line.
 * Only code-owned counts, a validated head SHA, and closed-union codes are
 * ever interpolated — never finding text, raw API messages, or PR strings.
 */

const RUN_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "permission_denied",
  "rate_limited",
  "github_unavailable",
  "pr_closed",
  "pr_identity_mismatch",
  "stale_base_sha",
  "stale_head_sha",
  "comment_inventory_incomplete",
  "ambiguous_post_outcome",
  "reconciliation_incomplete",
  "reconciliation_skipped_incomplete_run",
]);

const ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "CONFIG_INVALID",
  "CONFIG_UNSUPPORTED_VERSION",
  "GIT_FAILED",
  "PARSE_FAILED",
  "PROVIDER_FAILED",
  "PROVIDER_BAD_OUTPUT",
  "GITHUB_FAILED",
  "NOT_IMPLEMENTED",
  "INTERNAL",
  "INVALID_INPUT",
]);

const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "CONFIG_INVALID",
  "CONFIG_UNSUPPORTED_VERSION",
  "INVALID_INPUT",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface JobSummaryValidation {
  total: number;
  accepted: number;
  rejected: number;
  inconclusive: number;
}

export interface JobSummaryPublish {
  published: number;
  skipped: number;
  perFindingFailures: number;
}

export interface JobSummaryData {
  headShort: string;
  validation: JobSummaryValidation | null;
  publish: JobSummaryPublish | null;
  runFailureCodes: PublishRunFailureCode[];
  status: string | null;
  errorCode: ErrorCode | null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asRunFailureCode(value: unknown): PublishRunFailureCode | null {
  return typeof value === "string" && RUN_FAILURE_CODES.has(value) ? (value as PublishRunFailureCode) : null;
}

function asErrorCode(value: unknown): ErrorCode | null {
  return typeof value === "string" && ERROR_CODES.has(value) ? (value as ErrorCode) : null;
}

function asHeadShort(value: unknown): string {
  return typeof value === "string" && SHA_PATTERN.test(value) ? value.slice(0, 7) : "unknown";
}

/** Parse an untrusted run.json payload into validated summary data; null when top-level garbage. */
export function parseRunArtifact(raw: unknown): JobSummaryData | null {
  const artifact = asRecord(raw);
  if (artifact === null) return null;
  const summary = asRecord(artifact.validationSummary);
  const accepted = summary === null ? null : asCount(summary.accepted);
  const rejected = summary === null ? null : asCount(summary.rejected);
  const inconclusive = summary === null ? null : asCount(summary.inconclusive);
  const total = summary === null ? null : asCount(summary.total);
  const rawPublish = artifact.publishResult;
  const publishInput =
    rawPublish === null || rawPublish === undefined
      ? null
      : asRecord(rawPublish) === null
        ? undefined
        : (rawPublish as LegacyPublishResult);
  const normalized = publishInput === undefined ? undefined : normalizePublishResult(publishInput);
  const publishCounts =
    normalized === undefined || normalized === null
      ? null
      : {
          published: asCount(normalized.published),
          skipped: asCount(normalized.skipped),
          perFindingFailures: Array.isArray(normalized.failures) ? normalized.failures.length : 0,
        };
  const error = asRecord(artifact.error);
  const status = typeof artifact.status === "string" ? (artifact.status as string) : null;
  const validation =
    accepted === null || rejected === null || inconclusive === null || total === null
      ? null
      : { total, accepted, rejected, inconclusive };
  const publish =
    publishCounts === null || publishCounts.published === null || publishCounts.skipped === null
      ? null
      : {
          published: publishCounts.published,
          skipped: publishCounts.skipped,
          perFindingFailures: publishCounts.perFindingFailures,
        };
  const runFailureCodes =
    normalized === undefined || normalized === null || !Array.isArray(normalized.runFailures)
      ? []
      : normalized.runFailures
          .map((failure) => asRunFailureCode(asRecord(failure)?.code))
          .filter((code): code is PublishRunFailureCode => code !== null);
  return {
    headShort: asHeadShort(artifact.headSha),
    validation,
    publish,
    runFailureCodes,
    status,
    errorCode: error === null ? null : asErrorCode(error.code),
  };
}

/** Render the step-summary markdown; data null means the artifact was missing or unparsable. */
export function renderSummaryMarkdown(data: JobSummaryData | null): string {
  if (data === null) {
    return "## CodeBleach review summary\n\nSummary unavailable: run artifact missing or unparsable.";
  }
  const lines = ["## CodeBleach review summary", "", `- head: \`${data.headShort}\``];
  if (data.validation === null) {
    lines.push("- validation: did not run");
  } else {
    lines.push(
      `- validation: ${data.validation.total} finding(s): ${data.validation.accepted} accepted, ` +
        `${data.validation.rejected} rejected, ${data.validation.inconclusive} inconclusive`,
    );
  }
  if (data.publish === null) {
    lines.push("- publish: did not run");
  } else {
    const runFailures = data.runFailureCodes.length === 0 ? "none" : data.runFailureCodes.join(",");
    lines.push(
      `- publish: ${data.publish.published} published, ${data.publish.skipped} skipped, ` +
        `${data.publish.perFindingFailures} failure(s); run failures: ${runFailures}`,
    );
    if (data.publish.perFindingFailures > 0 || data.runFailureCodes.length > 0) {
      lines.push("- publishing was incomplete: see the run artifact for details.");
    }
  }
  lines.push(`- status: ${data.status ?? "unknown"}`);
  if (data.errorCode !== null) lines.push(`- error: ${data.errorCode}`);
  return lines.join("\n");
}

export type AnnotationLevel = "warning" | "error";

export interface JobAnnotation {
  level: AnnotationLevel;
  message: string;
}

/**
 * At most one annotation per run. ::error:: only for invalid configuration
 * or internal defects; every other incompleteness is a ::warning:: so an
 * expected outage never looks like a clean green run but never fails it.
 */
export function selectAnnotation(data: JobSummaryData | null): JobAnnotation | null {
  if (data === null) {
    return { level: "warning", message: "CodeBleach summary unavailable: run artifact missing or unparsable." };
  }
  if (data.errorCode !== null) {
    if (CONFIG_ERROR_CODES.has(data.errorCode)) {
      return { level: "error", message: `CodeBleach review failed: invalid configuration (${data.errorCode}).` };
    }
    if (data.errorCode === "INTERNAL") {
      return { level: "error", message: "CodeBleach review failed: internal reviewer defect." };
    }
    return { level: "warning", message: `CodeBleach run incomplete: ${data.errorCode}.` };
  }
  if (data.publish !== null && (data.publish.perFindingFailures > 0 || data.runFailureCodes.length > 0)) {
    const runFailures = data.runFailureCodes.length === 0 ? "none" : data.runFailureCodes.join(",");
    return {
      level: "warning",
      message:
        `CodeBleach publishing incomplete: ${data.publish.perFindingFailures} failure(s); ` +
        `run failures: ${runFailures}.`,
    };
  }
  return null;
}

export interface WriteJobSummaryOptions {
  artifactPath: string;
  summaryPath: string | undefined;
  log?: ((message: string) => void) | undefined;
}

/** Read, render, and emit the summary; always resolves 0 (never fails the job). */
export async function writeJobSummary(options: WriteJobSummaryOptions): Promise<number> {
  const log = options.log ?? console.log;
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(options.artifactPath, "utf8")) as unknown;
  } catch {
    raw = null;
  }
  const data = typeof raw === "object" && raw !== null ? parseRunArtifact(raw) : null;
  const markdown = renderSummaryMarkdown(data);
  if (options.summaryPath !== undefined) {
    try {
      await appendFile(options.summaryPath, `${markdown}\n`, "utf8");
    } catch {
      log(markdown); // summary file unavailable: stay visible, never fail the job
    }
  } else {
    log(markdown);
  }
  const annotation = selectAnnotation(data);
  if (annotation !== null) log(`::${annotation.level}::${annotation.message}`);
  return 0;
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        artifact: { type: "string", default: ".reviewer-out/run.json" },
        help: { type: "boolean", default: false },
      },
    });
    if (parsed.values.help === true) {
      console.log("usage: job-summary.ts [--artifact <run.json>]");
      return 0;
    }
    return writeJobSummary({
      artifactPath: parsed.values.artifact ?? ".reviewer-out/run.json",
      summaryPath: env.GITHUB_STEP_SUMMARY,
    });
  } catch {
    // Parse failure must not fail the job: fall back to the default artifact
    // (missing/unparsable renders a static warning, exit 0).
    return writeJobSummary({ artifactPath: ".reviewer-out/run.json", summaryPath: env.GITHUB_STEP_SUMMARY });
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
