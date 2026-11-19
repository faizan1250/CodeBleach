import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import {
  DEFAULT_MAX_PARSE_TIME_MS,
  DEFAULT_MAX_RUN_TIME_MS,
  DEFAULT_MAX_TOKENS_PER_UNIT,
  DEFAULT_MAX_TOTAL_PARSE_TIME_MS,
} from "../../src/config/defaults.ts";

describe("context time limits", () => {
  test("empty object resolves to documented defaults", () => {
    expect(DEFAULT_MAX_RUN_TIME_MS).toBe(120000);
    expect(DEFAULT_MAX_PARSE_TIME_MS).toBe(2000);
    expect(DEFAULT_MAX_TOTAL_PARSE_TIME_MS).toBe(30000);
    expect(DEFAULT_MAX_TOKENS_PER_UNIT).toBe(12000);
    const config = ConfigFileSchema.parse({});
    expect(config.context.max_run_time_ms).toBe(120000);
    expect(config.context.max_parse_time_ms).toBe(2000);
    expect(config.context.max_total_parse_time_ms).toBe(30000);
    expect(config.context.max_tokens_per_unit).toBe(12000);
  });

  test("accepts custom values within bounds", () => {
    const config = ConfigFileSchema.parse({
      context: { max_run_time_ms: 60000, max_parse_time_ms: 1000, max_total_parse_time_ms: 15000 },
    });
    expect(config.context.max_run_time_ms).toBe(60000);
    expect(config.context.max_parse_time_ms).toBe(1000);
    expect(config.context.max_total_parse_time_ms).toBe(15000);
  });

  test("rejects out-of-bounds values", () => {
    expect(() => ConfigFileSchema.parse({ context: { max_run_time_ms: 4999 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ context: { max_run_time_ms: 600001 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ context: { max_parse_time_ms: 99 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ context: { max_parse_time_ms: 30001 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ context: { max_total_parse_time_ms: 999 } })).toThrow();
    expect(() =>
      ConfigFileSchema.parse({ context: { max_total_parse_time_ms: 180001 } }),
    ).toThrow();
  });

  test("rejects unknown context keys", () => {
    expect(() => ConfigFileSchema.parse({ context: { bogus_key: 1 } })).toThrow();
  });

  test("accepts custom token budget within bounds", () => {
    expect(ConfigFileSchema.parse({ context: { max_tokens_per_unit: 1000 } }).context.max_tokens_per_unit).toBe(
      1000,
    );
    expect(ConfigFileSchema.parse({ context: { max_tokens_per_unit: 24000 } }).context.max_tokens_per_unit).toBe(
      24000,
    );
  });

  test("rejects out-of-bounds token budget", () => {
    expect(() => ConfigFileSchema.parse({ context: { max_tokens_per_unit: 999 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ context: { max_tokens_per_unit: 24001 } })).toThrow();
  });

  test("rejects parse budget exceeding cumulative budget", () => {
    expect(() =>
      ConfigFileSchema.parse({
        context: { max_parse_time_ms: 5000, max_total_parse_time_ms: 1000 },
      }),
    ).toThrow(/max_parse_time_ms.*max_total_parse_time_ms/);
  });

  test("rejects cumulative budget exceeding run budget", () => {
    expect(() =>
      ConfigFileSchema.parse({
        context: { max_total_parse_time_ms: 60000, max_run_time_ms: 50000 },
      }),
    ).toThrow(/max_total_parse_time_ms.*max_run_time_ms/);
  });
});
