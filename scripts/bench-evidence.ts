import { createHash } from "node:crypto";
import type { ChangedFile, Finding, ReviewUnit } from "../src/types/index.ts";
import { FakeValidationSnapshotReader } from "../src/validate/snapshot.ts";
import { validateEvidence } from "../src/validate/evidence.ts";

// Manual-only evidence benchmark (not part of `bun test`): an 8-item finding
// against a large synthetic head snapshot. Prints wall-clock time, snapshot
// reads, and a canonical locations hash for before/after comparison. Timing
// is informational only; the unit suite asserts the structural guarantee
// (one read per distinct snapshot) instead of wall-clock thresholds.

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const TOTAL_LINES = 20000;
const CITED = [500, 3000, 5500, 8000, 10500, 13000, 15500, 19000];

function buildText(): string {
  const lines = new Array<string>(TOTAL_LINES);
  for (let index = 0; index < TOTAL_LINES; index += 1) {
    lines[index] = `line-${String(index + 1).padStart(5, "0")} const value${index + 1} = compute(${index + 1});`;
  }
  return lines.join("\n");
}

function pad(line: number): string {
  return `line-${String(line).padStart(5, "0")}`;
}

async function main(): Promise<void> {
  const text = buildText();
  const changedFile: ChangedFile = {
    path: "src/a.ts",
    oldPath: null,
    status: "modified",
    language: "typescript",
    hunks: [
      {
        oldStart: 1,
        oldLines: CITED.length,
        newStart: CITED[0] ?? 1,
        newLines: CITED.length,
        lines: CITED.map((line) => ({ kind: "add", oldLine: null, newLine: line, position: line, text: "code" })),
      },
    ],
    commentableLines: CITED,
    symbols: [],
  };
  const unit: ReviewUnit = {
    id: "unit-1",
    file: { path: "src/a.ts", oldPath: null, status: "modified", language: "typescript", commentableLines: CITED },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: { name: "render", kind: "function", startLine: 1, endLine: TOTAL_LINES, changedLines: CITED },
    context: [],
    rules: [],
  };
  const finding: Finding = {
    id: "finding-1",
    fingerprint: "fp-1",
    headSha: HEAD,
    origin: { pass: "bench", unitId: "unit-1" },
    title: "Synthetic benchmark finding",
    severity: "high",
    category: "performance",
    file: "src/a.ts",
    line: CITED[0] ?? 1,
    description: "benchmark",
    confidence: 0.9,
    evidence: CITED.map((line, index) => ({
      file: "src/a.ts",
      startLine: index % 2 === 0 ? line : line - 1,
      endLine: index % 2 === 0 ? line : line - 1,
      quote: `${pad(line)} const value${line} = compute(${line});`,
    })),
    introducedByPr: true,
    symbol: "render",
  };

  const runs: number[] = [];
  let reader = new FakeValidationSnapshotReader({
    headSha: HEAD,
    mergeBase: BASE,
    script: { head: { "src/a.ts": { status: "ok", text, bytes: text.length } } },
  });
  // Warmup outside the timed window.
  await validateEvidence({ finding, unit, changedFile, canonicalPath: "src/a.ts", reader });
  for (let run = 0; run < 5; run += 1) {
    reader = new FakeValidationSnapshotReader({
      headSha: HEAD,
      mergeBase: BASE,
      script: { head: { "src/a.ts": { status: "ok", text, bytes: text.length } } },
    });
    const start = performance.now();
    const result = await validateEvidence({ finding, unit, changedFile, canonicalPath: "src/a.ts", reader });
    runs.push(performance.now() - start);
    if (!result.ok) throw new Error("benchmark fixture must verify");
    const hash = createHash("sha256").update(JSON.stringify(result.locations)).digest("hex").slice(0, 16);
    if (run === 0) console.log(`locations=${result.locations.length} hash=${hash} reads=${reader.reads.length}`);
  }
  runs.sort((a, b) => a - b);
  console.log(`lines=${TOTAL_LINES} items=${CITED.length} medianMs=${(runs[2] ?? 0).toFixed(1)}`);
}

await main();
