import { describe, expect, test } from "bun:test";
import {
  FIXED_MODEL_ID,
  FIXED_PROVIDER,
  HARMLESS_PROMPT,
  TRAINING_OPT_IN_ENV,
  buildSpikeHeaders,
  deriveResponsesEndpoint,
  isTrainingOptIn,
} from "../../scripts/opencode-spike.ts";

describe("spike training gate", () => {
  test("requires exact opt-in value", () => {
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "true" })).toBe(true);
    expect(isTrainingOptIn({})).toBe(false);
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "1" })).toBe(false);
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "True" })).toBe(false);
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "" })).toBe(false);
  });
});

describe("spike endpoint derivation", () => {
  test("appends responses path once and trims slashes", () => {
    expect(deriveResponsesEndpoint("https://opencode.ai/inference/go")).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
    expect(deriveResponsesEndpoint("https://opencode.ai/inference/go///")).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
    expect(deriveResponsesEndpoint("https://opencode.ai/inference/go/openai/v1/responses")).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
  });

  test("rejects empty and non-https base urls", () => {
    expect(() => deriveResponsesEndpoint("")).toThrow();
    expect(() => deriveResponsesEndpoint("http://opencode.ai/inference/go")).toThrow();
    expect(() => deriveResponsesEndpoint("notaurl")).toThrow();
  });
});

describe("spike fixed target", () => {
  test("pins direct model id without tui prefix", () => {
    expect(FIXED_MODEL_ID).toBe("muse-spark-1.3-contributor");
    expect(FIXED_PROVIDER).toBe("opencode-go");
  });

  test("headers carry session and user-agent without secrets", () => {
    const headers = buildSpikeHeaders({ sessionId: "ses_test123", version: "0.1.0" });
    expect(headers["x-opencode-session"]).toBe("ses_test123");
    expect(headers["User-Agent"]?.startsWith("codebleach/")).toBe(true);
    expect(JSON.stringify(headers)).not.toContain("Bearer");
  });

  test("harmless prompt carries no repo or secret material", () => {
    const hay = HARMLESS_PROMPT.toLowerCase();
    for (const needle of ["src/", ".env", "sk-", "AIza", "begin private", "ghp_"]) {
      expect(hay.includes(needle)).toBe(false);
    }
    expect(HARMLESS_PROMPT.length).toBeGreaterThan(0);
  });
});
