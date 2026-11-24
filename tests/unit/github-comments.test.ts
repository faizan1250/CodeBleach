import { describe, expect, test } from "bun:test";
import {
  MAX_INLINE_COMMENTS,
  computeMarkerKey,
  groupByMarkerKey,
  parseMarkerKeys,
  partitionPublishable,
  renderCommentBody,
  renderMarker,
  validateCommentTarget,
} from "../../src/github/comments.ts";
import type { ChangedFile, DiffResult, PrMeta } from "../../src/types/index.ts";
import type { AcceptedValidatedFinding } from "../../src/types/index.ts";

const ZWSP = String.fromCharCode(0x200b);
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const KEY = "a".repeat(64);
const OTHER_KEY = "c".repeat(64);

function prMeta(overrides: Partial<PrMeta> = {}): PrMeta {
  return { owner: "acme", repo: "widget", number: 7, baseSha: BASE, headSha: HEAD, ...overrides };
}

function changedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [],
    commentableLines: [10, 11, 12],
    symbols: [],
    ...overrides,
  };
}

function diffResult(headSha: string = HEAD, files: ChangedFile[] = [changedFile()]): DiffResult {
  return { baseSha: BASE, headSha, mergeBase: "m".repeat(40), files };
}

interface FindingInput {
  id?: string | undefined;
  fingerprint?: string | undefined;
  modelFile?: string | undefined;
  modelLine?: number | undefined;
  title?: string | undefined;
  description?: string | undefined;
  suggestion?: string | undefined;
  targetFile?: string | undefined;
  targetLine?: number | undefined;
}

function acceptedFinding(input: FindingInput = {}): AcceptedValidatedFinding {
  const targetLine = input.targetLine ?? 10;
  return {
    finding: {
      id: input.id ?? "finding-1",
      fingerprint: input.fingerprint ?? "fingerprint-1",
      headSha: HEAD,
      symbol: "resolveUser",
      origin: { pass: "test", unitId: "unit-1" },
      title: input.title ?? "Null dereference in resolveUser",
      severity: "high",
      category: "bug",
      file: input.modelFile ?? "src/a.ts",
      line: input.modelLine ?? 10,
      description: input.description ?? "The value can be null here, but this call dereferences it.",
      ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion }),
      confidence: 0.9,
      evidence: [{ file: "src/a.ts", startLine: 10, endLine: 10, quote: "user.name" }],
      introducedByPr: true,
    },
    status: "accepted",
    checks: [],
    derivedTarget: { file: input.targetFile ?? "src/a.ts", line: targetLine, side: "RIGHT", kind: "added" },
    derivedAttribution: {
      introducedByPr: true,
      basis: { kind: "added-lines", evidenceIndex: 0, file: "src/a.ts", lines: [10] },
    },
  };
}

