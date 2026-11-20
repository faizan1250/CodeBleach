import { API_KEY_ENV, TRAINING_OPT_IN_ENV } from "./constants.ts";
import { ReviewerError } from "../core/errors.ts";

// Exact match only: "1"/"True"/missing must not pass as consent.
export function isTrainingOptIn(env: Record<string, string | undefined> = {}): boolean {
  return env[TRAINING_OPT_IN_ENV] === "true";
}

// Gate every source-bearing (and every live smoke) request before network access.
export function requireTrainingOptIn(env: Record<string, string | undefined> = {}): void {
  if (isTrainingOptIn(env)) return;
  throw new ReviewerError({
    code: "CONFIG_INVALID",
    message: `${TRAINING_OPT_IN_ENV}=true is required before any model request (Not-ZDR: prompts/completions may train future models)`,
  });
}

// Exact key bytes for logger/artifact redaction; the value itself is never logged.
export function collectLlmSecrets(env: Record<string, string | undefined> = {}): string[] {
  const key = env[API_KEY_ENV];
  return key === undefined || key.length === 0 ? [] : [key];
}
