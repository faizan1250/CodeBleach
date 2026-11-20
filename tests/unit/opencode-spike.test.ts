import { describe, expect, test } from "bun:test";
import {
  FIXED_MODEL_ID,
  FIXED_PROVIDER,
  HARMLESS_PROMPT,
  TRAINING_OPT_IN_ENV,
  buildSpikeHeaders,
  deriveResponsesEndpoint,
  isTrainingOptIn,
  readBaseUrl,
  readSpikeVersion,
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

  test("appends only the missing tail when base already carries the protocol stem", () => {
    expect(deriveResponsesEndpoint("https://opencode.ai/inference/go/openai/v1")).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
    expect(deriveResponsesEndpoint("https://opencode.ai/inference/go/openai/v1/")).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
  });

  test("rejects empty and non-https base urls", () => {
    expect(() => deriveResponsesEndpoint("")).toThrow();
    expect(() => deriveResponsesEndpoint("http://opencode.ai/inference/go")).toThrow();
    expect(() => deriveResponsesEndpoint("notaurl")).toThrow();
  });
});

describe("spike catalog base url", () => {
  const docsShapeCatalog = {
    [FIXED_PROVIDER]: {
      id: FIXED_PROVIDER,
      name: "OpenCode Go",
      models: {
        [FIXED_MODEL_ID]: {
          api: { responses: { base_url: "https://opencode.ai/inference/go" } },
        },
      },
    },
  };

  test("reads base_url through the provider models nesting", () => {
    expect(readBaseUrl(docsShapeCatalog)).toBe("https://opencode.ai/inference/go");
  });

  test("rejects flat model id on the provider and other malformed catalogs", () => {
    expect(() => readBaseUrl(null)).toThrow("catalog is not an object");
    expect(() => readBaseUrl({})).toThrow(`catalog lacks ${FIXED_PROVIDER} provider`);
    expect(() => readBaseUrl({ [FIXED_PROVIDER]: null })).toThrow(
      `catalog lacks ${FIXED_PROVIDER} provider`,
    );
    expect(() =>
      readBaseUrl({
        [FIXED_PROVIDER]: { [FIXED_MODEL_ID]: { api: { responses: { base_url: "https://x" } } } },
      }),
    ).toThrow(`catalog provider ${FIXED_PROVIDER} lacks models`);
    expect(() => readBaseUrl({ [FIXED_PROVIDER]: { models: {} } })).toThrow(
      "catalog model record lacks api.responses.base_url",
    );
    expect(() =>
      readBaseUrl({ [FIXED_PROVIDER]: { models: { [FIXED_MODEL_ID]: {} } } }),
    ).toThrow("catalog model record lacks api.responses.base_url");
  });
});

describe("spike version", () => {
  test("tracks package.json instead of a hardcoded copy", async () => {
    const pkg = (await Bun.file("package.json").json()) as { version: unknown };
    if (typeof pkg.version !== "string") throw new Error("package.json has no version");
    expect(await readSpikeVersion()).toBe(pkg.version);
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
