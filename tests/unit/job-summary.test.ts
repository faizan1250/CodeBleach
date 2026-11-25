import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  parseRunArtifact,
  renderSummaryMarkdown,
  selectAnnotation,
  writeJobSummary,
} from "../../scripts/job-summary.ts";

const HEAD_SHA = "a".repeat(40);

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headSha: HEAD_SHA,
    status: "completed",
    validationSummary: {
      total: 3,
      accepted: 1,
      rejected: 1,
      inconclusive: 1,
      duplicates: 0,
      policyFiltered: 0,
      checksSkipped: 0,
    },
    publishResult: { published: 1, skipped: 0, failures: [], runFailures: [] },
    ...overrides,
  };
}

describe("job-summary parse", () => {
  test("reads counts, short head, and empty run failures", () => {
    const data = parseRunArtifact(artifact());
    expect(data?.headShort).toBe("a".repeat(7));
    expect(data?.validation).toEqual({ total: 3, accepted: 1, rejected: 1, inconclusive: 1 });
    expect(data?.publish).toEqual({ published: 1, skipped: 0, perFindingFailures: 0 });
    expect(data?.runFailureCodes).toEqual([]);
    expect(data?.errorCode).toBeNull();
  });

  test("reports validation when publish did not run", () => {
    const data = parseRunArtifact(artifact({ headSha: "demo-head", publishResult: null }));
    expect(data?.headShort).toBe("unknown");
    expect(data?.validation).toEqual({ total: 3, accepted: 1, rejected: 1, inconclusive: 1 });
    expect(data?.publish).toBeNull();
    const markdown = renderSummaryMarkdown(data);
    expect(markdown).toContain("1 accepted");
    expect(markdown).toContain("publish: did not run");
    expect(selectAnnotation(data)).toBeNull();
  });

  test("rejects top-level garbage", () => {
    expect(parseRunArtifact(null)).toBeNull();
    expect(parseRunArtifact("nope")).toBeNull();
    expect(parseRunArtifact(42)).toBeNull();
  });

  test("normalizes legacy publish result without runFailures", () => {
    const data = parseRunArtifact(artifact({ publishResult: { published: 0, skipped: 2, failures: [] } }));
    expect(data?.runFailureCodes).toEqual([]);
    expect(data?.publish?.skipped).toBe(2);
  });

  test("drops forged run-failure codes and non-hex SHAs", () => {
    const data = parseRunArtifact(
      artifact({
        headSha: "pull/1/head",
        publishResult: {
          published: 0,
          skipped: 0,
          failures: [],
          runFailures: [{ code: "rate_limited" }, { code: "stale_head_sha\n::error::pwned" }],
        },
      }),
    );
    expect(data?.headShort).toBe("unknown");
    expect(data?.runFailureCodes).toEqual(["rate_limited"]);
  });

  test("tolerates malformed publish shapes without throwing", () => {
    const data = parseRunArtifact(
      artifact({ publishResult: { published: "many", skipped: 0, failures: "x", runFailures: [null, "junk"] } }),
    );
    expect(data?.publish).toBeNull();
    expect(data?.validation?.accepted).toBe(1);
    expect(data?.runFailureCodes).toEqual([]);
    expect(renderSummaryMarkdown(data)).toContain("publish: did not run");
    expect(selectAnnotation(data)).toBeNull();
  });

  test("keeps validated error codes only", () => {
    expect(parseRunArtifact(artifact({ error: { code: "CONFIG_INVALID" } }))?.errorCode).toBe("CONFIG_INVALID");
    expect(parseRunArtifact(artifact({ error: { code: "::error::pwned" } }))?.errorCode).toBeNull();
    expect(parseRunArtifact(artifact())?.errorCode).toBeNull();
  });
});

describe("job-summary render", () => {
  test("summarizes a clean run with no annotation", () => {
    const data = parseRunArtifact(artifact());
    const markdown = renderSummaryMarkdown(data);
    expect(markdown).toContain("`aaaaaaa`");
    expect(markdown).toContain("1 accepted");
    expect(markdown).toContain("1 published");
    expect(markdown).toContain("run failures: none");
    expect(selectAnnotation(data)).toBeNull();
  });

  test("states incompleteness and warns on publish failures", () => {
    const data = parseRunArtifact(
      artifact({
        publishResult: {
          published: 1,
          skipped: 0,
          failures: [{ file: "a.ts", line: 1, reason: "marker_key_collision" }],
          runFailures: [{ code: "stale_head_sha" }],
        },
      }),
    );
    const markdown = renderSummaryMarkdown(data);
    expect(markdown).toContain("publishing was incomplete");
    expect(markdown).toContain("stale_head_sha");
    const annotation = selectAnnotation(data);
    expect(annotation?.level).toBe("warning");
    expect(annotation?.message).toContain("stale_head_sha");
  });

  test("errors only on invalid config or internal defects", () => {
    expect(selectAnnotation(parseRunArtifact(artifact({ error: { code: "CONFIG_INVALID" } })))?.level).toBe("error");
    expect(selectAnnotation(parseRunArtifact(artifact({ error: { code: "INTERNAL" } })))?.level).toBe("error");
    expect(selectAnnotation(parseRunArtifact(artifact({ error: { code: "GITHUB_FAILED" } })))?.level).toBe("warning");
    expect(selectAnnotation(parseRunArtifact(artifact({ error: { code: "PROVIDER_FAILED" } })))?.level).toBe("warning");
  });

  test("missing artifact renders unavailable with a warning", () => {
    expect(renderSummaryMarkdown(null)).toContain("missing or unparsable");
    const annotation = selectAnnotation(null);
    expect(annotation?.level).toBe("warning");
    expect(annotation?.message).not.toContain("::");
  });
});

describe("job-summary write", () => {
  test("appends markdown to the summary file and logs one annotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cb-summary-"));
    const artifactPath = join(dir, "run.json");
    const summaryPath = join(dir, "summary.md");
    await writeFile(artifactPath, JSON.stringify(artifact()), "utf8");
    const logged: string[] = [];
    const code = await writeJobSummary({ artifactPath, summaryPath, log: (message) => logged.push(message) });
    expect(code).toBe(0);
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("## CodeBleach review summary");
    expect(logged).toEqual([]);
  });

  test("missing artifact still exits 0 with a static warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cb-summary-"));
    const summaryPath = join(dir, "summary.md");
    const logged: string[] = [];
    const code = await writeJobSummary({
      artifactPath: join(dir, "absent.json"),
      summaryPath,
      log: (message) => logged.push(message),
    });
    expect(code).toBe(0);
    expect(await readFile(summaryPath, "utf8")).toContain("missing or unparsable");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toStartWith("::warning::");
  });

  test("unknown CLI flags still exit 0 without failing the job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cb-summary-"));
    const summaryPath = join(dir, "summary.md");
    const code = await main(["--bogus-flag"], { GITHUB_STEP_SUMMARY: summaryPath });
    expect(code).toBe(0);
    // Falls back to the default artifact path: either renders it or reports
    // it missing — but never throws, never fails the job.
    expect(await readFile(summaryPath, "utf8")).toContain("## CodeBleach review summary");
  });
});
