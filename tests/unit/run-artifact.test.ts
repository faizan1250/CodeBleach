import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ARTIFACT_SCHEMA_VERSION, writeArtifact, type RunArtifact } from "../../src/core/run-artifact.ts";

function artifact(): RunArtifact {
  return {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    runId: "run-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    baseSha: "base",
    headSha: "head",
    configSource: "defaults",
    status: "completed",
    stages: [{ name: "diff", status: "completed", ms: 1, count: 0 }],
    config: null,
    diff: null,
    units: [],
    contextStatus: null,
    contextDiagnostics: null,
    findings: [],
    reviewStatus: null,
    reviewPromptVersion: null,
    reviewPromptHash: null,
    reviewModel: null,
    reviewUnitsSubmitted: null,
    reviewUnitsReviewed: null,
    reviewUnitsFailed: null,
    reviewUsage: null,
    reviewDiagnostics: null,
    validated: [],
    publishResult: null,
  };
}

describe("writeArtifact", () => {
  test("writes pretty valid JSON and leaves no temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-artifact-"));
    try {
      await writeArtifact(dir, artifact());
      const text = await readFile(join(dir, "run.json"), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(text).toContain("\n  ");
      expect(JSON.parse(text)).toMatchObject({ runId: "run-1", schemaVersion: 1 });
      expect(await readdir(dir)).toEqual(["run.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("redacts nested secrets before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-artifact-"));
    try {
      await writeArtifact(dir, {
        ...artifact(),
        findings: [
          {
            id: "f1",
            fingerprint: "fp",
            headSha: "head",
            origin: { pass: "p", unitId: "u" },
            title: "t",
            severity: "high",
            category: "security",
            file: "a.ts",
            line: 1,
            description: "leaks ghp_secretABC123",
            confidence: 0.9,
            evidence: [{ file: "a.ts", startLine: 1, endLine: 1, quote: "q" }],
            introducedByPr: true,
          },
        ],
      });
      const text = await readFile(join(dir, "run.json"), "utf8");
      expect(text).not.toContain("ghp_secretABC123");
      expect(text).toContain("[REDACTED]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("redacts caller-supplied custom secrets under plain keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codebleach-artifact-"));
    const secret = "zxqv-custom-9f8e7d6c5b4a";
    try {
      await writeArtifact(
        dir,
        {
          ...artifact(),
          findings: [
            {
              id: "f1",
              fingerprint: "fp",
              headSha: "head",
              origin: { pass: "p", unitId: "u" },
              title: "t",
              severity: "high",
              category: "security",
              file: "a.ts",
              line: 1,
              description: `value is ${secret}`,
              confidence: 0.9,
              evidence: [{ file: "a.ts", startLine: 1, endLine: 1, quote: "q" }],
              introducedByPr: true,
            },
          ],
        },
        [secret],
      );
      const text = await readFile(join(dir, "run.json"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).toContain("[REDACTED]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
