import { describe, expect, test } from "bun:test";
import { drainUnitPool, type UnitPoolHooks } from "../../src/review/pool.ts";
import type { StopReason } from "../../src/review/stage.ts";

function hooks<T>(overrides: Partial<UnitPoolHooks<T>> = {}): UnitPoolHooks<T> {
  return {
    runUnit: () => Promise.resolve(undefined as T),
    failUnit: () => undefined as T,
    isPolicyFatal: () => false,
    abortStage: () => {},
    ...overrides,
  };
}

describe("drainUnitPool", () => {
  test("runs every index once in claim order", async () => {
    const seen: number[] = [];
    const { slots, fatal } = await drainUnitPool<number>({
      count: 5,
      limit: 2,
      stopped: () => null,
      hooks: hooks<number>({
        runUnit: (index) => {
          seen.push(index);
          return Promise.resolve(index * 10);
        },
      }),
    });
    expect(fatal).toBeUndefined();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(slots).toEqual([0, 10, 20, 30, 40]);
  });

  test("caps concurrent workers at the limit", async () => {
    let inflight = 0;
    let peak = 0;
    const { fatal } = await drainUnitPool<number>({
      count: 6,
      limit: 2,
      stopped: () => null,
      hooks: hooks<number>({
        runUnit: async (index) => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          inflight -= 1;
          return index;
        },
      }),
    });
    expect(fatal).toBeUndefined();
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("first fatal wins with identity; late outcomes discarded, queued never start", async () => {
    const first = new Error("first fatal");
    const started: number[] = [];
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const pending = drainUnitPool<string>({
      count: 4,
      limit: 2,
      stopped: () => null,
      hooks: hooks<string>({
        runUnit: (index, gate) => {
          started.push(index);
          if (index === 0) return Promise.reject(first);
          if (index === 1) {
            return secondGate.then(() => {
              gate.throwIfFatal();
              return "late";
            });
          }
          return Promise.resolve("never");
        },
        isPolicyFatal: () => true,
        failUnit: () => "failed",
      }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);
    releaseSecond();
    const { slots, fatal } = await pending;
    expect(fatal).toBe(first);
    expect(slots[1]).toBeUndefined();
    expect(started).toEqual([0, 1]);
  });

  test("policy fatal while externally stopped records a failure instead of aborting", async () => {
    const fatal = new Error("policy break");
    const aborted: unknown[] = [];
    let stop: StopReason = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = drainUnitPool<string>({
      count: 1,
      limit: 1,
      stopped: () => stop,
      hooks: hooks<string>({
        runUnit: () => gate.then(() => Promise.reject(fatal)),
        isPolicyFatal: () => true,
        failUnit: (_index, error, atStop) => `${String(error)}@${String(atStop)}`,
        abortStage: (error) => {
          aborted.push(error);
        },
      }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    stop = "deadline";
    release();
    const { slots, fatal: result } = await pending;
    expect(result).toBeUndefined();
    expect(aborted).toHaveLength(0);
    expect(slots).toEqual([`Error: policy break@deadline`]);
  });

  test("non-fatal errors stay partial without aborting the stage", async () => {
    const aborted: unknown[] = [];
    const boom = new Error("unit blew up");
    const { slots, fatal } = await drainUnitPool<string>({
      count: 2,
      limit: 2,
      stopped: () => null,
      hooks: hooks<string>({
        runUnit: (index) => (index === 0 ? Promise.reject(boom) : Promise.resolve("ok")),
        failUnit: (_index, error) => `partial:${String(error)}`,
        abortStage: (error) => {
          aborted.push(error);
        },
      }),
    });
    expect(fatal).toBeUndefined();
    expect(aborted).toHaveLength(0);
    expect(slots).toEqual(["partial:Error: unit blew up", "ok"]);
  });

  test("zero units drains without work", async () => {
    const { slots, fatal } = await drainUnitPool<number>({
      count: 0,
      limit: 3,
      stopped: () => null,
      hooks: hooks<number>(),
    });
    expect(fatal).toBeUndefined();
    expect(slots).toHaveLength(0);
  });
});
