import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const WORKFLOW_URL = new URL("../../.github/workflows/review.yml", import.meta.url);

// GitHub Actions expression without tripping noTemplateCurlyInString.
function expr(name: string): string {
  return ["$", "{{ ", name, " }}"].join("");
}

async function workflow(): Promise<string> {
  return readFile(WORKFLOW_URL, "utf8");
}

describe("p7-05 review workflow", () => {
  test("triggers on PR open/sync/reopen only", async () => {
    const text = await workflow();
    expect(text).toContain("pull_request:");
    expect(text).toContain("types: [opened, synchronize, reopened]");
    expect(text).not.toContain("pull_request_target");
  });

  test("keeps least-privilege permissions", async () => {
    const text = await workflow();
    expect(text).toContain("contents: read");
    expect(text).toContain("pull-requests: write");
    expect(text).not.toContain("contents: write");
    expect(text).not.toContain("issues: write");
    expect(text).not.toContain("checks: write");
    expect(text).not.toContain("actions: write");
  });

  test("skips fork and Dependabot PRs before any secret use", async () => {
    const text = await workflow();
    expect(text).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(text).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(text).toContain("github.actor != 'dependabot[bot]'");
  });

  test("pins every action to a full commit SHA, no floating tags", async () => {
    const text = await workflow();
    expect(text).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1");
    expect(text).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0");
    expect(text).toContain("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2");
    expect(text.match(/uses:[^\n]*@v\d/g)).toBeNull();
  });

  test("checks out the trusted base and never executes PR-head code", async () => {
    const text = await workflow();
    expect(text).toContain(`ref: ${expr("github.event.pull_request.base.sha")}`);
    expect(text).toContain("fetch-depth: 0");
    expect(text).toContain("persist-credentials: false");
    expect(text).toContain("bun install --frozen-lockfile");
    expect(text).toContain("bun-version-file: .bun-version");
  });

  test("passes explicit PR metadata and live secrets only to the review step", async () => {
    const text = await workflow();
    for (const name of [
      `GITHUB_TOKEN: ${expr("secrets.GITHUB_TOKEN")}`,
      `OPENCODE_API_KEY: ${expr("secrets.OPENCODE_API_KEY")}`,
      'CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING: "true"',
      `GITHUB_REPOSITORY: ${expr("github.repository")}`,
      `CODEBLEACH_PR_NUMBER: ${expr("github.event.pull_request.number")}`,
      `CODEBLEACH_BASE_SHA: ${expr("github.event.pull_request.base.sha")}`,
      `CODEBLEACH_HEAD_SHA: ${expr("github.event.pull_request.head.sha")}`,
    ]) {
      expect(text).toContain(name);
    }
    expect(text.match(/secrets\.GITHUB_TOKEN/g)?.length).toBe(1);
    expect(text.match(/secrets\.OPENCODE_API_KEY/g)?.length).toBe(1);
  });

  test("runs live publish with bounded runtime, concurrency, and artifact", async () => {
    const text = await workflow();
    expect(text).not.toContain("--dry-run");
    expect(text).not.toContain("convention-advisory");
    expect(text).toContain("timeout-minutes: 25");
    expect(text).toContain(`group: codebleach-pr-${expr("github.event.pull_request.number")}`);
    expect(text).toContain("cancel-in-progress: true");
    expect(text).toContain("path: .reviewer-out/");
    expect(text).toContain("retention-days: 7");
    expect(text).toContain("if: always()");
  });
});
