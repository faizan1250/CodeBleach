import { describe, expect, test } from "bun:test";
import type { ChangedFile, ChangedSymbol, DiffHunk, DiffLine, Finding, ReviewUnit } from "../../src/types/index.ts";
import type { SnapshotReadResult } from "../../src/validate/snapshot.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { validateEvidence } from "../../src/validate/evidence.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
import { isAcceptedFinding } from "../../src/core/contracts.ts";
import { ConfigFileSchema } from "../../src/config/schema.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const BEGIN = "-----BEGIN PRIVATE KEY-----";
const END = "-----END PRIVATE KEY-----";

// Unique synthetic payloads; each identifies exactly one source line.
const A1 = "A-01-AAAA1111BBBB2222";
const A2 = "A-02-CCCC3333DDDD4444";
const B1 = "B-01-EEEE5555FFFF6666";
const B2 = "B-02-GGGG7777HHHH8888";

// Complete block A plus an unterminated block B (no END2): the pairing flaw
// verifies a raw span covering both because the in-range guard exits early
// on the first complete pair.
const TRUNCATED_TWO = ["// config", BEGIN, A1, A2, END, "filler-mid", BEGIN, B1, B2].join("\n");
const TRUNCATED_QUOTE = [BEGIN, A1, A2, END, "filler-mid", BEGIN, B1].join("\n");

const TWO_COMPLETE = [BEGIN, A1, END, BEGIN, B1, END].join("\n");

// Lone BEGIN with no END of its own ahead of a complete block: lazy redaction
// pairs it with the later END, which the guard must not accept as a close.
const LONE_THEN_COMPLETE = [BEGIN, "X-01-QQQQ1111RRRR2222", BEGIN, "Y-01-SSSS3333TTTT4444", END].join("\n");

// Same-line delimiters: the builder must scan occurrences in source order.
// A trailing BEGIN after BEGIN..END on one line stays open to EOF; the
// per-line boolean builder drops it and verifies the tail.
const SAME_LINE_TRAILING = [`${BEGIN} ${A1} ${END} ${BEGIN}`, "TAIL-01-ZZZZ1111WWWW2222"].join("\n");
const SAME_LINE_TRAILING_GAP = [
  `${BEGIN} ${A1} ${END} ${BEGIN}`,
  "// ordinary comment",
  "TAIL-06-QQQQ1111RRRR2222",
].join("\n");
const SAME_LINE_END_BEGIN = ["code-top()", `${END} ${BEGIN}`, "TAIL-02-AAAA1111BBBB2222"].join("\n");
const SAME_LINE_PAYLOAD_AFTER_BEGIN = `${BEGIN} ${A1} ${END} ${BEGIN} TAIL-03-CCCC3333DDDD4444`;
const SAME_LINE_TWO_COMPLETE = `${BEGIN} ${A1} ${END} ${BEGIN} ${B1} ${END}`;
const SAME_LINE_MULTI_BEGIN = `${BEGIN} ${BEGIN} ${A1} ${END}`;

// Oversized block: BEGIN 22 lines above and END 22 below the fragment, both
// outside the bounded outward probe.
function oversizedBothOutside(): string {
  const lines = [BEGIN];
  for (let i = 1; i <= 21; i += 1) lines.push(`pad-top-${i}`);
  lines.push("TARGET-PAYLOAD-ZZZZ1111WWWW2222");
  for (let i = 1; i <= 21; i += 1) lines.push(`pad-bot-${i}`);
  lines.push(END);
  return lines.join("\n");
}

// BEGIN 22 above, no END below (truncated tail).
function beginFarAboveTruncated(): string {
  const lines = [BEGIN];
  for (let i = 1; i <= 21; i += 1) lines.push(`pad-${i}`);
  lines.push("ORPHAN-TARGET-QQQQ1111RRRR2222");
  lines.push("tail-code()");
  return lines.join("\n");
}

function diffLine(kind: DiffLine["kind"], oldLine: number | null, newLine: number | null): DiffLine {
  return { kind, oldLine, newLine, position: newLine ?? oldLine ?? 0, text: "code" };
}

