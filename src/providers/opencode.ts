import {
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  MAX_LLM_MAX_RETRIES,
} from "../config/defaults.ts";
import { ReviewerError } from "../core/errors.ts";
import {
  API_KEY_ENV,
  OPENCODE_RESPONSES_ENDPOINT,
  resolveModelId,
} from "../llm/constants.ts";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MODEL_CONTEXT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  resolveCatalogLimits,
} from "../llm/limits.ts";
import { requireTrainingOptIn } from "../llm/training-gate.ts";
import { estimateTokens } from "../utils/tokens.ts";
import { redact } from "../utils/redact.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.ts";

// Single fixed target (ADR 0015/0016): no endpoint/model/API-family fallback.
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
const MAX_RETRY_AFTER_MS = 30_000;
const ERROR_SNIPPET_CHARS = 500;

export interface OpenCodeProviderOptions {
  apiKey?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  sessionId?: string | undefined;
  /** CodeBleach version for `User-Agent: codebleach/<version>`; P4-09 wires readVersion(). */
  version?: string | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /**
   * Already-fetched, verified catalog limit metadata for the fixed model.
   * Validated by resolveCatalogLimits; valid values can only tighten the local
   * hard ceilings, never widen them. Absent (the current state: P4-00 verified
   * base_url only) means local hard limits govern.
   */
  modelLimits?: unknown | undefined;
}

function mintSessionId(): string {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function backoffMs(retryIndex: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retryIndex) * Math.random();
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number.parseInt(trimmed, 10) * 1000);
  }
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
  }
  return undefined;
}

