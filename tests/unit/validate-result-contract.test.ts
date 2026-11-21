import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ChangedFile, DiffResult, Finding, ReviewUnit } from "../../src/types/index.ts";
import { VALIDATION_CHECK_CODES, type CheckResult, type ValidatedFinding } from "../../src/types/validation.ts";
import { makeCheck, MAX_CHECK_DETAIL_CHARS } from "../../src/validate/checks.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { summarizeValidation } from "../../src/core/run-artifact.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

const CODE_SET = new Set<string>(VALIDATION_CHECK_CODES);

function check(name: string, outcome: CheckResult["outcome"], code: CheckResult["code"], detail?: string): CheckResult {
  return detail === undefined ? { name, outcome, code } : { name, outcome, code, detail };
}

function validated(
  id: string,
  status: ValidatedFinding["status"],
  checks: CheckResult[],
  extra: Partial<ValidatedFinding> = {},
): ValidatedFinding {
  return {
    finding: {
      id,
      fingerprint: `fp-${id}`,
      headSha: HEAD,
      origin: { pass: "test", unitId: "unit-1" },
      title: "t",
      severity: "high",
      category: "null-handling",
      file: "src/a.ts",
      line: 1,
      description: "d",
      confidence: 0.9,
      evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }],
      introducedByPr: true,
    },
    status,
    checks,
    ...extra,
  };
}

describe("check result contract", () => {
  test("detail is bounded", () => {
    expect(MAX_CHECK_DETAIL_CHARS).toBe(300);
    const long = makeCheck("evidence_quote", "failed", "evidence_quote_not_found", "x".repeat(500));
    expect(long.detail?.length).toBeLessThanOrEqual(MAX_CHECK_DETAIL_CHARS);
    expect(long.outcome).toBe("failed");
    expect(long.code).toBe("evidence_quote_not_found");
  });

  test("closed code set pins every emitted code", () => {
    expect(CODE_SET.size).toBe(51);
    expect(CODE_SET.has("check_skipped_prerequisite_failed")).toBe(true);
    expect(CODE_SET.has("not_introduced_by_pr")).toBe(true);
  });

  test("summarizes status, duplicate, policy, and skipped counts", () => {
    const results = [
      validated("a", "accepted", [
        check("finding_head_sha", "passed", "finding_head_sha_match"),
        check("dedupe_fingerprint", "passed", "dedupe_unique"),
        check("dedupe_secondary", "passed", "dedupe_unique"),
        check("max_findings", "passed", "max_findings_ok"),
      ]),
      validated("b", "rejected", [
        check("finding_head_sha", "passed", "finding_head_sha_match"),
        check("dedupe_fingerprint", "failed", "duplicate_fingerprint", "duplicate of finding a (shared fingerprint)"),
      ]),
      validated("c", "rejected", [
        check("severity_policy", "failed", "severity_below_threshold", "severity high is below threshold critical"),
      ]),
      validated("d", "inconclusive", [
        check("introduced_by_pr", "inconclusive", "introduction_inconclusive", "no verified evidence intersects"),
      ]),
      validated("e", "rejected", [
        check("finding_head_sha", "failed", "finding_head_sha_mismatch", "finding headSha does not match"),
        check("origin_unit", "skipped", "check_skipped_prerequisite_failed", "skipped: prerequisite check failed"),
      ]),
    ];
    expect(summarizeValidation(results)).toEqual({
      total: 5,
      accepted: 1,
      rejected: 3,
      inconclusive: 1,
      duplicates: 1,
      policyFiltered: 1,
      checksSkipped: 1,
    });
    expect(summarizeValidation([])).toEqual({
      total: 0,
      accepted: 0,
      rejected: 0,
      inconclusive: 0,
      duplicates: 0,
      policyFiltered: 0,
      checksSkipped: 0,
    });
  });

  test("serialized findings keep outcome, code, target, and link without secrets", () => {
    const item = validated(
      "a",
      "rejected",
      [check("dedupe_secondary", "failed", "duplicate_secondary_key", "secondary duplicate of finding w")],
      {
        duplicateOfId: "w",
        derivedTarget: { file: "src/a.ts", line: 1, side: "RIGHT", kind: "added" },
      },
    );
    const roundTrip = JSON.parse(JSON.stringify(item)) as ValidatedFinding;
    expect(roundTrip.checks[0]).toMatchObject({ outcome: "failed", code: "duplicate_secondary_key" });
    expect(roundTrip.duplicateOfId).toBe("w");
    expect(roundTrip.derivedTarget).toEqual({ file: "src/a.ts", line: 1, side: "RIGHT", kind: "added" });
    expect("llmVerdict" in roundTrip).toBe(false);
    expect("passed" in (roundTrip.checks[0] ?? {})).toBe(false);
  });
});

