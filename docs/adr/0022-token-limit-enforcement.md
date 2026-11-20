# ADR 0022 — Token-limit enforcement against local hard limits (no runtime catalog discovery)

## Status

Accepted (P4 hardening).

## Context

ADR 0016 promised P4-02 would "clamp [token ceilings] to the authenticated
model `limit.*` at runtime". P4-02 never did: the provider clamps
`maxTokens` to the static `MAX_LLM_MAX_OUTPUT_TOKENS` only, and the engine
gates prompts against the configured input budget only
(`src/review/engine.ts`). The effective ceiling
`min(config budget, limit.input/context − reserved output − margin)`
(`implementation-phase4.md`) was never implemented, and
`systemdesign.md` claimed runtime clamping no code performs.

The P4-00 catalog read (`docs/opencode-spike.md`, `scripts/opencode-spike.ts`)
verified only `api.responses.base_url` plus a generic 64-token smoke
(`incomplete: max_output_tokens`, proving reasoning consumes the output cap).
`limit.*` was never observed, and no completed response was ever verified.
The 1,048,576 context / 131,072 output sizes are third-party reports the spike
plan itself says not to use as account guarantees. Treating them as
authoritative, or adding an unauthenticated runtime catalog fetch on the
request path, would trade a documented gap for an unverified dependency.

## Decision

- Enforce conservative **local** hard limits pre-request (`src/llm/limits.ts`):
  context 1,048,576, output 131,072, input 1,000,000, margin 8,192 tokens.
  Sizes mirror third-party reports as safety bounds, never as model
  guarantees; defaults (32,768 output / 64,000 input) are unchanged.
- Output tokens count inside the context window everywhere: config load
  rejects input+output+margin combinations that cannot fit as
  `CONFIG_INVALID`; the engine skips over-budget units with
  `INPUT_BUDGET_EXCEEDED` (zero provider calls) and throws `CONFIG_INVALID`
  on impossible budgets; the provider rejects over-ceiling or
  context-exceeding requests before any network touch; cap escalation stays
  inside both the output ceiling and the remaining window.
- Validated catalog metadata can only **tighten** these bounds, never widen
  them: `resolveCatalogLimits()` strictly validates an already-fetched record
  (missing/incomplete → rejection, local limits kept), and
  `OpenCodeProvider` accepts it as an optional `modelLimits` input. No runtime
  catalog fetch exists, so local limits govern; nothing is silently truncated.
- Supersedes the ADR 0016 runtime-clamp sentence and the `systemdesign.md`
  claim (corrected in this change; ADR 0016 itself is left untouched).

## Consequences

- Requests that cannot fit are rejected or skipped with diagnostics and exact
  numbers; no silent truncation, no network on exceed.
- Raising any local ceiling requires a verified completed-response plus an
  authenticated `limit.*` read, recorded in a new ADR.
- When a verified catalog source exists, plumb it into `modelLimits` (and the
  engine pre-check); until then the option stays unset.