function hunk(lines: DiffLine[], newStart = 1): DiffHunk {
  return { oldStart: 1, oldLines: lines.length, newStart, newLines: lines.length, lines };
}

function testSymbol(overrides?: Partial<ChangedSymbol>): ChangedSymbol {
  return { name: "render", kind: "function", startLine: 1, endLine: 50, changedLines: [1, 2, 3], ...overrides };
}

function testFile(): ChangedFile {
  return {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [hunk([diffLine("add", null, 1), diffLine("add", null, 2), diffLine("add", null, 3)], 1)],
    commentableLines: [1, 2, 3],
    symbols: [testSymbol()],
  };
}

function testUnit(): ReviewUnit {
  return {
    id: "unit-1",
    file: { path: "src/a.ts", oldPath: null, status: "modified", language: "typescript", commentableLines: [1, 2, 3] },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: testSymbol(),
    context: [],
    rules: [],
  };
}

function testFinding(evidence: Finding["evidence"]): Finding {
  return {
    id: "finding-1",
    fingerprint: "fp-1",
    headSha: HEAD,
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "null-handling",
    file: "src/a.ts",
    line: 1,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence,
    introducedByPr: true,
    symbol: "render",
  };
}

function ok(text: string): SnapshotReadResult {
  return { status: "ok", text, bytes: new TextEncoder().encode(text).length };
}

function readerFor(headText: string) {
  return new FakeValidationSnapshotReader({
    headSha: HEAD,
    mergeBase: BASE,
    script: { head: { "src/a.ts": ok(headText) } },
  });
}

function inputFor(evidence: Finding["evidence"], reader: FakeValidationSnapshotReader) {
  return {
    finding: testFinding(evidence),
    unit: testUnit(),
    changedFile: testFile(),
    canonicalPath: "src/a.ts",
    reader,
  };
}

function rejects(result: Awaited<ReturnType<typeof validateEvidence>>) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.inconclusive).toBe(false);
    expect(result.checks.some((check) => check.code === "evidence_quote_not_found")).toBe(true);
  }
}

describe("pem interval multi-block", () => {
  test("complete+incomplete exact span rejects", async () => {
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 8, quote: TRUNCATED_QUOTE }], readerFor(TRUNCATED_TWO)),
    );
    rejects(result);
  });

  test("spanning quote via fallback rejects", async () => {
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 3, endLine: 7, quote: TRUNCATED_QUOTE }], readerFor(TRUNCATED_TWO)),
    );
    rejects(result);
  });

  test("second payload with first delimiters in range rejects", async () => {
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 8, quote: B1 }], readerFor(TRUNCATED_TWO)),
    );
    rejects(result);
  });

  test("two complete blocks verify", async () => {
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 6, quote: TWO_COMPLETE }], readerFor(TWO_COMPLETE)),
    );
    expect(result.ok).toBe(true);
  });

  test("lone BEGIN before complete block rejects", async () => {
    const text = LONE_THEN_COMPLETE;
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 5, quote: text }], readerFor(text)),
    );
    rejects(result);
  });
});

