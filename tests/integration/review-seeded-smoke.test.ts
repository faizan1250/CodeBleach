import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { Logger } from "../../src/core/logger.ts";
import { FakeProvider } from "../../src/providers/fake.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import { CODE_REVIEW_PROMPT_VERSION } from "../../src/review/prompt.ts";
import type { ReviewUnit } from "../../src/types/context.ts";

// P4-10 deterministic seeded-bug smoke: no network, no key, no live model.
// A synthetic unit carries one obvious seeded defect; the scripted provider
// returns the expected finding, and a clean control unit returns none.
// This exercises prompt build -> parse -> normalize -> result, and pins the
// quality signal (defect cited at its line/evidence, nothing style-only).

const OPT_IN = { CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true" };

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Seeded defect: refund debits the balance with no overdraft check.
function seededUnit(): ReviewUnit {
  return {
    id: "unit-seeded-refund",
    file: {
      path: "src/payments.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [11, 12, 13],
    },
    diff: {
      hunks: [
        {
          oldStart: 8,
          oldLines: 3,
          newStart: 8,
          newLines: 6,
          lines: [
            {
              kind: "ctx",
              oldLine: 8,
              newLine: 8,
              position: 0,
              text: "export function refund(account: Account, amount: number): void {",
            },
            {
              kind: "add",
              oldLine: null,
              newLine: 9,
              position: 1,
              text: '  if (amount <= 0) throw new Error("amount must be positive");',
            },
            {
              kind: "add",
              oldLine: null,
              newLine: 10,
              position: 2,
              text: "  // seeded defect: no overdraft check before debiting",
            },
            { kind: "add", oldLine: null, newLine: 11, position: 3, text: "  account.balance -= amount;" },
            {
              kind: "add",
              oldLine: null,
              newLine: 12,
              position: 4,
              text: '  account.ledger.push({ kind: "refund", amount });',
            },
            { kind: "ctx", oldLine: 9, newLine: 13, position: 5, text: "}" },
          ],
        },
      ],
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: {
      name: "refund",
      kind: "function",
      startLine: 8,
      endLine: 13,
      changedLines: [9, 10, 11, 12],
    },
    context: [
      {
        id: "ctx-balance",
        kind: "definition",
        file: "src/payments.ts",
        startLine: 1,
        endLine: 7,
        text: "interface Account { balance: number; ledger: Array<{ kind: string; amount: number }>; }",
        score: 1,
        tokens: 20,
        reason: "defines Account mutated below",
      },
    ],
    rules: [],
  };
}

function cleanUnit(): ReviewUnit {
  return {
    id: "unit-clean-greet",
    file: {
      path: "src/format.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [3],
    },
    diff: {
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "ctx", oldLine: 1, newLine: 1, position: 0, text: "export function greet(name: string): string {" },
            { kind: "del", oldLine: 2, newLine: null, position: 1, text: '  return "hi " + name;' },
            { kind: "add", oldLine: null, newLine: 2, position: 2, text: "  return `hi ${name}`;" },
            { kind: "ctx", oldLine: 3, newLine: 3, position: 3, text: "}" },
          ],
        },
      ],
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: { name: "greet", kind: "function", startLine: 1, endLine: 3, changedLines: [2] },
    context: [],
    rules: [],
  };
}

function scriptedProvider(): FakeProvider {
  return new FakeProvider([
    {
      match: (request) => request.user.includes("src/payments.ts"),
      respond: {
        findings: [
          {
            title: "Refund debits balance without an overdraft check",
            severity: "high",
            category: "bug",
            file: "src/payments.ts",
            line: 11,
            description:
              "refund subtracts amount from balance without verifying sufficient funds; a refund larger than the balance drives it negative.",
            suggestion: "Reject or clamp refunds that exceed the available balance.",
            confidence: 0.9,
            evidence: [{ file: "src/payments.ts", startLine: 11, endLine: 11, quote: "account.balance -= amount;" }],
            introducedByPr: true,
          },
        ],
      },
    },
    { respond: { findings: [] } },
  ]);
}

describe("p4-10 seeded-bug smoke (deterministic, offline)", () => {
  test("seeded defect detected at its line with exact evidence", async () => {
    const provider = scriptedProvider();
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const config = ConfigFileSchema.parse({});
    const result = await engine.review([seededUnit(), cleanUnit()], config, {
      headSha: "seeded-head",
    });
    expect(result.status).toBe("complete");
    expect(result.unitsSubmitted).toBe(2);
    expect(result.unitsReviewed).toBe(2);
    expect(result.unitsFailed).toBe(0);
    expect(result.promptVersion).toBe(CODE_REVIEW_PROMPT_VERSION);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding).toMatchObject({
      file: "src/payments.ts",
      line: 11,
      category: "bug",
      headSha: "seeded-head",
      symbol: "refund",
    });
    expect(finding?.origin.unitId).toBe("unit-seeded-refund");
    expect(finding?.evidence).toHaveLength(1);
    expect(finding?.evidence[0]).toMatchObject({
      file: "src/payments.ts",
      startLine: 11,
      endLine: 11,
      quote: "account.balance -= amount;",
    });
    // Trigger and consequence named, not a style-only remark.
    expect(finding?.description).toContain("negative");
    expect(provider.calls).toHaveLength(2);
  });

  test("clean control unit yields no findings and leaks no unit refs", async () => {
    const provider = scriptedProvider();
    const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: { ...OPT_IN } });
    const config = ConfigFileSchema.parse({});
    const result = await engine.review([cleanUnit()], config, { headSha: "seeded-head" });
    expect(result.status).toBe("complete");
    expect(result.findings).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.user).toContain("src/format.ts");
  });

  test("fingerprint stable across runs while run-scoped id differs", async () => {
    const config = ConfigFileSchema.parse({});
    const first = await new ReviewEngineImpl({
      provider: scriptedProvider(),
      logger: nullLogger(),
      env: { ...OPT_IN },
    }).review([seededUnit(), cleanUnit()], config, { headSha: "seeded-head" });
    const second = await new ReviewEngineImpl({
      provider: scriptedProvider(),
      logger: nullLogger(),
      env: { ...OPT_IN },
    }).review([seededUnit(), cleanUnit()], config, { headSha: "seeded-head" });
    expect(first.findings).toHaveLength(1);
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]?.fingerprint).toBe(first.findings[0]?.fingerprint);
    expect(second.findings[0]?.id).not.toBe(first.findings[0]?.id);
  });
});
