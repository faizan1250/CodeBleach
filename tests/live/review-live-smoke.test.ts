import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { Logger } from "../../src/core/logger.ts";
import { API_KEY_ENV, FIXED_MODEL_ID, TRAINING_OPT_IN_ENV } from "../../src/llm/constants.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import { ReviewEngineImpl } from "../../src/review/engine.ts";
import { CODE_REVIEW_PROMPT_VERSION } from "../../src/review/prompt.ts";
import type { ReviewUnit } from "../../src/types/context.ts";

// Opt-in live seeded-bug smoke: real prompt + fixed live provider + parse +
// normalize against tiny synthetic fixtures. Never repo source, no secrets.
// Gated by CODEBLEACH_LIVE_SMOKE=1 so plain `bun test` / CI skips it.
// Manual invocation documented in docs/live-smoke.md.
const LIVE = process.env.CODEBLEACH_LIVE_SMOKE === "1";
// Live inference needs headroom: two sequential units on the default 90 s
// per-request budget plus one bounded cap escalation each.
const LIVE_TIMEOUT_MS = 300_000;
// Floor well above the 64-token incomplete probe: a completion cut by the
// output cap must fail loudly, never pass as a successful smoke.
const MIN_SMOKE_OUTPUT_TOKENS = 4096;

const UNIT_DEFECT = "unit-live-seeded-withdraw";
const UNIT_CONTROL = "unit-live-clean-greet";
const HEAD_SHA = "live-smoke-head";

if (LIVE) {
  // stderr, pre-network: even synthetic prompts may train future models.
  console.warn(
    `[live-smoke] sending synthetic prompts to the live ${FIXED_MODEL_ID} model; ` +
      "prompts/completions may train future models (Not-ZDR).",
  );
}

function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function liveKey(): string {
  const key = process.env[API_KEY_ENV];
  if (key === undefined || key.length === 0) {
    throw new Error(`[live-smoke] refusing pre-network: set ${API_KEY_ENV} to run the live smoke`);
  }
  return key;
}

function requireLiveGate(): string {
  if (process.env[TRAINING_OPT_IN_ENV] !== "true") {
    throw new Error(
      `[live-smoke] refusing pre-network: set ${TRAINING_OPT_IN_ENV}=true (exact) to run the live smoke`,
    );
  }
  return liveKey();
}

// Synthetic defect: withdraw debits with no overdraft/positivity check.
function defectUnit(): ReviewUnit {
  return {
    id: UNIT_DEFECT,
    file: {
      path: "synthetic/withdraw.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [2, 3],
    },
    diff: {
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 4,
          lines: [
            {
              kind: "ctx",
              oldLine: 1,
              newLine: 1,
              position: 0,
              text: "export function withdraw(account: Account, amount: number): void {",
            },
            {
              kind: "add",
              oldLine: null,
              newLine: 2,
              position: 1,
              text: "  account.balance -= amount;",
            },
            {
              kind: "add",
              oldLine: null,
              newLine: 3,
              position: 2,
              text: '  account.ledger.push({ kind: "withdrawal", amount });',
            },
            { kind: "ctx", oldLine: null, newLine: 4, position: 3, text: "}" },
          ],
        },
      ],
      originalHunkCount: 1,
      includedHunkCount: 1,
      omittedHunkCount: 0,
      truncated: false,
    },
    symbol: { name: "withdraw", kind: "function", startLine: 1, endLine: 4, changedLines: [2, 3] },
    context: [
      {
        id: "ctx-account",
        kind: "definition",
        file: "synthetic/withdraw.ts",
        startLine: 1,
        endLine: 1,
        text: "interface Account { balance: number; ledger: Array<{ kind: string; amount: number }>; }",
        score: 1,
        tokens: 20,
        reason: "defines Account mutated below",
      },
    ],
    rules: [],
  };
}

