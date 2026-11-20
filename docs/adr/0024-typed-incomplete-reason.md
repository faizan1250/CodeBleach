# ADR 0024 — Typed incomplete reason for the output-cap retry

## Status

Accepted.

## Context

Responses `incomplete` outcomes carried their `incomplete_details.reason`
only inside the provider error message
(`provider response incomplete: <reason>`), and the engine decided the one
bounded `max_output_tokens` cap escalation by regexing that message for
`max_output_tokens`. A paraphrased cap reason skipped escalation while any
other incomplete whose message mentioned the token name escalated — the
contract was stringly-typed across the provider/review boundary (auditor
report cb-reliability-01).

## Decision

- `ReviewerError` gains `incompleteReason?: "max_output_tokens" |
  "content_filter" | "unknown"`, set only on `PROVIDER_FAILED` errors from a
  Responses `incomplete` status. Missing, non-string, and unrecognized
  reasons normalize to `unknown`.
- `OpenCodeProvider` parses `incomplete_details.reason` once (no message
  inference); the message keeps the redacted reason for humans only.
- The engine escalates exactly when `incompleteReason ===
  "max_output_tokens"`. Single bounded retry, `REVIEW_OUTPUT_INCOMPLETE` on
  exhaustion, `incomplete` never JSON-repaired — all unchanged.

## Consequences

- Same reason with different message text classifies identically; message
  text can no longer change classification.
- `content_filter` and `unknown` stay partial with `PROVIDER_FAILED` after a
  single attempt; cap exhaustion stays distinct as `REVIEW_OUTPUT_INCOMPLETE`.
