import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { createLogger } from "../../src/core/logger.ts";
import { GitDiffEngine } from "../../src/diff/git.ts";
import type { ChangedFile, DiffResult, Finding, ReviewUnit, ValidatedFinding } from "../../src/types/index.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
import { GitValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import type { ValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import { git, makeRepo } from "../helpers/git-repo.ts";

const BASE_A =
  "export function render(name: string | null): string {\n" +
  "  if (name === null) {\n" +
  '    return "anon";\n' +
  "  }\n" +
  "  return `hi $" +
  "{name}`;\n" +
  "}\n";

const HEAD_A =
  "export function render(name: string | null): string {\n" +
  "  if (name === null) {\n" +
  '    return "anon";\n' +
  "  }\n" +
  "  const label = name.toUpperCase();\n" +
  "  return `hi $" +
  "{label}`;\n" +
  "}\n";

const BASE_DEL =
  "export function risky(input: string | null): string {\n" +
  "  if (input === null) {\n" +
  '    return "fallback";\n' +
  "  }\n" +
  "  return input.trim();\n" +
  "}\n";

const HEAD_DEL = "export function risky(input: string | null): string {\n" + '  return input ?? "fallback";\n' + "}\n";

const BASE_OLD =
  'export const legacyName = "legacy";\n' +
  "export const legacyVersion = 1;\n" +
  "export function legacyInit(): string {\n" +
  "  return `" +
  "$" +
  "{legacyName}@$" +
  "{legacyVersion}`;\n" +
  "}\n";

const HEAD_NEW =
  'export const legacyName = "legacy";\n' +
  "export const legacyVersion = 2;\n" +
  "export function legacyInit(): string {\n" +
  "  return `" +
  "$" +
  "{legacyName}@$" +
  "{legacyVersion}`;\n" +
  "}\n";

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

interface MatrixRepo {
  dir: string;
  cleanup: () => Promise<void>;
  diff: DiffResult;
}

async function buildRepo(): Promise<MatrixRepo> {
  const { dir, cleanup } = await makeRepo();
  try {
    await writeFiles(dir, {
      "src/a.ts": BASE_A,
      "src/old.ts": BASE_OLD,
      "src/del.ts": BASE_DEL,
      "src/gone.ts": "export const gone = true;\n",
    });
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base", "--quiet"]);
    const base = await git(dir, ["rev-parse", "HEAD"]);
    await writeFiles(dir, { "src/a.ts": HEAD_A, "src/new.ts": HEAD_NEW, "src/del.ts": HEAD_DEL });
    await git(dir, ["add", "-A"]);
    await git(dir, ["rm", "--quiet", "src/old.ts", "src/gone.ts"]);
    await git(dir, ["commit", "-m", "head", "--quiet"]);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const logger = createLogger({ level: "error", runId: "p510-matrix" });
    const diff = await new GitDiffEngine({ logger }).run({
      repoDir: dir,
      baseSha: base,
      headSha: head,
      config: ConfigFileSchema.parse({}),
    });
    // Dirty worktree must never influence validation: line 5 of src/a.ts no
    // longer matches the head snapshot after this write.
    await writeFile(join(dir, "src/a.ts"), HEAD_A.replace("name.toUpperCase()", "String(name).toUpperCase() // dirty"));
    return { dir, cleanup, diff };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function changedFile(diff: DiffResult, path: string): ChangedFile {
  const file = diff.files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`changed file missing: ${path}`);
  return file;
}

function unitFor(file: ChangedFile, id: string, extraSymbol: Record<string, unknown> = {}): ReviewUnit {
  const symbol = file.symbols[0];
  if (symbol === undefined) throw new Error(`changed file has no symbol: ${file.path}`);
  return {
    id,
    file: {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      language: file.language,
      commentableLines: [...file.commentableLines],
    },
    diff: { hunks: [], originalHunkCount: 0, includedHunkCount: 0, omittedHunkCount: 0, truncated: false },
    symbol: { ...symbol, ...extraSymbol },
    context: [],
    rules: [],
  };
}

let findingSeq = 0;

function finding(overrides: Partial<Finding> & { file: string; line: number }): Finding {
  findingSeq += 1;
  const id = overrides.id ?? `f-${findingSeq}`;
  return {
    headSha: "",
    origin: { pass: "matrix", unitId: "unit-a" },
    title: `matrix finding ${id}`,
    severity: "high",
    category: "null-handling",
    description: `matrix description ${id}`,
    confidence: 0.9,
    evidence: [],
    introducedByPr: true,
    ...overrides,
    id,
    fingerprint: overrides.fingerprint ?? `fp-${id}`,
  };
}

function byId(results: ValidatedFinding[], id: string): ValidatedFinding {
  const item = results.find((entry) => entry.finding.id === id);
  if (item === undefined) throw new Error(`validated finding missing: ${id}`);
  return item;
}

function codesOf(item: ValidatedFinding): string[] {
  return item.checks.map((check) => check.code);
}

describe("p5-10 final validation matrix over real commits", () => {
  test("deterministic end-to-end outcomes, exact-SHA reads, no network", async () => {
    const { dir, cleanup, diff } = await buildRepo();
    const originalFetch = globalThis.fetch;
    // Any provider/GitHub network use fails the run loudly.
    globalThis.fetch = (() => {
      throw new Error("network used during validation");
    }) as unknown as typeof fetch;
    try {
      const fileA = changedFile(diff, "src/a.ts");
      const fileDel = changedFile(diff, "src/del.ts");
      const fileNew = changedFile(diff, "src/new.ts");
      const fileGone = changedFile(diff, "src/gone.ts");
      expect(fileNew.status).toBe("renamed");
      expect(fileNew.oldPath).toBe("src/old.ts");
      expect(fileGone.status).toBe("deleted");

      const delOldLines = fileDel.hunks.flatMap((hunk) =>
        hunk.lines.filter((line) => line.kind === "del" && line.oldLine !== null).map((line) => line.oldLine as number),
      );
      expect(delOldLines.length).toBeGreaterThan(0);
      const anchorOnlyOldLine = delOldLines.find((line) => !fileDel.commentableLines.includes(line));
      expect(anchorOnlyOldLine).toBeDefined();
      const anchorLine = 2;
      expect(fileDel.commentableLines).toContain(anchorLine);

      const units: ReviewUnit[] = [
        unitFor(fileA, "unit-a"),
        unitFor(fileDel, "unit-del", { deletedLines: delOldLines, anchorLine }),
        unitFor(fileNew, "unit-new"),
      ];
      const headSha = diff.headSha;
      const withHead = <T extends { headSha: string }>(item: T): T => ({ ...item, headSha });

      const items: Finding[] = [
        withHead(
          finding({
            id: "good-added",
            file: "src/a.ts",
            line: 5,
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
          }),
        ),
        // Model claims introducedByPr=true but the evidence is unchanged context.
        withHead(
          finding({
            id: "model-lies-true",
            file: "src/a.ts",
            line: 3,
            introducedByPr: true,
            evidence: [{ file: "src/a.ts", startLine: 3, endLine: 3, quote: 'return "anon";' }],
          }),
        ),
        // Model claims introducedByPr=false but the evidence proves an addition.
        withHead(
          finding({
            id: "model-lies-false",
            file: "src/a.ts",
            line: 5,
            introducedByPr: false,
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
          }),
        ),
        // Valid context target whose evidence ties to an added line.
        withHead(
          finding({
            id: "ctx-target",
            file: "src/a.ts",
            line: 3,
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
          }),
        ),
        withHead(
          finding({
            id: "bad-file",
            file: "src/nope.ts",
            line: 1,
            evidence: [{ file: "src/nope.ts", startLine: 1, endLine: 1, quote: "nothing" }],
          }),
        ),
        withHead(
          finding({
            id: "bad-path",
            file: "../evil.ts",
            line: 1,
            evidence: [{ file: "../evil.ts", startLine: 1, endLine: 1, quote: "nothing" }],
          }),
        ),
        withHead(
          finding({
            id: "bad-line",
            file: "src/a.ts",
            line: 999,
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
          }),
        ),
        withHead(
          finding({
            id: "fabricated",
            file: "src/a.ts",
            line: 5,
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const frobnicate = wat();" }],
          }),
        ),
        // Quote matches only the dirty worktree, never the head snapshot.
        withHead(
          finding({
            id: "worktree-only",
            file: "src/a.ts",
            line: 5,
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "String(name).toUpperCase() // dirty" }],
          }),
        ),
        // Old-side deleted evidence with a valid head-side deletion anchor.
        withHead(
          finding({
            id: "old-side-deleted",
            origin: { pass: "matrix", unitId: "unit-del" },
            file: "src/del.ts",
            line: anchorOnlyOldLine as number,
            evidence: [{ file: "src/del.ts", startLine: 4, endLine: 4, quote: "  }" }],
          }),
        ),
        // Fully-deleted file: no head-side inline target can exist.
        withHead(
          finding({
            id: "deleted-file-no-target",
            origin: { pass: "matrix", unitId: "unit-del" },
            file: "src/gone.ts",
            line: 1,
            evidence: [{ file: "src/gone.ts", startLine: 1, endLine: 1, quote: "export const gone = true;" }],
          }),
        ),
        // Rename: new head-side path verified against the head snapshot.
        withHead(
          finding({
            id: "renamed",
            origin: { pass: "matrix", unitId: "unit-new" },
            file: "src/new.ts",
            line: 2,
            evidence: [{ file: "src/new.ts", startLine: 2, endLine: 2, quote: "export const legacyVersion = 2;" }],
          }),
        ),
        withHead(
          finding({
            id: "low-severity",
            file: "src/a.ts",
            line: 5,
            severity: "low",
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
          }),
        ),
        withHead(
          finding({
            id: "unknown-rule",
            file: "src/a.ts",
            line: 5,
            ruleId: "no-such-rule",
            evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
          }),
        ),
        withHead(
          finding({
            id: "dup-a",
            file: "src/a.ts",
            line: 6,
            title: "shared duplicate title",
            fingerprint: "fp-shared-dup",
            evidence: [{ file: "src/a.ts", startLine: 6, endLine: 6, quote: "return `hi $" + "{label}`;" }],
          }),
        ),
        withHead(
          finding({
            id: "dup-b",
            file: "src/a.ts",
            line: 6,
            title: "shared duplicate title",
            fingerprint: "fp-shared-dup",
            evidence: [{ file: "src/a.ts", startLine: 6, endLine: 6, quote: "return `hi $" + "{label}`;" }],
          }),
        ),
      ];

      const requested: Array<{ side: string; path: string }> = [];
      const engine = createValidationEngine({
        repoDir: dir,
        createReader: (input): ValidationSnapshotReader => {
          const real = new GitValidationSnapshotReader({
            repoDir: dir,
            headSha: input.headSha,
            mergeBase: input.mergeBase,
          });
          const record = (side: string, path: string): void => {
            requested.push({ side, path });
          };
          return {
            headSha: real.headSha,
            mergeBase: real.mergeBase,
            readHead: (path, options) => {
              record("head", path);
              return real.readHead(path, options);
            },
            readBase: (path, options) => {
              record("base", path);
              return real.readBase(path, options);
            },
            readAt: (sha, path, options) => {
              record(`at:${sha}`, path);
              return real.readAt(sha, path, options);
            },
            stats: () => real.stats(),
            clear: () => real.clear(),
          };
        },
      });
      const config = ConfigFileSchema.parse({ review: { max_findings: 50 } });
      const results = await engine.validate(items, diff, units, config);

      expect(byId(results, "good-added").status).toBe("accepted");
      expect(byId(results, "good-added").derivedAttribution).toMatchObject({
        introducedByPr: true,
        basis: { kind: "added-lines", file: "src/a.ts" },
      });
      expect(byId(results, "model-lies-true").status).toBe("inconclusive");
      expect(byId(results, "model-lies-false").status).toBe("accepted");
      expect(byId(results, "model-lies-false").derivedAttribution?.introducedByPr).toBe(true);
      expect(byId(results, "ctx-target").status).toBe("accepted");
      expect(byId(results, "bad-file").status).toBe("rejected");
      expect(codesOf(byId(results, "bad-file"))).toContain("finding_path_not_in_diff");
      expect(byId(results, "bad-path").status).toBe("rejected");
      expect(codesOf(byId(results, "bad-path"))).toContain("finding_path_invalid");
      expect(byId(results, "bad-line").status).toBe("rejected");
      expect(byId(results, "fabricated").status).toBe("rejected");
      expect(codesOf(byId(results, "fabricated"))).toContain("evidence_quote_not_found");
      expect(byId(results, "worktree-only").status).toBe("rejected");
      expect(codesOf(byId(results, "worktree-only"))).toContain("evidence_quote_not_found");
      expect(byId(results, "old-side-deleted").status).toBe("accepted");
      expect(byId(results, "old-side-deleted").derivedTarget?.kind).toBe("deletion-anchor");
      expect(byId(results, "old-side-deleted").derivedAttribution).toMatchObject({
        introducedByPr: true,
        basis: { kind: "deleted-lines" },
      });
      expect(byId(results, "deleted-file-no-target").status).toBe("rejected");
      expect(byId(results, "renamed").status).toBe("accepted");
      expect(byId(results, "low-severity").status).toBe("rejected");
      expect(codesOf(byId(results, "low-severity"))).toContain("severity_below_threshold");
      expect(byId(results, "unknown-rule").status).toBe("rejected");
      expect(codesOf(byId(results, "unknown-rule"))).toContain("rule_id_unknown");

      const dupA = byId(results, "dup-a");
      const dupB = byId(results, "dup-b");
      const acceptedDup = dupA.status === "accepted" ? dupA : dupB;
      const rejectedDup = dupA.status === "accepted" ? dupB : dupA;
      expect(acceptedDup.status).toBe("accepted");
      expect(rejectedDup.status).toBe("rejected");
      expect(codesOf(rejectedDup)).toContain("duplicate_fingerprint");
      expect(rejectedDup.duplicateOfId).toBe(acceptedDup.finding.id);
      // Winner is deterministic under input permutation (id is the final tiebreak).
      const swapped = await engine.validate([...items].reverse(), diff, units, config);
      const swappedWinner = byId(swapped, acceptedDup.finding.id);
      expect(swappedWinner.status).toBe("accepted");

      // No untrusted path ever reached a snapshot read; only exact-SHA reads.
      expect(requested.length).toBeGreaterThan(0);
      for (const entry of requested) {
        expect(entry.path.startsWith("src/")).toBe(true);
        expect(entry.path.includes("..")).toBe(false);
      }
      expect(requested.some((entry) => entry.path === "../evil.ts" || entry.path === "src/nope.ts")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });

  test("disabled category rejects with a stable code", async () => {
    const { dir, cleanup, diff } = await buildRepo();
    try {
      const fileA = changedFile(diff, "src/a.ts");
      const units = [unitFor(fileA, "unit-a")];
      const config = ConfigFileSchema.parse({ review: { categories: { security: false } } });
      const engine = createValidationEngine({ repoDir: dir });
      const results = await engine.validate(
        [
          {
            ...finding({
              id: "sec-off",
              file: "src/a.ts",
              line: 5,
              category: "security",
              evidence: [{ file: "src/a.ts", startLine: 5, endLine: 5, quote: "const label = name.toUpperCase();" }],
            }),
            headSha: diff.headSha,
          },
        ],
        diff,
        units,
        config,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("rejected");
      expect(codesOf(results[0] as ValidatedFinding)).toContain("category_disabled");
    } finally {
      await cleanup();
    }
  });

  test("max_findings caps accepted candidates deterministically", async () => {
    const { dir, cleanup, diff } = await buildRepo();
    try {
      const fileA = changedFile(diff, "src/a.ts");
      const units = [unitFor(fileA, "unit-a")];
      const config = ConfigFileSchema.parse({ review: { max_findings: 2 } });
      const engine = createValidationEngine({ repoDir: dir });
      const shape = (id: string, line: number, evidenceLine: number): Finding => ({
        ...finding({
          id,
          file: "src/a.ts",
          line,
          title: `cap finding ${id}`,
          evidence: [
            {
              file: "src/a.ts",
              startLine: evidenceLine,
              endLine: evidenceLine,
              quote: evidenceLine === 5 ? "const label = name.toUpperCase();" : "return `hi $" + "{label}`;",
            },
          ],
        }),
        headSha: diff.headSha,
      });
      const items = [shape("cap-1", 5, 5), shape("cap-2", 6, 6), shape("cap-3", 3, 5)];
      const first = await engine.validate(items, diff, units, config);
      expect(first.filter((item) => item.status === "accepted")).toHaveLength(2);
      const capped = first.filter((item) => codesOf(item).includes("max_findings_exceeded"));
      expect(capped).toHaveLength(1);
      const second = await engine.validate([...items].reverse(), diff, units, config);
      expect(byId(second, (capped[0] as ValidatedFinding).finding.id).status).toBe("rejected");
      expect(first.map((item) => `${item.finding.id}:${item.status}`).sort()).toEqual(
        second.map((item) => `${item.finding.id}:${item.status}`).sort(),
      );
    } finally {
      await cleanup();
    }
  });

  test("unreadable evidence source is inconclusive, never accepted", async () => {
    const { dir, cleanup, diff } = await buildRepo();
    try {
      const fileA = changedFile(diff, "src/a.ts");
      const unit = unitFor(fileA, "unit-a");
      const withMissingContext: ReviewUnit = {
        ...unit,
        context: [
          {
            id: "ctx-missing",
            kind: "definition",
            file: "src/missing-ctx.ts",
            startLine: 1,
            endLine: 1,
            text: "placeholder",
            score: 1,
            tokens: 1,
            reason: "matrix context",
          },
        ],
      };
      const config = ConfigFileSchema.parse({});
      const engine = createValidationEngine({ repoDir: dir });
      const results = await engine.validate(
        [
          {
            ...finding({
              id: "missing-source",
              file: "src/a.ts",
              line: 5,
              evidence: [{ file: "src/missing-ctx.ts", startLine: 1, endLine: 1, quote: "whatever" }],
            }),
            headSha: diff.headSha,
          },
        ],
        diff,
        [withMissingContext],
        config,
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("inconclusive");
      expect(codesOf(results[0] as ValidatedFinding)).toContain("evidence_unavailable");
    } finally {
      await cleanup();
    }
  });
});