// Default backoff sleep: resolves after ms, rejects promptly on abort with the
// timer cleared and the listener removed. Never outlives the backoff window.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(onTimeout, ms);
    function onTimeout(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

type AttemptOutcome =
  | { kind: "ok"; response: LlmResponse }
  | { kind: "error"; error: ReviewerError; waitMs: number };

/** Fixed-model Responses adapter; transport only, no prompt or review logic. */
export class OpenCodeProvider implements LlmProvider {
  readonly name = "opencode-go";
  readonly capabilities = { structuredOutput: false, streaming: false };

  private readonly env: Record<string, string | undefined>;
  private readonly apiKey: string | undefined;
  private readonly sessionId: string;
  private readonly version: string;
  private readonly maxRetries: number;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly outputCeiling: number;
  private readonly contextCeiling: number;

  constructor(options: OpenCodeProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.apiKey = options.apiKey ?? this.env[API_KEY_ENV];
    const sessionId = options.sessionId ?? mintSessionId();
    this.sessionId = sessionId.length > 0 ? sessionId : mintSessionId();
    this.version = options.version ?? "0.0.0";
    this.maxRetries =
      options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
        ? DEFAULT_LLM_MAX_RETRIES
        : Math.min(MAX_LLM_MAX_RETRIES, Math.max(0, Math.floor(options.maxRetries)));
    this.outputCeiling = MODEL_MAX_OUTPUT_TOKENS;
    this.contextCeiling = MODEL_CONTEXT_TOKENS;
    // No catalog fetch exists at runtime; this validates caller-supplied
    // metadata only. Malformed metadata fails closed, never silently ignored.
    if (options.modelLimits !== undefined) {
      const resolved = resolveCatalogLimits(options.modelLimits);
      if (!resolved.ok) {
        throw new ReviewerError({
          code: "CONFIG_INVALID",
          message: `invalid modelLimits: ${resolved.reason}`,
        });
      }
      this.outputCeiling = Math.min(this.outputCeiling, resolved.limits.maxOutputTokens);
      this.contextCeiling = Math.min(this.contextCeiling, resolved.limits.contextTokens);
    }
    this.defaultTimeoutMs =
      options.timeoutMs === undefined || !Number.isFinite(options.timeoutMs)
        ? DEFAULT_LLM_REQUEST_TIMEOUT_MS
        : options.timeoutMs;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleep ?? abortableSleep;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    requireTrainingOptIn(this.env);
    const modelId = resolveModelId(request.model);
    const key = this.apiKey;
    if (key === undefined || key.length === 0) {
      throw new ReviewerError({
        code: "CONFIG_INVALID",
        message: `${API_KEY_ENV} is required for live review`,
      });
    }
    if (signal?.aborted === true) {
      throw new ReviewerError({
        code: "PROVIDER_FAILED",
        message: `request aborted before send: ${redact(String(signal.reason ?? "aborted"), [key])}`,
      });
    }
    const requestedTimeout = request.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(1, requestedTimeout)
      : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
    // Pre-request ceilings: reject impossible requests before any network
    // touch. Output counts against the context window, so both bounds apply.
    const requestedMax = request.maxTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS;
    if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
      throw new ReviewerError({
        code: "CONFIG_INVALID",
        message: `invalid maxTokens ${String(request.maxTokens)}: must be a positive integer`,
      });
    }
    if (requestedMax > this.outputCeiling) {
      throw new ReviewerError({
        code: "CONFIG_INVALID",
        message: `maxTokens ${requestedMax} exceeds the output ceiling ${this.outputCeiling}`,
      });
    }
    const estimatedInput = estimateTokens(`${request.system}\n${request.user}`);
    if (estimatedInput + requestedMax + CONTEXT_SAFETY_MARGIN_TOKENS > this.contextCeiling) {
      throw new ReviewerError({
        code: "CONFIG_INVALID",
        message:
          `request does not fit the ${this.contextCeiling}-token context ceiling: ` +
          `estimated input ${estimatedInput} + reserved output ${requestedMax} + margin ${CONTEXT_SAFETY_MARGIN_TOKENS} exceeds it`,
      });
    }
    const maxTokens = requestedMax;
    // Pre-send redaction: secrets in source context become [REDACTED], never sent.
    // temperature/jsonSchema omitted: unverified against this endpoint, never guessed.
    const body = JSON.stringify({
      model: modelId,
      instructions: redact(request.system, [key]),
      input: redact(request.user, [key]),
      max_output_tokens: maxTokens,
    });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": `codebleach/${this.version}`,
      "x-opencode-session": this.sessionId,
    };

    const abortError = (): ReviewerError =>
      new ReviewerError({
        code: "PROVIDER_FAILED",
        message: `request aborted: ${redact(String(signal?.reason ?? "aborted"), [key])}`,
      });

    let waitMs = 0;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw abortError();
      if (attempt > 0) {
        try {
          await this.sleepFn(waitMs, signal);
        } catch (error) {
          // Abort during backoff rejects promptly; a non-abort sleep failure propagates unchanged.
          if (signal?.aborted) throw abortError();
          throw error;
        }
        // Cancel landing in the backoff window must not fire another POST.
        if (signal?.aborted) throw abortError();
      }
      const outcome = await this.attempt(body, headers, signal, timeoutMs, attempt, modelId, key);
      if (outcome.kind === "ok") return { ...outcome.response, retries: attempt };
      if (!outcome.error.retryable || attempt >= this.maxRetries) throw outcome.error;
      waitMs = outcome.waitMs;
    }
  }

  private async attempt(
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    attempt: number,
    modelId: string,
    key: string,
  ): Promise<AttemptOutcome> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(OPENCODE_RESPONSES_ENDPOINT, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      return await this.readResponse(res, attempt, modelId, key);
    } catch (error) {
      if (error instanceof ReviewerError) {
        return { kind: "error", error, waitMs: backoffMs(attempt) };
      }
      if (signal?.aborted === true) {
        return {
          kind: "error",
          error: new ReviewerError({
            code: "PROVIDER_FAILED",
            message: `request aborted: ${redact(String(signal.reason ?? "aborted"), [key])}`,
          }),
          waitMs: 0,
        };
      }
      const timedOut = controller.signal.aborted;
      return {
        kind: "error",
        error: new ReviewerError({
          code: "PROVIDER_FAILED",
          message: timedOut
            ? `request timed out after ${timeoutMs}ms`
            : `request failed: ${redact(error instanceof Error ? error.message : String(error), [key]).slice(0, ERROR_SNIPPET_CHARS)}`,
          retryable: true,
          retries: attempt,
        }),
        waitMs: backoffMs(attempt),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readResponse(
    res: Response,
    attempt: number,
    modelId: string,
    key: string,
  ): Promise<AttemptOutcome> {
    const fail = (message: string, retryable: boolean, waitMs: number): AttemptOutcome => ({
      kind: "error",
      error: new ReviewerError({
        code: "PROVIDER_FAILED",
        message,
        retryable,
        ...(retryable ? { retries: attempt } : {}),
      }),
      waitMs,
    });
    if (!res.ok) {
      // Best-effort detail: an unreadable body still yields a classified HTTP error.
      const snippet = await res
        .text()
        .then((bodyText) => redact(bodyText, [key]).slice(0, ERROR_SNIPPET_CHARS), () => "");
      const suffix = snippet.length > 0 ? `: ${snippet}` : "";
      switch (res.status) {
        case 408:
          return fail(`request timed out by provider (HTTP 408)${suffix}`, true, backoffMs(attempt));
        case 429: {
          const waitMs = parseRetryAfterMs(res.headers.get("Retry-After")) ?? backoffMs(attempt);
          return fail(`rate limited by provider (HTTP 429)${suffix}`, true, waitMs);
        }
        case 400:
          return fail(`provider rejected request (HTTP 400)${suffix}`, false, 0);
        case 401:
        case 403:
          return fail(
            `provider denied access (HTTP ${res.status}): check ${API_KEY_ENV}, workspace entitlement, and the training-data workspace setting${suffix}`,
            false,
            0,
          );
        case 404:
          return fail(
            `provider endpoint or model not found (HTTP 404): pinned ${OPENCODE_RESPONSES_ENDPOINT} / ${modelId}${suffix}`,
            false,
            0,
          );
        default:
          if (res.status >= 500) {
            return fail(`provider unavailable (HTTP ${res.status})${suffix}`, true, backoffMs(attempt));
          }
          return fail(`provider request failed (HTTP ${res.status})${suffix}`, false, 0);
      }
    }
    let envelope: unknown;
    try {
      envelope = (await res.json()) as unknown;
    } catch {
      return {
        kind: "error",
        error: new ReviewerError({
          code: "PROVIDER_BAD_OUTPUT",
          message: "provider returned malformed JSON",
        }),
        waitMs: 0,
      };
    }
    if (!isRecord(envelope)) {
      return {
        kind: "error",
        error: new ReviewerError({
          code: "PROVIDER_BAD_OUTPUT",
          message: "provider returned a malformed success body",
        }),
        waitMs: 0,
      };
    }
    const status = asNonEmptyString(envelope["status"]);
    if (status === "incomplete") {
      // Distinct from parse failure: truncated output is never JSON-repaired (P4-05 owns escalation).
      const reason = isRecord(envelope["incomplete_details"])
        ? asNonEmptyString(envelope["incomplete_details"]["reason"])
        : undefined;
      return fail(
        `provider response incomplete${reason !== undefined ? `: ${redact(reason, [key])}` : ""}`,
        false,
        0,
      );
    }
    if (status === "failed") {
      const detail = isRecord(envelope["error"])
        ? asNonEmptyString(envelope["error"]["message"])
        : undefined;
      return fail(
        `provider reported failure${detail !== undefined ? `: ${redact(detail, [key]).slice(0, ERROR_SNIPPET_CHARS)}` : ""}`,
        false,
        0,
      );
    }
    const refusal = findRefusal(envelope["output"]);
    if (refusal !== undefined) {
      return fail(
        `provider refused the request${refusal.length > 0 ? `: ${redact(refusal, [key]).slice(0, ERROR_SNIPPET_CHARS)}` : ""}`,
        false,
        0,
      );
    }
    const text = extractText(envelope);
    if (text === undefined) {
      return {
        kind: "error",
        error: new ReviewerError({
          code: "PROVIDER_BAD_OUTPUT",
          message: "provider returned no extractable text",
        }),
        waitMs: 0,
      };
    }
    const usage = extractUsage(envelope["usage"]);
    const costUsd = extractCost(envelope["usage"]);
    return {
      kind: "ok",
      response: {
        text,
        ...(usage === undefined ? {} : { usage }),
        ...(costUsd === undefined ? {} : { costUsd }),
        model: asNonEmptyString(envelope["model"]) ?? modelId,
        raw: minimalRaw(envelope),
      },
    };
  }
}

function findRefusal(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item["content"])) continue;
    for (const part of item["content"] as unknown[]) {
      if (!isRecord(part)) continue;
      if (part["type"] === "refusal") return asNonEmptyString(part["refusal"]) ?? "";
    }
  }
  return undefined;
}

