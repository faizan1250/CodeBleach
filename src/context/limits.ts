export interface Clock {
  now(): number;
}

const monotonicNow: Clock = {
  now: () => performance.now(),
};

export interface RunBudgetCaps {
  maxRunMs: number;
  maxTotalParseMs: number;
}

/** Monotonic overall-deadline and cumulative-parse tracker for one Context Engine run. */
export class RunBudget {
  private readonly deadline: number;
  private readonly maxTotalParseMs: number;
  private readonly clock: Clock;
  private parseConsumedMs = 0;

  constructor(caps: RunBudgetCaps, clock: Clock = monotonicNow) {
    this.maxTotalParseMs = caps.maxTotalParseMs;
    this.clock = clock;
    this.deadline = clock.now() + caps.maxRunMs;
  }

  get consumedParseMs(): number {
    return this.parseConsumedMs;
  }

  remainingRunMs(): number {
    return Math.max(0, this.deadline - this.clock.now());
  }

  recordParse(durationMs: number): void {
    this.parseConsumedMs += Math.max(0, durationMs);
  }

  canStartParse(perFileMs: number): boolean {
    return this.effectiveParseMs(perFileMs) > 0;
  }

  /** Tightest allowance across per-file, cumulative, and overall budgets. */
  effectiveParseMs(perFileMs: number): number {
    return Math.max(
      0,
      Math.min(perFileMs, this.maxTotalParseMs - this.parseConsumedMs, this.remainingRunMs()),
    );
  }
}