function controlUnit(): ReviewUnit {
  return {
    id: UNIT_CONTROL,
    file: {
      path: "synthetic/greet.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      commentableLines: [2],
    },
    diff: {
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            {
              kind: "ctx",
              oldLine: 1,
              newLine: 1,
              position: 0,
              text: "export function greet(name: string): string {",
            },
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
    rules: [],
    context: [],
  };
}

function fixtureHash(): string {
  return createHash("sha256")
    .update(JSON.stringify([defectUnit().diff, controlUnit().diff]))
    .digest("hex")
    .slice(0, 16);
}

describe.skipIf(!LIVE)("live seeded-bug smoke (opt-in, Not-ZDR)", () => {
  test("live gate refuses pre-network without key and exact training opt-in", () => {
    requireLiveGate();
  });

  test(
    "live seeded review completes with a shape-valid outcome",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const key = requireLiveGate();
      const config = ConfigFileSchema.parse({});
      // High output cap: the 64-token incomplete path is already proven by the
      // P4-00 spike; this smoke must never run near it.
      expect(config.llm.max_output_tokens).toBeGreaterThanOrEqual(MIN_SMOKE_OUTPUT_TOKENS);
      const provider = new OpenCodeProvider({ env: process.env });
      const engine = new ReviewEngineImpl({ provider, logger: nullLogger(), env: process.env });
      const result = await engine.review([defectUnit(), controlUnit()], config, {
        headSha: HEAD_SHA,
      });

      // Incomplete is an explicit failure, never a passing smoke: the engine
      // already spent its one bounded cap escalation getting here.
      const incomplete = result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "REVIEW_OUTPUT_INCOMPLETE" ||
          /provider response incomplete/i.test(diagnostic.message),
      );
      if (incomplete.length > 0) {
        throw new Error(
          `[live-smoke] INCOMPLETE output (cap escalation exhausted): ${JSON.stringify(incomplete).slice(0, 500)}`,
        );
      }
      expect(result.status === "complete" || result.status === "partial").toBe(true);
      expect(result.unitsSubmitted).toBe(2);
      expect(result.unitsReviewed + result.unitsFailed).toBe(2);
      expect(result.model).toBe(FIXED_MODEL_ID);
      expect(result.promptVersion).toBe(CODE_REVIEW_PROMPT_VERSION);
      // Every reviewed unit issued at least one provider call.
      expect(result.usage.requests).toBeGreaterThanOrEqual(result.unitsReviewed);
      // Diagnostics stay bounded and secret-free (provider key bytes redacted).
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.message.length).toBeLessThanOrEqual(500);
        expect(diagnostic.message).not.toContain(key);
      }
      // Shape-only on model output: engine-owned fields are deterministic,
      // prose/counts are not asserted (smoke, not benchmark).
      for (const finding of result.findings) {
        expect(finding.file.length).toBeGreaterThan(0);
        expect(Number.isInteger(finding.line) && finding.line > 0).toBe(true);
        expect(finding.evidence.length).toBeGreaterThan(0);
        expect(finding.origin.unitId === UNIT_DEFECT || finding.origin.unitId === UNIT_CONTROL).toBe(
          true,
        );
        expect(finding.headSha).toBe(HEAD_SHA);
      }
      // Bounded record: metadata + outcome only, never prompts/responses/secrets.
      console.log(
        JSON.stringify({
          smoke: "live-seeded-review",
          model: result.model,
          promptVersion: result.promptVersion,
          fixtureHash: fixtureHash(),
          date: new Date().toISOString(),
          status: result.status,
          unitsSubmitted: result.unitsSubmitted,
          unitsReviewed: result.unitsReviewed,
          unitsFailed: result.unitsFailed,
          findingCount: result.findings.length,
          findings: result.findings.map((finding) => ({
            file: finding.file,
            line: finding.line,
            category: finding.category,
            unitId: finding.origin.unitId,
          })),
          diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
          usage: result.usage,
        }),
      );
    },
  );
});
