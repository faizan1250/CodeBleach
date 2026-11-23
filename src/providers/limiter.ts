import { ReviewerError } from "../core/errors.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.ts";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

function queueAborted(signal: AbortSignal | undefined): ReviewerError {
  return new ReviewerError({
    code: "PROVIDER_FAILED",
    // Static text only: signal.reason is caller-controlled and must never
    // leak into a message that diagnostics may carry.
    message: "request aborted while waiting for a provider slot",
    cause: signal?.reason,
  });
}

/**
 * Run-scoped bound on concurrent provider calls. One instance is created per
 * live run and shared by the primary and advisory providers, so their
 * combined in-flight complete() calls never exceed max_concurrent_requests.
 * The decorator holds a permit for the whole inner complete() call, which
 * covers transport retries and JSON-repair follow-ups: both funnel through
 * the wrapped complete(). No global state: every run mints its own limiter.
 */
export class RunConcurrencyLimiter {
  readonly limit: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(maxConcurrent: number) {
    const floored = Number.isFinite(maxConcurrent) ? Math.floor(maxConcurrent) : Number.NaN;
    this.limit = Number.isNaN(floored) ? 1 : Math.max(1, floored);
  }

  /** Wrap a provider so every complete() holds one permit, released in finally. */
  wrap(inner: LlmProvider): LlmProvider {
    return new ConcurrencyLimitedProvider(inner, this);
  }

  /**
   * Take one permit. A pre-aborted signal rejects without touching state;
   * a mid-wait abort removes the waiter and rejects, so the permit is never
   * handed to a cancelled waiter. The returned release is idempotent.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw queueAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseOnce();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.remove(waiter);
          reject(queueAborted(signal));
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    // Transfer the permit to the next live waiter; skip aborted ones so a
    // release never strands a permit on a cancelled waiter.
    for (;;) {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.active -= 1;
        return;
      }
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted === true) {
        next.reject(queueAborted(next.signal));
        continue;
      }
      next.resolve(this.releaseOnce());
      return;
    }
  }

  private remove(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
  }
}

/**
 * LlmProvider decorator enforcing a RunConcurrencyLimiter at the
 * provider-call boundary. Transparent otherwise: sessions, retry policies,
 * and response shapes are the inner provider's, so primary keeps its
 * retries/JSON-repair/cap-escalation and advisory keeps zero retries.
 */
class ConcurrencyLimitedProvider implements LlmProvider {
  readonly name: string;
  readonly capabilities: { structuredOutput: boolean; streaming: boolean };
  private readonly inner: LlmProvider;
  private readonly limiter: RunConcurrencyLimiter;

  constructor(inner: LlmProvider, limiter: RunConcurrencyLimiter) {
    this.inner = inner;
    this.limiter = limiter;
    this.name = inner.name;
    this.capabilities = inner.capabilities;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const release = await this.limiter.acquire(signal);
    try {
      return await this.inner.complete(request, signal);
    } finally {
      release();
    }
  }
}
