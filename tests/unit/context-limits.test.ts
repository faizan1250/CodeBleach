import { describe, expect, test } from "bun:test";
import { RunBudget } from "../../src/context/limits.ts";

function fakeClock(startMs = 1000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("run budget", () => {
  test("starts with full run and parse budgets", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 }, clock);
    expect(budget.remainingRunMs()).toBe(120000);
    expect(budget.consumedParseMs).toBe(0);
    expect(budget.canStartParse(2000)).toBe(true);
  });

  test("tracks cumulative parse consumption", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 }, clock);
    budget.recordParse(2000);
    budget.recordParse(3000);
    expect(budget.consumedParseMs).toBe(5000);
    expect(budget.canStartParse(2000)).toBe(true);
    expect(budget.effectiveParseMs(26000)).toBe(25000);
  });

  test("blocks new parses once cumulative budget is exhausted", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 }, clock);
    budget.recordParse(30000);
    expect(budget.canStartParse(100)).toBe(false);
  });

  test("blocks new parses once the run deadline passes", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 }, clock);
    clock.advance(120001);
    expect(budget.remainingRunMs()).toBe(0);
    expect(budget.canStartParse(100)).toBe(false);
  });

  test("caps the effective parse allowance by remaining run time", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 }, clock);
    clock.advance(119500);
    expect(budget.effectiveParseMs(2000)).toBe(500);
  });

  test("caps the effective parse allowance by remaining cumulative budget", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 120000, maxTotalParseMs: 30000 }, clock);
    budget.recordParse(29500);
    expect(budget.effectiveParseMs(2000)).toBe(500);
  });

  test("expired run deadline yields zero allowance", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ maxRunMs: 1000, maxTotalParseMs: 30000 }, clock);
    clock.advance(5000);
    expect(budget.effectiveParseMs(2000)).toBe(0);
  });
});