describe("pem interval boundaries", () => {
  test("BEGIN beyond scan radius rejects", async () => {
    const text = beginFarAboveTruncated();
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 23, endLine: 23, quote: "ORPHAN-TARGET-QQQQ1111RRRR2222" }],
        readerFor(text),
      ),
    );
    rejects(result);
  });

  test("oversized both-outside delimiters reject", async () => {
    const text = oversizedBothOutside();
    const lines = text.split("\n");
    const targetLine = lines.findIndex((line) => line.includes("TARGET-PAYLOAD")) + 1;
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: targetLine, endLine: targetLine, quote: "TARGET-PAYLOAD-ZZZZ1111WWWW2222" }],
        readerFor(text),
      ),
    );
    rejects(result);
  });

  test("truncated EOF fragment rejects", async () => {
    const text = [BEGIN, "T1-QQQQ1111RRRR2222", "T2-SSSS3333TTTT4444"].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "T1-QQQQ1111RRRR2222" }], readerFor(text)),
    );
    rejects(result);
  });

  test("orphan END range rejects", async () => {
    const text = ["code-top()", "ORPHAN-PAYLOAD-AAAA1111BBBB2222", END, "code-bot()"].join("\n");
    const quote = ["ORPHAN-PAYLOAD-AAAA1111BBBB2222", END].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 3, quote }], readerFor(text)),
    );
    rejects(result);
  });

  test("orphan END far below rejects", async () => {
    const lines = ["code-top()", "FAR-PAYLOAD-AAAA1111BBBB2222"];
    for (let i = 1; i <= 23; i += 1) lines.push(`filler-${i}`);
    lines.push(END); // line 26, 24 lines below the cited evidence
    const text = lines.join("\n");
    const quote = ["code-top()", "FAR-PAYLOAD-AAAA1111BBBB2222"].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 2, quote }], readerFor(text)),
    );
    rejects(result);
  });

  test("adjacent END/BEGIN span rejects", async () => {
    const text = [BEGIN, A1, END, BEGIN, B1, END].join("\n");
    const quote = [END, BEGIN].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 3, endLine: 4, quote }], readerFor(text)),
    );
    rejects(result);
  });

  test("CRLF multi-block span rejects", async () => {
    const crlf = TRUNCATED_TWO.split("\n").join("\r\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 8, quote: TRUNCATED_QUOTE }], readerFor(crlf)),
    );
    rejects(result);
  });
});

describe("pem interval controls", () => {
  test("code before block verifies", async () => {
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "// config" }], readerFor(TRUNCATED_TWO)),
    );
    expect(result.ok).toBe(true);
  });

  test("code after blocks verifies", async () => {
    const text = [TWO_COMPLETE, "trailer()"].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 7, endLine: 7, quote: "trailer()" }], readerFor(text)),
    );
    expect(result.ok).toBe(true);
  });

  test("filler between complete blocks verifies", async () => {
    const text = [BEGIN, A1, END, "filler-between", BEGIN, B1, END].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 4, endLine: 4, quote: "filler-between" }], readerFor(text)),
    );
    expect(result.ok).toBe(true);
  });

  test("full-block quote verifies", async () => {
    const block = [BEGIN, A1, END].join("\n");
    const text = ["// config", block, "// end"].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 4, quote: block }], readerFor(text)),
    );
    expect(result.ok).toBe(true);
  });

  test("repeated full-block quotes stay ambiguous", async () => {
    const payload = "SAME-PAYLOAD-QQQQ1111RRRR2222";
    const block = [BEGIN, payload, END].join("\n");
    const text = [block, "filler", block].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 4, endLine: 4, quote: block }], readerFor(text)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.inconclusive).toBe(true);
      expect(result.checks.some((check) => check.code === "evidence_side_ambiguous")).toBe(true);
    }
  });
});

