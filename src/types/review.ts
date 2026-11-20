import type { Finding } from "./finding.ts";

// P4-07: structured review outcome. The engine still returns no partial
// Finding arrays; status/usage/diagnostics travel with the findings so a
// failed unit can never silently erase successful ones.
export type ReviewStatus = "complete" | "partial" | "failed" | "skipped";

export interface ReviewUsage {
  /** Total LlmProvider.complete() calls: initial + repair + cap-escalation. */
  requests: number;
  /** Provider-internal transport retries (0 until the provider reports them; P4-08). */
  retries: number;
  /** JSON-repair follow-up requests issued through completeJson. */
  repairRequests: number;
  /** Bounded max_output_tokens cap-escalation requests. */
  incompleteRetries: number;
  /** Summed only from responses that reported usage; undefined when none did. */
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  /** inputTokens + outputTokens when both are known; never a fabricated zero. */
  totalTokens?: number | undefined;
  /** Summed provider-reported charges; present only when costKnown. */
  costUsd?: number | undefined;
  costKnown: boolean;
}

export type ReviewDiagnosticStage = "provider" | "prompt" | "parse" | "normalize" | "unit";

export interface ReviewDiagnostic {
  stage: ReviewDiagnosticStage;
  code: string;
  /** Static or redacted text only; never model output, prompts, or secrets. */
  message: string;
  unitId?: string | undefined;
  retryable: boolean;
}

export interface ReviewBuildResult {
  status: ReviewStatus;
  findings: Finding[];
  /** Bounded (see MAX_REVIEW_DIAGNOSTICS) and redacted before persistence. */
  diagnostics: ReviewDiagnostic[];
  usage: ReviewUsage;
  unitsSubmitted: number;
  unitsReviewed: number;
  unitsFailed: number;
  promptVersion: string;
  promptHash: string;
  model: string;
}
