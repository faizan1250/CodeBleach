import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_IGNORE_PATHS,
  DEFAULT_MAX_FILE_SIZE_KB,
  DEFAULT_MAX_FINDINGS,
  MAX_MAX_FILE_SIZE_KB,
} from "../../src/config/defaults.ts";

describe("config schema", () => {
  test("empty object resolves to full defaults", () => {
    const config = ConfigFileSchema.parse({});
    expect(config.version).toBe(1);
    expect(config.review.enabled).toBe(true);
    expect(config.review.severity_threshold).toBe("medium");
    expect(config.review.confidence_threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(config.review.max_findings).toBe(DEFAULT_MAX_FINDINGS);
    expect(config.review.categories).toEqual({
      bugs: true,
      security: true,
      performance: false,
      concurrency: true,
    });
    expect(config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS]);
    expect(config.repository.language).toBe("typescript");
    expect(config.rules).toEqual([]);
    expect(config.path_overrides).toEqual([]);
  });

  test("accepts full config", () => {
    const config = ConfigFileSchema.parse({
      version: 1,
      review: {
        enabled: true,
        categories: { bugs: true, security: true, performance: true, concurrency: false },
        severity_threshold: "high",
        confidence_threshold: 0.7,
        category_overrides: { security: { confidence_threshold: 0.6 } },
        max_findings: 5,
        max_changed_lines_per_file: 500,
      },
      ignore: { paths: ["gen/**"] },
      repository: { language: "tsx" },
      rules: [{ id: "arch-001", kind: "architecture", text: "No logic in controllers." }],
      path_overrides: [{ paths: ["tests/**"], review: { categories: { performance: false } } }],
    });
    expect(config.rules).toHaveLength(1);
    expect(config.path_overrides).toHaveLength(1);
    expect(config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS, "gen/**"]);
  });

  test("merges user ignore paths after defaults without duplicates", () => {
    const config = ConfigFileSchema.parse({ ignore: { paths: ["dist/**", "custom/**"] } });
    expect(config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS, "custom/**"]);
  });

  test("empty user ignore paths still yield defaults", () => {
    const config = ConfigFileSchema.parse({ ignore: { paths: [] } });
    expect(config.ignore.paths).toEqual([...DEFAULT_IGNORE_PATHS]);
  });

  test("defaults ignore minified bundles", () => {
    expect(DEFAULT_IGNORE_PATHS).toContain("**/*.min.*");
    expect(ConfigFileSchema.parse({}).ignore.paths).toContain("**/*.min.*");
  });

  test("rejects unknown keys at every level", () => {
    expect(() => ConfigFileSchema.parse({ bogus: true })).toThrow();
    expect(() => ConfigFileSchema.parse({ review: { bogus: true } })).toThrow();
    expect(() =>
      ConfigFileSchema.parse({ review: { category_overrides: { bogus: {} } } }),
    ).toThrow();
  });

  test("rejects bad thresholds and limits", () => {
    expect(() => ConfigFileSchema.parse({ review: { confidence_threshold: 2 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ review: { max_findings: 0 } })).toThrow();
    expect(() =>
      ConfigFileSchema.parse({ review: { category_overrides: { bugs: { confidence_threshold: -1 } } } }),
    ).toThrow();
  });

  test("rejects duplicate rule ids and empty rule text", () => {
    const rule = { id: "dup", kind: "convention", text: "Be tidy." };
    expect(() => ConfigFileSchema.parse({ rules: [rule, rule] })).toThrow();
    expect(() =>
      ConfigFileSchema.parse({ rules: [{ id: "x", kind: "convention", text: "" }] }),
    ).toThrow();
  });

  test("rejects unsupported language and rule kind", () => {
    expect(() => ConfigFileSchema.parse({ repository: { language: "python" } })).toThrow();
    expect(() =>
      ConfigFileSchema.parse({ rules: [{ id: "x", kind: "nonsense", text: "t" }] }),
    ).toThrow();
  });

  test("max_file_size_kb defaults to 500 KB", () => {
    expect(DEFAULT_MAX_FILE_SIZE_KB).toBe(500);
    expect(ConfigFileSchema.parse({}).review.max_file_size_kb).toBe(500);
    expect(ConfigFileSchema.parse({ review: {} }).review.max_file_size_kb).toBe(500);
  });

  test("accepts custom max_file_size_kb", () => {
    const config = ConfigFileSchema.parse({ review: { max_file_size_kb: 1 } });
    expect(config.review.max_file_size_kb).toBe(1);
  });

  test("rejects non-positive max_file_size_kb", () => {
    expect(() => ConfigFileSchema.parse({ review: { max_file_size_kb: 0 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ review: { max_file_size_kb: -5 } })).toThrow();
  });

  test("max_file_size_kb accepts the 26623 KB ceiling", () => {
    expect(MAX_MAX_FILE_SIZE_KB).toBe(26623);
    expect(ConfigFileSchema.parse({ review: { max_file_size_kb: 26623 } }).review.max_file_size_kb).toBe(
      26623,
    );
    const overridden = ConfigFileSchema.parse({
      path_overrides: [{ paths: ["tests/**"], review: { max_file_size_kb: 26623 } }],
    });
    expect(overridden.path_overrides[0]?.review.max_file_size_kb).toBe(26623);
  });

  test("max_file_size_kb rejects over-max with a field-named error", () => {
    expect(() => ConfigFileSchema.parse({ review: { max_file_size_kb: 26624 } })).toThrow(
      /max_file_size_kb.*26623/,
    );
    expect(() =>
      ConfigFileSchema.parse({
        path_overrides: [{ paths: ["tests/**"], review: { max_file_size_kb: 26624 } }],
      }),
    ).toThrow(/max_file_size_kb.*26623/);
  });

  test("rejects malformed globs in every glob field", () => {
    expect(() => ConfigFileSchema.parse({ ignore: { paths: ["src/{a,b}.ts"] } })).toThrow(
      /invalid glob pattern \\"src\/\{a,b\}\.ts\\"/,
    );
    expect(() =>
      ConfigFileSchema.parse({
        rules: [{ id: "x", kind: "convention", text: "t", paths: ["src/[abc].ts"] }],
      }),
    ).toThrow(/invalid glob pattern \\"src\/\[abc\]\.ts\\"/);
    expect(() =>
      ConfigFileSchema.parse({
        path_overrides: [{ paths: ["../escape.ts"], review: {} }],
      }),
    ).toThrow(/invalid glob pattern \\"\.\.\/escape\.ts\\"/);
  });

  test("accepts supported globs in every glob field", () => {
    const config = ConfigFileSchema.parse({
      ignore: { paths: ["gen/**"] },
      rules: [{ id: "x", kind: "convention", text: "t", paths: ["src/**/*.ts"] }],
      path_overrides: [{ paths: ["tests/**"], review: {} }],
    });
    expect(config.ignore.paths).toContain("gen/**");
  });
});