describe("comment body", () => {
  test("renders finding fields with trailing marker", () => {
    const finding = acceptedFinding({ suggestion: "Check the value before calling the method." });
    const body = renderCommentBody(finding, KEY);
    expect(body).toContain("**[HIGH] Null dereference in resolveUser**");
    expect(body).toContain("Category: bug");
    expect(body).toContain("The value can be null here");
    expect(body).toContain("**Suggested fix:** Check the value before calling the method.");
    const lines = body.split("\n");
    expect(lines[lines.length - 1]).toBe(`<!-- codebleach:finding:v1:${KEY} -->`);
  });

  test("omits suggestion section when absent", () => {
    const body = renderCommentBody(acceptedFinding(), KEY);
    expect(body).not.toContain("Suggested fix");
  });

  test("escapes raw HTML", () => {
    const body = renderCommentBody(acceptedFinding({ title: "<script>alert(1)</script>" }), KEY);
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  test("neutralizes mentions", () => {
    const body = renderCommentBody(acceptedFinding({ description: "ping @octocat for review" }), KEY);
    expect(body).not.toContain("@octocat");
    expect(body).toContain(`@octocat`.replace("@", `@${ZWSP}`));
  });

  test("breaks markdown links", () => {
    const body = renderCommentBody(acceptedFinding({ description: "see [click](https://evil.example/x)" }), KEY);
    expect(body).not.toContain("[click](");
    expect(body).toContain("\\[click\\]");
  });

  test("breaks bare URL autolinks", () => {
    const body = renderCommentBody(acceptedFinding({ description: "see https://evil.example/x" }), KEY);
    expect(body).not.toContain("://");
  });

  test("strips control characters", () => {
    const body = renderCommentBody(acceptedFinding({ description: "a\x00b\x07c\x1bd" }), KEY);
    expect(body).toContain("abcd");
  });

  test("bounds overlong description, marker stays last", () => {
    const body = renderCommentBody(acceptedFinding({ description: "x".repeat(5000) }), KEY);
    const marker = renderMarker(KEY);
    expect(body.endsWith(`\n\n${marker}`)).toBe(true);
    expect(parseMarkerKeys(body)).toEqual([KEY]);
    expect(body.length - marker.length - 2).toBeLessThanOrEqual(4001);
  });

  test("forged marker in model text never parses", () => {
    const forged = `<!-- codebleach:finding:v1:${OTHER_KEY} -->`;
    const body = renderCommentBody(acceptedFinding({ description: `trust me ${forged}` }), KEY);
    expect(parseMarkerKeys(body)).toEqual([KEY]);
  });
});

describe("marker key", () => {
  const identity = { owner: "acme", repo: "widget", number: 7, fingerprint: "fp-1" };

  test("stable for same identity", () => {
    expect(computeMarkerKey(identity)).toBe(computeMarkerKey({ ...identity }));
    expect(computeMarkerKey(identity)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes with owner, repo, number, or fingerprint", () => {
    const base = computeMarkerKey(identity);
    const variants = [
      { ...identity, owner: "other" },
      { ...identity, repo: "other" },
      { ...identity, number: 8 },
      { ...identity, fingerprint: "fp-2" },
    ];
    for (const variant of variants) expect(computeMarkerKey(variant)).not.toBe(base);
  });

  test("owner and repo match case-insensitively", () => {
    expect(computeMarkerKey({ ...identity, owner: "ACME", repo: "Widget" })).toBe(computeMarkerKey(identity));
  });

  test("ignores unknown versions and malformed markers", () => {
    expect(parseMarkerKeys(`<!-- codebleach:finding:v2:${KEY} -->`)).toEqual([]);
    expect(parseMarkerKeys("<!-- codebleach:finding:v1:short -->")).toEqual([]);
    expect(parseMarkerKeys(`<!-- codebleach:finding:v1:${"g".repeat(64)} -->`)).toEqual([]);
    expect(parseMarkerKeys("<!-- codebleach:finding:v1: -->")).toEqual([]);
  });

  test("returns every v1 key in a body", () => {
    expect(parseMarkerKeys(`${renderMarker(KEY)}\n${renderMarker(OTHER_KEY)}`)).toEqual([KEY, OTHER_KEY]);
  });
});

describe("target gate", () => {
  test("accepts valid RIGHT-side commentable target", () => {
    const result = validateCommentTarget(acceptedFinding(), diffResult(), prMeta());
    expect(result).toEqual({
      ok: true,
      target: { path: "src/a.ts", line: 10, side: "RIGHT", commitId: HEAD },
    });
  });

  test("ignores model file and line", () => {
    const finding = acceptedFinding({ modelFile: "src/other.ts", modelLine: 99 });
    const result = validateCommentTarget(finding, diffResult(), prMeta());
    expect(result).toEqual({
      ok: true,
      target: { path: "src/a.ts", line: 10, side: "RIGHT", commitId: HEAD },
    });
  });

  test("rejects file missing from diff", () => {
    const result = validateCommentTarget(acceptedFinding({ targetFile: "src/gone.ts" }), diffResult(), prMeta());
    expect(result).toEqual({ ok: false, reason: "target_file_not_in_diff" });
  });

  test("rejects deleted file", () => {
    const diff = diffResult(HEAD, [changedFile({ status: "deleted" })]);
    const result = validateCommentTarget(acceptedFinding(), diff, prMeta());
    expect(result).toEqual({ ok: false, reason: "target_file_skipped" });
  });

  test("rejects skipped file", () => {
    const diff = diffResult(HEAD, [changedFile({ skipReason: "binary" })]);
    const result = validateCommentTarget(acceptedFinding(), diff, prMeta());
    expect(result).toEqual({ ok: false, reason: "target_file_skipped" });
  });

  test("rejects non-RIGHT side", () => {
    const finding = acceptedFinding();
    const left = { ...finding, derivedTarget: { ...finding.derivedTarget, side: "LEFT" as unknown as "RIGHT" } };
    const result = validateCommentTarget(left, diffResult(), prMeta());
    expect(result).toEqual({ ok: false, reason: "target_side_not_right" });
  });

  test("rejects invalid lines", () => {
    for (const line of [0, 1.5, Number.NaN]) {
      const finding = acceptedFinding();
      const bad = {
        ...finding,
        derivedTarget: { ...finding.derivedTarget, line: line as unknown as number },
      };
      expect(validateCommentTarget(bad, diffResult(), prMeta())).toEqual({
        ok: false,
        reason: "target_line_invalid",
      });
    }
  });

  test("rejects non-commentable line", () => {
    const result = validateCommentTarget(acceptedFinding({ targetLine: 99 }), diffResult(), prMeta());
    expect(result).toEqual({ ok: false, reason: "target_line_not_commentable" });
  });

  test("rejects head SHA drift", () => {
    const result = validateCommentTarget(acceptedFinding(), diffResult("d".repeat(40)), prMeta());
    expect(result).toEqual({ ok: false, reason: "target_head_sha_mismatch" });
  });
});

describe("partition and grouping", () => {
  test("preserves input order across eligible and ineligible", () => {
    const findings = [
      acceptedFinding({ id: "one", targetLine: 10 }),
      acceptedFinding({ id: "two", targetLine: 99 }),
      acceptedFinding({ id: "three", targetLine: 11 }),
    ];
    const { eligible, ineligible } = partitionPublishable(findings, diffResult(), prMeta());
    expect(eligible.map((candidate) => candidate.finding.finding.id)).toEqual(["one", "three"]);
    expect(ineligible.map((candidate) => candidate.finding.finding.id)).toEqual(["two"]);
    expect(ineligible[0]?.reason).toBe("target_line_not_commentable");
    expect(eligible[0]?.target.line).toBe(10);
  });

  test("groups colliding marker keys", () => {
    const findings = [
      acceptedFinding({ id: "a", fingerprint: "same-fp" }),
      acceptedFinding({ id: "b", fingerprint: "same-fp" }),
      acceptedFinding({ id: "c", fingerprint: "other-fp" }),
    ];
    const { eligible } = partitionPublishable(findings, diffResult(), prMeta());
    const groups = groupByMarkerKey(eligible);
    expect(groups.size).toBe(2);
    const colliding = [...groups.values()].find((group) => group.length === 2);
    expect(colliding?.map((candidate) => candidate.finding.finding.id).sort()).toEqual(["a", "b"]);
  });

  test("changed fingerprint changes marker key", () => {
    const diff = diffResult();
    const meta = prMeta();
    const before = partitionPublishable([acceptedFinding({ fingerprint: "fp-before" })], diff, meta);
    const after = partitionPublishable([acceptedFinding({ fingerprint: "fp-after" })], diff, meta);
    expect(before.eligible[0]?.markerKey).not.toBe(after.eligible[0]?.markerKey);
  });

  test("caps inline comments at ten per run", () => {
    expect(MAX_INLINE_COMMENTS).toBe(10);
  });
});
