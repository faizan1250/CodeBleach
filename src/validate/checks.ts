import type { CheckResult, ValidationCheckCode, ValidationCheckOutcome } from "../types/validation.ts";

/** Maximum check detail length (P5-08): bounded, never source text or secrets. */
export const MAX_CHECK_DETAIL_CHARS = 300;

/** Detail shown when a later check is unreachable after a recorded failure. */
export const SKIPPED_DETAIL = "skipped: prerequisite check failed";

/**
 * Single construction site for checks: truncates detail to the bound so no
 * check can smuggle source excerpts, secrets, or large errors into artifacts.
 */
export function makeCheck(
  name: string,
  outcome: ValidationCheckOutcome,
  code: ValidationCheckCode,
  detail?: string | undefined,
): CheckResult {
  if (detail === undefined) return { name, outcome, code };
  const bounded = detail.length > MAX_CHECK_DETAIL_CHARS ? `${detail.slice(0, MAX_CHECK_DETAIL_CHARS - 1)}…` : detail;
  return { name, outcome, code, detail: bounded };
}
