import { describe, expect, test } from "bun:test";
import { ConfigFileSchema } from "../../src/config/schema.ts";
import {
  DEFAULT_LLM_MAX_CONCURRENT_REQUESTS,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
} from "../../src/config/defaults.ts";

describe("llm config", () => {
  test("defaults to fixed-model runtime values", () => {
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBe(90000);
    expect(DEFAULT_LLM_MAX_OUTPUT_TOKENS).toBe(32768);
    expect(DEFAULT_LLM_MAX_RETRIES).toBe(2);
    expect(DEFAULT_LLM_MAX_CONCURRENT_REQUESTS).toBe(3);
    expect(DEFAULT_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS).toBe(64000);
    expect(ConfigFileSchema.parse({}).llm).toEqual({
      request_timeout_ms: 90000,
      max_output_tokens: 32768,
      max_retries: 2,
      max_concurrent_requests: 3,
      max_review_unit_input_tokens: 64000,
    });
  });

  test("accepts custom llm values within bounds", () => {
    const config = ConfigFileSchema.parse({
      llm: { request_timeout_ms: 10000, max_output_tokens: 4096, max_retries: 0 },
    });
    expect(config.llm.request_timeout_ms).toBe(10000);
    expect(config.llm.max_output_tokens).toBe(4096);
    expect(config.llm.max_retries).toBe(0);
    expect(config.llm.max_concurrent_requests).toBe(3);
  });

  test("rejects provider/model selectors and unknown llm keys", () => {
    expect(() => ConfigFileSchema.parse({ llm: { provider: "opencode-go" } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { model: "muse-spark-1.3-contributor" } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { api_family: "responses" } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { bogus: 1 } })).toThrow();
  });

  test("rejects out-of-range llm values", () => {
    expect(() => ConfigFileSchema.parse({ llm: { request_timeout_ms: 0 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { max_output_tokens: 0 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { max_retries: 99 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { max_concurrent_requests: 0 } })).toThrow();
    expect(() => ConfigFileSchema.parse({ llm: { max_review_unit_input_tokens: 10 } })).toThrow();
  });

  test("phase 1-3 configs load unchanged with llm defaults applied", () => {
    const config = ConfigFileSchema.parse({
      version: 1,
      review: { max_findings: 5 },
      repository: { language: "tsx" },
      rules: [{ id: "x", kind: "convention", text: "Be tidy." }],
    });
    expect(config.review.max_findings).toBe(5);
    expect(config.repository.language).toBe("tsx");
    expect(config.llm.max_retries).toBe(2);
  });
});
