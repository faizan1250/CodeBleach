import { describe, expect, test } from "bun:test";
import {
  DEMO_BASE_SHA,
  DEMO_HEAD_SHA,
  demoContextEngine,
  demoDiffEngine,
  demoPublisher,
  demoReviewEngine,
  demoValidationEngine,
} from "../../src/core/demo.ts";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import { isAcceptedFinding } from "../../src/core/contracts.ts";

const config = ConfigFileSchema.parse({});

describe("demo engines", () => {
  test("produces one file, one unit, two findings, one accepted", async () => {
    const diff = await demoDiffEngine.run({
      repoDir: ".",
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
      config,
    });
    expect(diff.files).toHaveLength(1);
    expect(diff.baseSha).toBe(DEMO_BASE_SHA);

    const built = await demoContextEngine.build(diff, config, ".");
    expect(built.status).toBe("complete");
    const units = built.units;
    expect(units).toHaveLength(1);
    expect(units[0]?.file.path).toBe(diff.files[0]?.path);
    expect(units[0]?.file.commentableLines).toEqual(diff.files[0]?.commentableLines);
    expect(units[0]?.symbol).toBe(diff.files[0]?.symbols[0]);

    const findings = (await demoReviewEngine.review(units, config)).findings;
    expect(findings).toHaveLength(2);

    const validated = await demoValidationEngine.validate(findings, diff, units, config);
    expect(validated.filter((v) => v.status === "accepted")).toHaveLength(1);
    expect(validated[0]?.finding).toBe(findings[0]);

    const result = await demoPublisher.publish(validated.filter(isAcceptedFinding), diff, {
      owner: "o",
      repo: "r",
      number: 1,
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
    });
    expect(result.published).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("demo accepted findings carry the complete publish invariant", async () => {
    const diff = await demoDiffEngine.run({
      repoDir: ".",
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
      config,
    });
    const built = await demoContextEngine.build(diff, config, ".");
    const findings = (await demoReviewEngine.review(built.units, config)).findings;
    const validated = await demoValidationEngine.validate(findings, diff, built.units, config);
    const accepted = validated.filter((v) => v.status === "accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted.filter(isAcceptedFinding)).toHaveLength(1);
  });

  test("dataset is stable across runs", async () => {
    const first = await demoDiffEngine.run({
      repoDir: ".",
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
      config,
    });
    const second = await demoDiffEngine.run({
      repoDir: ".",
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
      config,
    });
    expect(second).toEqual(first);
  });

  test("accepted evidence quote is present, rejected evidence quote is absent", async () => {
    const diff = await demoDiffEngine.run({
      repoDir: ".",
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
      config,
    });
    const lines = diff.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((l) => l.text)));
    const built = await demoContextEngine.build(diff, config, ".");
    const units = built.units;
    const findings = (await demoReviewEngine.review(units, config)).findings;
    const validated = await demoValidationEngine.validate(findings, diff, units, config);
    const accepted = validated.filter((v) => v.status === "accepted");
    const rejected = validated.filter((v) => v.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    for (const v of accepted) {
      for (const evidence of v.finding.evidence) {
        expect(lines.some((line) => line.includes(evidence.quote))).toBe(true);
      }
    }
    for (const v of rejected) {
      expect(v.checks).toContainEqual({
        name: "evidence",
        outcome: "failed",
        code: "evidence_quote_not_found",
        detail: "quote not found in context",
      });
      for (const evidence of v.finding.evidence) {
        expect(lines.some((line) => line.includes(evidence.quote))).toBe(false);
      }
    }
  });

  test("accepted findings are introduced by the PR on added lines", async () => {
    const diff = await demoDiffEngine.run({
      repoDir: ".",
      baseSha: DEMO_BASE_SHA,
      headSha: DEMO_HEAD_SHA,
      config,
    });
    const built = await demoContextEngine.build(diff, config, ".");
    const units = built.units;
    const findings = (await demoReviewEngine.review(units, config)).findings;
    const validated = await demoValidationEngine.validate(findings, diff, units, config);
    const addedByFile = new Map(
      diff.files.map((file) => [
        file.path,
        new Set(file.hunks.flatMap((hunk) => hunk.lines.filter((l) => l.kind === "add").map((l) => l.newLine))),
      ]),
    );
    const addTexts = diff.files.flatMap((file) =>
      file.hunks.flatMap((hunk) => hunk.lines.filter((l) => l.kind === "add").map((l) => l.text)),
    );
    for (const v of validated.filter((item) => item.status === "accepted")) {
      expect(v.finding.introducedByPr).toBe(true);
      expect(addedByFile.get(v.finding.file)?.has(v.finding.line)).toBe(true);
      for (const evidence of v.finding.evidence) {
        expect(addTexts.some((text) => text.includes(evidence.quote))).toBe(true);
      }
    }
  });
});
