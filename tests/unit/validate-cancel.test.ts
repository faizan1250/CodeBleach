import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import type { ValidationOptions } from "../../src/core/contracts.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import type { ChangedFile, DiffResult, Finding, ReviewUnit } from "../../src/types/index.ts";
import { createValidationEngine } from "../../src/validate/engine.ts";
import { FakeValidationSnapshotReader } from "../../src/validate/snapshot.ts";
import type {
  SnapshotReadResult,
  ValidationSnapshotReader,
  ValidationSnapshotStats,
} from "../../src/validate/snapshot.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);

function testChangedFile(): ChangedFile {
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
        lines: [{ kind: "add" as const, oldLine: null, newLine: 1, position: 1, text: "line-1" }],
      },
    ],
    commentableLines: [1],
    symbols: [{ name: "render", kind: "function", startLine: 1, endLine: 10, changedLines: [1] }],
  };
}

function testUnit(): ReviewUnit {
  const file = testChangedFile();
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

function testDiff(): DiffResult {
  return { baseSha: BASE, headSha: HEAD, mergeBase: BASE, files: [testChangedFile()] };
}

function testFinding(): Finding {
  return {
    id: "finding-1",
    fingerprint: "fp-finding-1",
    headSha: HEAD,
    origin: { pass: "test", unitId: "unit-1" },
    title: "Null dereference on name",
    severity: "high",
    category: "security",
    file: "src/a.ts",
    line: 1,
    description: "name may be null at runtime.",
    confidence: 0.9,
    evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, quote: "line-1" }],
    introducedByPr: true,
  };
}

/** Location read succeeds, every later snapshot read reports aborted. */
class AbortAfterLocation implements ValidationSnapshotReader {
  readonly headSha = HEAD;
  readonly mergeBase = BASE;
  calls = 0;
  cleared = 0;

  async readHead(_path: string): Promise<SnapshotReadResult> {
    this.calls += 1;
    if (this.calls === 1) return { status: "ok", text: "line-1\n", bytes: 7 };
    return { status: "aborted", reason: "cancelled mid-run" };
  }

  async readBase(_path: string): Promise<SnapshotReadResult> {
    this.calls += 1;
    return { status: "aborted", reason: "cancelled mid-run" };
  }

  async readAt(commitSha: string, path: string): Promise<SnapshotReadResult> {
    return commitSha.toLowerCase() === this.headSha ? this.readHead(path) : this.readBase(path);
  }

  stats(): ValidationSnapshotStats {
    return { reads: this.calls, cacheHits: 0, entries: 0, cachedBytes: 0, gitCalls: 0 };
  }

  clear(): void {
    this.cleared += 1;
  }
}

describe("validation cancellation", () => {
  test("pre-aborted signal makes findings inconclusive and still clears the reader", async () => {
    const readers: FakeValidationSnapshotReader[] = [];
    const engine = createValidationEngine({
      repoDir: "/repo",
      createReader: (input) => {
        const reader = new FakeValidationSnapshotReader({
          headSha: input.headSha,
          mergeBase: input.mergeBase,
          script: { head: { "src/a.ts": { status: "ok", text: "line-1\n", bytes: 7 } } },
        });
        readers.push(reader);
        return reader;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const out = await engine.validate([testFinding()], testDiff(), [testUnit()], ConfigFileSchema.parse({}), {
      signal: controller.signal,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("inconclusive");
    expect(readers).toHaveLength(1);
    expect(readers[0]?.cleared).toBe(1);
  });

  test("abort mid-evidence is inconclusive, never accepted", async () => {
    const reader = new AbortAfterLocation();
    const engine = createValidationEngine({ repoDir: "/repo", createReader: () => reader });
    const out = await engine.validate([testFinding()], testDiff(), [testUnit()], ConfigFileSchema.parse({}), {
      signal: new AbortController().signal,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("inconclusive");
    expect(out[0]?.status).not.toBe("accepted");
    expect(out[0]?.checks.some((check) => check.code === "evidence_unavailable")).toBe(true);
    expect(reader.cleared).toBe(1);
  });

  test("pipeline forwards its signal to validation", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-cancel-"));
    const dir = join(base, "out");
    try {
      const fixture = createFixtureEngines();
      let seen: ValidationOptions | undefined;
      fixture.validation.validate = (findings, diff, units, config, options) => {
        seen = options;
        expect(findings).toHaveLength(1);
        expect(diff).toBeDefined();
        expect(units).toHaveLength(1);
        expect(config).toBeDefined();
        return Promise.resolve([]);
      };
      const controller = new AbortController();
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "cancel-passthrough" }) },
        {
          repoDir: ".",
          baseSha: "base",
          headSha: "head",
          dryRun: true,
          outDir: dir,
          runId: "cancel-passthrough",
          signal: controller.signal,
        },
      );
      expect(seen?.signal).toBe(controller.signal);
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.status).toBe("completed");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("pipeline without a signal leaves validation uncancelled", async () => {
    const base = await mkdtemp(join(tmpdir(), "codebleach-cancel-"));
    const dir = join(base, "out");
    try {
      const fixture = createFixtureEngines();
      let seen: ValidationOptions | undefined;
      fixture.validation.validate = (_findings, _diff, _units, _config, options) => {
        seen = options;
        return Promise.resolve([]);
      };
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "cancel-absent" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: true, outDir: dir, runId: "cancel-absent" },
      );
      expect(seen).toBeDefined();
      expect(seen?.signal).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