describe("engine result wiring", () => {
  function addedFile(): ChangedFile {
    return {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ kind: "add", oldLine: null, newLine: 1, position: 1, text: "code" }],
        },
      ],
      commentableLines: [1],
      symbols: [{ name: "render", kind: "function", startLine: 1, endLine: 10, changedLines: [1] }],
    };
  }

  function unit(): ReviewUnit {
    const file = addedFile();
    return {
      id: "unit-1",
      file: {
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        language: file.language,
        commentableLines: [...file.commentableLines],
      },
      diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
      symbol: { name: "render", kind: "function", startLine: 1, endLine: 10, changedLines: [1] },
      context: [],
      rules: [],
    };
  }

  function diff(): DiffResult {
    return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [addedFile()] };
  }

  function finding(id: string, overrides: Partial<Finding> = {}): Finding {
    return {
      id,
      fingerprint: `fp-${id}`,
      headSha: HEAD,
      origin: { pass: "test", unitId: "unit-1" },
      title: "Null dereference on name",
      severity: "high",
      category: "null-handling",
      file: "src/a.ts",
      line: 1,
      description: "name may be null at runtime.",
      confidence: 0.9,
      evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }],
      introducedByPr: true,
      ...overrides,
    };
  }

  function engineWith(headText: string) {
    return createValidationEngine({
      repoDir: "/repo",
      createReader: (input) =>
        new FakeValidationSnapshotReader({
          headSha: input.headSha,
          mergeBase: input.mergeBase,
          script: { head: { "src/a.ts": { status: "ok", text: headText, bytes: headText.length } } },
        }),
    });
  }

  const headText = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");

  test("accepted findings carry a head-side target and no duplicate link", async () => {
    const engine = engineWith(headText);
    const [item] = await engine.validate([finding("a")], diff(), [unit()], ConfigFileSchema.parse({}));
    expect(item?.status).toBe("accepted");
    expect(item?.derivedTarget).toEqual({ file: "src/a.ts", line: 1, side: "RIGHT", kind: "added" });
    expect(item?.duplicateOfId).toBeUndefined();
    expect(item?.derivedAttribution).toEqual({
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [1] },
    });
    expect("llmVerdict" in (item ?? {})).toBe(false);
    for (const c of item?.checks ?? []) {
      expect(CODE_SET.has(c.code)).toBe(true);
      expect((c.detail ?? "").length).toBeLessThanOrEqual(MAX_CHECK_DETAIL_CHARS);
    }
  });

  test("duplicate losers link the retained finding id", async () => {
    const engine = engineWith(headText);
    const loser = finding("lo", { severity: "medium", confidence: 0.86 });
    const winner = finding("hi", {
      severity: "critical",
      confidence: 0.99,
      fingerprint: loser.fingerprint,
      title: "Distinct title keeps the primary key decisive",
    });
    const result = await engine.validate([loser, winner], diff(), [unit()], ConfigFileSchema.parse({}));
    const rejected = result.find((item) => item.status === "rejected");
    expect(rejected?.duplicateOfId).toBe("hi");
    expect(rejected?.derivedTarget).toEqual({ file: "src/a.ts", line: 1, side: "RIGHT", kind: "added" });
    expect(result.find((item) => item.status === "accepted")?.duplicateOfId).toBeUndefined();
  });

  test("secondary merge is independent of input order", async () => {
    const engine = engineWith(headText);
    const config = ConfigFileSchema.parse({});
    const first = finding("a");
    const second = finding("b", { title: "NULL  dereference ON name" });
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const result = await engine.validate(order, diff(), [unit()], config);
      expect(result.filter((item) => item.status === "accepted")).toHaveLength(1);
      const loser = result.find((item) => item.status === "rejected");
      expect(loser?.checks).toContainEqual(
        expect.objectContaining({ name: "dedupe_secondary", outcome: "failed", code: "duplicate_secondary_key" }),
      );
      expect(loser?.duplicateOfId).toBe(result.find((item) => item.status === "accepted")?.finding.id);
    }
  });

  test("cap ranking is independent of input order", async () => {
    const engine = engineWith(headText);
    const config = ConfigFileSchema.parse({ review: { max_findings: 1 } });
    const low = finding("low", { severity: "medium", title: "Minor null check" });
    const high = finding("high", { severity: "critical", title: "Critical null dereference" });
    for (const order of [
      [low, high],
      [high, low],
    ]) {
      const result = await engine.validate(order, diff(), [unit()], config);
      expect(result.find((item) => item.status === "accepted")?.finding.id).toBe("high");
      const loser = result.find((item) => item.status === "rejected");
      expect(loser?.checks).toContainEqual(
        expect.objectContaining({ name: "max_findings", outcome: "failed", code: "max_findings_exceeded" }),
      );
      expect(loser?.duplicateOfId).toBeUndefined();
    }
  });

  test("separator hardening keeps adjacent field spellings distinct", async () => {
    const engine = engineWith(headText);
    const config = ConfigFileSchema.parse({});
    const a = finding("a", { title: "Same Title" });
    const b = finding("b", { title: "Same Title" });
    const units: ReviewUnit[] = [unit()];
    const secondUnit: ReviewUnit = { ...units[0]!, id: "unit-2", symbol: { ...units[0]!.symbol, name: "other" } };
    const result = await engine.validate(
      [a, { ...b, symbol: "other", origin: { pass: "test", unitId: "unit-2" } }],
      diff(),
      [units[0]!, secondUnit],
      config,
    );
    expect(result.filter((item) => item.status === "accepted")).toHaveLength(2);
  });

  test("fabricated quotes never leak into check details", async () => {
    const engine = engineWith(headText);
    const quote = "fabricated-quote-9f8e7d6c5b4a";
    const [item] = await engine.validate(
      [finding("a", { evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote }] })],
      diff(),
      [unit()],
      ConfigFileSchema.parse({}),
    );
    expect(item?.status).toBe("rejected");
    for (const c of item?.checks ?? []) {
      expect(c.detail ?? "").not.toContain(quote);
    }
  });
});