// Prefers the aggregated field, else walks the output items in order.
function extractText(envelope: Record<string, unknown>): string | undefined {
  const direct = asNonEmptyString(envelope["output_text"]);
  if (direct !== undefined) return direct;
  const output = envelope["output"];
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item["content"])) continue;
    for (const part of item["content"] as unknown[]) {
      if (!isRecord(part) || part["type"] !== "output_text") continue;
      const text = asNonEmptyString(part["text"]);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

// Unknown when absent; never zero-filled. Reasoning stays separate from the
// output total (it is already included in output_tokens by the API).
function extractUsage(usage: unknown):
  | { inputTokens: number; outputTokens: number; reasoningTokens?: number | undefined }
  | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = asFiniteNumber(usage["input_tokens"]);
  const outputTokens = asFiniteNumber(usage["output_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = isRecord(usage["output_tokens_details"])
    ? asFiniteNumber(usage["output_tokens_details"]["reasoning_tokens"])
    : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(details === undefined ? {} : { reasoningTokens: details }),
  };
}

// Provider-reported charge only; never estimated. Unknown when absent.
function extractCost(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  return asFiniteNumber(usage["cost"]);
}

// Only diagnostic scalars; full bodies are never persisted.
function minimalRaw(envelope: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const status = asNonEmptyString(envelope["status"]);
  if (status !== undefined) raw["status"] = status;
  const id = asNonEmptyString(envelope["id"]);
  if (id !== undefined) raw["responseId"] = id;
  if (isRecord(envelope["usage"])) {
    const usage = envelope["usage"];
    if (isRecord(usage["output_tokens_details"])) {
      const reasoning = asFiniteNumber(usage["output_tokens_details"]["reasoning_tokens"]);
      if (reasoning !== undefined) raw["reasoningTokens"] = reasoning;
    }
    const cost = asFiniteNumber(usage["cost"]);
    if (cost !== undefined) raw["cost"] = cost;
    if (isRecord(usage["opencode"])) {
      const allowance = asFiniteNumber(usage["opencode"]["allowance"]);
      if (allowance !== undefined) raw["allowance"] = allowance;
      const billing = asNonEmptyString(usage["opencode"]["billing_source"]);
      if (billing !== undefined) raw["billingSource"] = billing;
    }
  }
  return raw;
}
