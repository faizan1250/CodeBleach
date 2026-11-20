import { describe, expect, test } from "bun:test";
import {
  API_KEY_ENV,
  FIXED_MODEL_DISPLAY_NAME,
  FIXED_MODEL_ID,
  FIXED_PROVIDER,
  OPENCODE_CATALOG_BASE_URL,
  OPENCODE_RESPONSES_ENDPOINT,
  TRAINING_OPT_IN_ENV,
  resolveModelId,
} from "../../src/llm/constants.ts";
import {
  collectLlmSecrets,
  isTrainingOptIn,
  requireTrainingOptIn,
} from "../../src/llm/training-gate.ts";
import { ReviewerError } from "../../src/core/errors.ts";

describe("fixed model contract", () => {
  test("pins provider and direct model id without tui prefix", () => {
    expect(FIXED_PROVIDER).toBe("opencode-go");
    expect(FIXED_MODEL_ID).toBe("muse-spark-1.3-contributor");
    expect(FIXED_MODEL_ID).not.toContain("/");
    expect(FIXED_MODEL_DISPLAY_NAME).toBe("Muse Spark 1.3 Contributor");
  });

  test("pins endpoint derived from the authenticated catalog base url", () => {
    expect(OPENCODE_CATALOG_BASE_URL).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(OPENCODE_RESPONSES_ENDPOINT).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
  });

  test("uses fixed env names only", () => {
    expect(API_KEY_ENV).toBe("OPENCODE_API_KEY");
    expect(TRAINING_OPT_IN_ENV).toBe("CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING");
  });

  test("resolveModelId accepts unset and fixed id, rejects anything else", () => {
    expect(resolveModelId(undefined)).toBe(FIXED_MODEL_ID);
    expect(resolveModelId(FIXED_MODEL_ID)).toBe(FIXED_MODEL_ID);
    expect(() => resolveModelId("opencode-go/muse-spark-1.3-contributor")).toThrow(ReviewerError);
    expect(() => resolveModelId("muse-spark-1.2-contributor")).toThrow(/only uses/);
  });
});

describe("training opt-in gate", () => {
  test("requires exact opt-in value", () => {
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "true" })).toBe(true);
    expect(isTrainingOptIn({})).toBe(false);
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "1" })).toBe(false);
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "True" })).toBe(false);
    expect(isTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "" })).toBe(false);
  });

  test("requireTrainingOptIn throws non-retryable config error without opt-in", () => {
    try {
      requireTrainingOptIn({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewerError);
      const err = error as ReviewerError;
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.retryable).toBe(false);
    }
    expect(() => requireTrainingOptIn({ [TRAINING_OPT_IN_ENV]: "true" })).not.toThrow();
  });

  test("collectLlmSecrets returns key bytes only when set", () => {
    expect(collectLlmSecrets({})).toEqual([]);
    expect(collectLlmSecrets({ [API_KEY_ENV]: "" })).toEqual([]);
    expect(collectLlmSecrets({ [API_KEY_ENV]: "dummy-key" })).toEqual(["dummy-key"]);
  });
});