describe("pem interval engine", () => {
  function engineReader(text: string) {
    return (input: { headSha: string; mergeBase: string }) =>
      new FakeValidationSnapshotReader({
        headSha: input.headSha,
        mergeBase: input.mergeBase,
        script: { head: { "src/a.ts": ok(text) } },
      });
  }

  function spanningSetup() {
    const lines = TRUNCATED_TWO.split("\n");
    const added = lines.map((_, index) => diffLine("add", null, index + 1));
    const changedFile: ChangedFile = {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, lines: added }],
      commentableLines: added.map((line) => line.newLine as number),
      symbols: [
        testSymbol({ startLine: 1, endLine: added.length, changedLines: added.map((l) => l.newLine as number) }),
      ],
    };
    const unit: ReviewUnit = {
      ...testUnit(),
      file: {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        language: "typescript",
        commentableLines: [...changedFile.commentableLines],
      },
      symbol: { name: "render", kind: "function", startLine: 1, endLine: added.length, changedLines: [2] },
    };
    const diff = { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [changedFile] };
    const finding: Finding = {
      ...testFinding([{ file: "src/a.ts", startLine: 2, endLine: 8, quote: TRUNCATED_QUOTE }]),
      line: 2,
    };
    return { changedFile, unit, diff, finding };
  }

  test("spanning finding never accepted or publishable", async () => {
    const { unit, diff, finding } = spanningSetup();
    const engine = createValidationEngine({ repoDir: "/repo", createReader: engineReader(TRUNCATED_TWO) });
    const result = await engine.validate([finding], diff, [unit], ConfigFileSchema.parse({}));
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.status).toBe("rejected");
    expect(item?.status).not.toBe("accepted");
    expect(item && isAcceptedFinding(item)).toBe(false);
    expect(item?.derivedAttribution?.introducedByPr).not.toBe(true);
    expect(item?.checks.some((check) => check.code === "evidence_quote_not_found")).toBe(true);
  });

  test("spanning checks carry no payload", async () => {
    const { unit, diff, finding } = spanningSetup();
    const engine = createValidationEngine({ repoDir: "/repo", createReader: engineReader(TRUNCATED_TWO) });
    const result = await engine.validate([finding], diff, [unit], ConfigFileSchema.parse({}));
    const details = (result[0]?.checks ?? []).map((check) => check.detail ?? "").join("\n");
    for (const token of [A1, A2, B1, B2]) expect(details.includes(token)).toBe(false);
  });
});

describe("pem interval same-line", () => {
  test("complete plus trailing BEGIN rejects later payload", async () => {
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "TAIL-01-ZZZZ1111WWWW2222" }],
        readerFor(SAME_LINE_TRAILING),
      ),
    );
    rejects(result);
  });

  test("trailing BEGIN across ordinary line rejects payload", async () => {
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 3, endLine: 3, quote: "TAIL-06-QQQQ1111RRRR2222" }],
        readerFor(SAME_LINE_TRAILING_GAP),
      ),
    );
    rejects(result);
  });

  test("END then BEGIN same line rejects later payload", async () => {
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 3, endLine: 3, quote: "TAIL-02-AAAA1111BBBB2222" }],
        readerFor(SAME_LINE_END_BEGIN),
      ),
    );
    rejects(result);
  });

  test("BEGIN END BEGIN same line rejects trailing payload", async () => {
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "TAIL-03-CCCC3333DDDD4444" }],
        readerFor(SAME_LINE_PAYLOAD_AFTER_BEGIN),
      ),
    );
    rejects(result);
  });

  test("two complete blocks one line verify", async () => {
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: SAME_LINE_TWO_COMPLETE }],
        readerFor(SAME_LINE_TWO_COMPLETE),
      ),
    );
    expect(result.ok).toBe(true);
  });

  test("multiple BEGINs one END same line reject", async () => {
    const result = await validateEvidence(
      inputFor(
        [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: SAME_LINE_MULTI_BEGIN }],
        readerFor(SAME_LINE_MULTI_BEGIN),
      ),
    );
    rejects(result);
  });

  test("CRLF trailing BEGIN same line rejects payload", async () => {
    const crlf = SAME_LINE_TRAILING.split("\n").join("\r\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: "TAIL-01-ZZZZ1111WWWW2222" }], readerFor(crlf)),
    );
    rejects(result);
  });
});

