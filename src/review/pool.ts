import type { StopReason } from "./stage.ts";

export interface PoolUnitGate {
  throwIfFatal: () => void;
}

export interface UnitPoolHooks<T> {
  runUnit: (index: number, gate: PoolUnitGate) => Promise<T>;
  failUnit: (index: number, error: unknown, stop: StopReason) => T;
  isPolicyFatal: (error: unknown) => boolean;
  abortStage: (error: unknown) => void;
}

export interface UnitPoolResult<T> {
  slots: (T | undefined)[];
  fatal: unknown;
}

// Bounded fan-out with first-fatal-wins. Indexes are claimed in order by at
// most `limit` workers; queued indexes never start after a stop, in-flight
// outcomes landing after a fatal are discarded, and unclaimed slots stay
// undefined for the caller to fill. Never throws: the stored fatal is
// returned for the caller to rethrow after the allSettled drain, so no
// provider call outlives the rejection.
export async function drainUnitPool<T>(input: {
  count: number;
  limit: number;
  stopped: () => StopReason;
  hooks: UnitPoolHooks<T>;
}): Promise<UnitPoolResult<T>> {
  const { count, hooks, stopped } = input;
  const limit = Math.max(1, input.limit);
  const slots: (T | undefined)[] = new Array(count);
  let next = 0;
  // First fatal wins: recorded once, then the stage aborts so in-flight
  // provider calls cancel and queued units never start. The caller's signal
  // is never touched.
  let fatal: unknown;
  const hasFatal = (): boolean => fatal !== undefined;
  const gate: PoolUnitGate = {
    throwIfFatal: (): void => {
      if (fatal !== undefined) throw fatal;
    },
  };
  const failFast = (error: unknown): void => {
    if (fatal !== undefined) return;
    fatal = error;
    hooks.abortStage(error);
  };
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    for (;;) {
      if (hasFatal() || stopped() !== null) return;
      const index = next;
      next += 1;
      if (index >= count) return;
      // A fatal landing between claim and start leaves the slot empty; the
      // post-drain rethrow discards all partial worker state.
      if (hasFatal()) return;
      try {
        const outcome = await hooks.runUnit(index, gate);
        // A sibling's fatal discards even a successful late outcome.
        if (hasFatal()) return;
        slots[index] = outcome;
      } catch (error) {
        // Policy errors abort the whole run; per-unit failures stay partial.
        if (hooks.isPolicyFatal(error)) {
          // A run already stopped by caller/deadline keeps its stop outcome;
          // only the first live fatal aborts the stage.
          if (!hasFatal() && stopped() === null) failFast(error);
          else if (!hasFatal()) slots[index] = hooks.failUnit(index, error, stopped());
          return;
        }
        if (hasFatal()) return;
        slots[index] = hooks.failUnit(index, error, stopped());
      }
    }
  });
  await Promise.allSettled(workers);
  return { slots, fatal };
}
