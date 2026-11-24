import { ReviewerError } from "../core/errors.ts";
import type { PrMeta } from "../types/github.ts";

// PR identity seam for Phase 7 (ADR 0045 D14). Pure env parsing: no Octokit,
// no network, no logging. Action provides all four values; local smoke tests
// set the same env vars. Absent entirely means no live publish was requested
// (demo/--no-llm/--dry-run stay offline). Any partial or malformed set fails
// closed with CONFIG_INVALID before model work.

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function configInvalid(message: string): ReviewerError {
  return new ReviewerError({ code: "CONFIG_INVALID", message });
}

/** Resolve validated PrMeta from Action env, or null when none was provided. */
export function resolvePrMetaFromEnv(env: Record<string, string | undefined>): PrMeta | null {
  const repository = env["GITHUB_REPOSITORY"]?.trim();
  const numberRaw = env["CODEBLEACH_PR_NUMBER"]?.trim();
  const baseSha = env["CODEBLEACH_BASE_SHA"]?.trim();
  const headSha = env["CODEBLEACH_HEAD_SHA"]?.trim();
  const present = [repository, numberRaw, baseSha, headSha].filter((value) => value !== undefined && value.length > 0);
  if (present.length === 0) return null;
  if (
    repository === undefined ||
    repository.length === 0 ||
    numberRaw === undefined ||
    numberRaw.length === 0 ||
    baseSha === undefined ||
    baseSha.length === 0 ||
    headSha === undefined ||
    headSha.length === 0
  ) {
    throw configInvalid(
      "incomplete pull-request metadata: set GITHUB_REPOSITORY, CODEBLEACH_PR_NUMBER, CODEBLEACH_BASE_SHA, and CODEBLEACH_HEAD_SHA together for live publish",
    );
  }
  const parts = repository.split("/");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw configInvalid("GITHUB_REPOSITORY must have the form owner/repo");
  }
  const owner = parts[0].trim();
  const repo = parts[1].trim();
  if (owner.length === 0 || repo.length === 0) {
    throw configInvalid("GITHUB_REPOSITORY must have the form owner/repo");
  }
  if (!/^[0-9]+$/.test(numberRaw)) {
    throw configInvalid("CODEBLEACH_PR_NUMBER must be a positive integer");
  }
  const number = Number(numberRaw);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw configInvalid("CODEBLEACH_PR_NUMBER must be a positive integer");
  }
  if (!SHA_PATTERN.test(baseSha)) {
    throw configInvalid("CODEBLEACH_BASE_SHA must be a full 40-character lowercase hex commit SHA");
  }
  if (!SHA_PATTERN.test(headSha)) {
    throw configInvalid("CODEBLEACH_HEAD_SHA must be a full 40-character lowercase hex commit SHA");
  }
  return { owner, repo, number, baseSha, headSha };
}

/** The requested PR snapshot must describe the same diff under review. */
export function assertPrMetaMatchesDiff(pr: PrMeta, baseSha: string, headSha: string): void {
  if (pr.baseSha !== baseSha || pr.headSha !== headSha) {
    throw configInvalid(
      "pull-request metadata SHAs do not match the requested --base/--head; pass the exact PR base and head SHAs",
    );
  }
}
