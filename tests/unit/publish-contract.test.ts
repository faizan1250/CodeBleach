import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoPublisher } from "../../src/core/demo.ts";
import { createLogger } from "../../src/core/logger.ts";
import { runPipeline } from "../../src/core/pipeline.ts";
import { normalizePublishResult } from "../../src/core/run-artifact.ts";
import type { DiffResult, PrMeta, PublishRunFailureCode } from "../../src/types/index.ts";
import { createFixtureEngines } from "../fixtures/stubs.ts";

const diff: DiffResult = { files: [], baseSha: "b", headSha: "h", mergeBase: "b" };
const meta: PrMeta = { owner: "o", repo: "r", number: 1, baseSha: "b", headSha: "h" };

async function makeOutDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "codebleach-p700-"));
  const dir = join(base, "out");
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe("p7-00 publish contract", () => {
  test("producers populate required runFailures", async () => {
    const fixture = createFixtureEngines();
    await expect(demoPublisher.publish([], diff, meta)).resolves.toEqual({
      published: 0,
      skipped: 0,
      failures: [],
      runFailures: [],
    });
    await expect(fixture.publisher.publish([], diff, meta)).resolves.toMatchObject({ runFailures: [] });
    await expect(fixture.publisher.publish([], diff, meta, { reconcileStale: false })).resolves.toMatchObject({
      runFailures: [],
    });
  });

  test("closed run-failure code union covers the eleven ADR 0045 codes", () => {
    const all: PublishRunFailureCode[] = [
      "permission_denied",
      "rate_limited",
      "github_unavailable",
      "pr_closed",
      "pr_identity_mismatch",
      "stale_base_sha",
      "stale_head_sha",
      "comment_inventory_incomplete",
      "ambiguous_post_outcome",
      "reconciliation_incomplete",
      "reconciliation_skipped_incomplete_run",
    ];
    expect(new Set(all).size).toBe(11);
  });

  test("pipeline persists runFailures on publish", async () => {
    const { dir, cleanup } = await makeOutDir();
    try {
      const fixture = createFixtureEngines();
      await runPipeline(
        { ...fixture, logger: createLogger({ level: "error", runId: "p700-contract" }) },
        { repoDir: ".", baseSha: "base", headSha: "head", dryRun: false, outDir: dir, runId: "p700-contract" },
      );
      const artifact = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
      expect(artifact.publishResult).toEqual({ published: 1, skipped: 0, failures: [], runFailures: [] });
    } finally {
      await cleanup();
    }
  });

  test("legacy artifacts without runFailures normalize to []", () => {
    const legacy = JSON.parse(`{"published":1,"skipped":0,"failures":[]}`) as {
      published: number;
      skipped: number;
      failures: [];
    };
    expect(normalizePublishResult(legacy)).toEqual({ published: 1, skipped: 0, failures: [], runFailures: [] });
    expect(normalizePublishResult(null)).toBeNull();
  });

  test("existing run-level failures survive normalization", () => {
    const current = {
      published: 0,
      skipped: 0,
      failures: [],
      runFailures: [{ code: "stale_head_sha" as const, message: "head advanced before write" }],
    };
    expect(normalizePublishResult(current)).toEqual(current);
  });
});