describe("pem interval same-line engine", () => {
  const TAIL = "TAIL-01-ZZZZ1111WWWW2222";

  function engineReader(text: string) {
    return (input: { headSha: string; mergeBase: string }) =>
      new FakeValidationSnapshotReader({
        headSha: input.headSha,
        mergeBase: input.mergeBase,
        script: { head: { "src/a.ts": ok(text) } },
      });
  }

  function trailingSetup() {
    const lines = SAME_LINE_TRAILING.split("\n");
    const added = lines.map((_, index) => diffLine("add", null, index + 1));
    const changedFile: ChangedFile = {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      language: "typescript",
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, lines: added }],
      commentableLines: added.map((line) => line.newLine as number),
      symbols: [
        testSymbol({ startLine: 1, endLine: added.length, changedLines: added.map((l) => l.newLine as number) }),
      ],
    };
    const unit: ReviewUnit = {
      ...testUnit(),
      file: {
        path: "src/a.ts",
        oldPath: null,
        status: "modified",
        language: "typescript",
        commentableLines: [...changedFile.commentableLines],
      },
      symbol: { name: "render", kind: "function", startLine: 1, endLine: added.length, changedLines: [2] },
    };
    const diff = { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [changedFile] };
    const finding: Finding = {
      ...testFinding([{ file: "src/a.ts", startLine: 2, endLine: 2, quote: TAIL }]),
      line: 2,
    };
    return { changedFile, unit, diff, finding };
  }

  test("trailing-BEGIN payload never accepted or publishable", async () => {
    const { unit, diff, finding } = trailingSetup();
    const engine = createValidationEngine({ repoDir: "/repo", createReader: engineReader(SAME_LINE_TRAILING) });
    const result = await engine.validate([finding], diff, [unit], ConfigFileSchema.parse({}));
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.status).toBe("rejected");
    expect(item?.status).not.toBe("accepted");
    expect(item && isAcceptedFinding(item)).toBe(false);
    expect(item?.derivedAttribution?.introducedByPr).not.toBe(true);
    expect(item?.checks.some((check) => check.code === "evidence_quote_not_found")).toBe(true);
  });

  test("trailing-BEGIN checks carry no payload", async () => {
    const { unit, diff, finding } = trailingSetup();
    const engine = createValidationEngine({ repoDir: "/repo", createReader: engineReader(SAME_LINE_TRAILING) });
    const result = await engine.validate([finding], diff, [unit], ConfigFileSchema.parse({}));
    const details = (result[0]?.checks ?? []).map((check) => check.detail ?? "").join("\n");
    for (const token of [A1, TAIL]) expect(details.includes(token)).toBe(false);
  });
});

describe("pem interval linear scan", () => {
  test("many sequential completes verify", async () => {
    const text = [BEGIN, A1, END, BEGIN, B1, END, BEGIN, A2, END, BEGIN, B2, END].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 12, quote: text }], readerFor(text)),
    );
    expect(result.ok).toBe(true);
  });

  test("many occurrences one line verify", async () => {
    const text = `${BEGIN} ${A1} ${END} ${BEGIN} ${B1} ${END} ${BEGIN} ${A2} ${END}`;
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: text }], readerFor(text)),
    );
    expect(result.ok).toBe(true);
  });

  test("trailing BEGIN after many one-line completes rejects", async () => {
    const text = `${BEGIN} ${A1} ${END} ${BEGIN} ${B1} ${END} ${BEGIN} TAIL-07-AAAA1111BBBB2222`;
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "TAIL-07-AAAA1111BBBB2222" }], readerFor(text)),
    );
    rejects(result);
  });

  test("alternating END BEGIN markers reject", async () => {
    const text = [END, BEGIN, "ALT-01-AAAA1111BBBB2222", END].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 4, quote: text }], readerFor(text)),
    );
    rejects(result);
  });

  test("multiple orphan ENDs reject", async () => {
    const text = ["code-top()", END, "MID-09-AAAA1111BBBB2222", END, "code-bot()"].join("\n");
    const quote = [END, "MID-09-AAAA1111BBBB2222", END].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 2, endLine: 4, quote }], readerFor(text)),
    );
    rejects(result);
  });

  test("multiple BEGINs before END reject", async () => {
    const text = [BEGIN, BEGIN, "STACK-01-AAAA1111BBBB2222", END].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 1, endLine: 4, quote: text }], readerFor(text)),
    );
    rejects(result);
  });

  test("sequential completes plus trailing BEGIN reject", async () => {
    const text = [BEGIN, A1, END, BEGIN, B1, END, BEGIN, "TAIL-05-CCCC3333DDDD4444"].join("\n");
    const result = await validateEvidence(
      inputFor([{ file: "src/a.ts", startLine: 8, endLine: 8, quote: "TAIL-05-CCCC3333DDDD4444" }], readerFor(text)),
    );
    rejects(result);
  });
});
