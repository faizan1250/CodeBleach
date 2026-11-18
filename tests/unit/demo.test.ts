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

    const units = await demoContextEngine.build(diff, config, ".");
    expect(units).toHaveLength(1);
    expect(units[0]?.file.path).toBe(diff.files[0]?.path);

    const findings = await demoReviewEngine.review(units, config);
    expect(findings).toHaveLength(2);

    const validated = await demoValidationEngine.validate(findings, diff, units, config);
    expect(validated.filter((v) => v.status === "accepted")).toHaveLength(1);

    const result = await demoPublisher.publish(
      validated,
      diff,
      { owner: "o", repo: "r", number: 1, baseSha: DEMO_BASE_SHA, headSha: DEMO_HEAD_SHA },
    );
    expect(result.published).toBe(1);
    expect(result.failures).toEqual([]);
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
});
