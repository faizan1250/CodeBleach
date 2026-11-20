import { describe, expect, test } from "bun:test";
import {
  API_KEY_ENV,
  FIXED_MODEL_ID,
  OPENCODE_RESPONSES_ENDPOINT,
  TRAINING_OPT_IN_ENV,
} from "../../src/llm/constants.ts";
import { OpenCodeProvider } from "../../src/providers/opencode.ts";
import { ReviewerError } from "../../src/core/errors.ts";
import type { LlmRequest } from "../../src/providers/types.ts";

const GATE = { [TRAINING_OPT_IN_ENV]: "true", [API_KEY_ENV]: "dummy-key" };
const REQUEST: LlmRequest = { system: "review", user: "find bugs" };

function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    model: FIXED_MODEL_ID,
    status: "completed",
    output_text: "hello",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(responses: Response[]): { calls: Captured[]; fetchFn: typeof fetch } {
  const calls: Captured[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch mock exhausted");
    return next;
  }) as typeof fetch;
  return { calls, fetchFn };
}

function headersOf(call: Captured): Record<string, string> {
  return { ...(call.init.headers as Record<string, string>) };
}

function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

async function codeOf(promise: Promise<unknown>): Promise<ReviewerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    return error as ReviewerError;
  }
  throw new Error("expected ReviewerError");
}

describe("opencode provider identity", () => {
  test("exposes fixed name without structured output or streaming", () => {
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0" });
    expect(provider.name).toBe("opencode-go");
    expect(provider.capabilities).toEqual({ structuredOutput: false, streaming: false });
  });

  test("posts to the pinned responses endpoint with bearer auth", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    await provider.complete(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(OPENCODE_RESPONSES_ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    expect(headersOf(calls[0] as Captured)["Authorization"]).toBe("Bearer dummy-key");
  });

  test("sends user-agent and a stable opaque session id", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "9.9.9", fetchFn });
    await provider.complete(REQUEST);
    const headers = headersOf(calls[0] as Captured);
    expect(headers["User-Agent"]).toBe("codebleach/9.9.9");
    expect(headers["x-opencode-session"]?.startsWith("ses_")).toBe(true);
  });

  test("keeps one session id across transport retries", async () => {
    const { calls, fetchFn } = captureFetch([
      jsonResponse({ error: "busy" }, 500),
      jsonResponse(okBody()),
    ]);
    const provider = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn,
      sleep: () => Promise.resolve(),
    });
    await provider.complete(REQUEST);
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[1] as Captured)["x-opencode-session"]).toBe(
      headersOf(calls[0] as Captured)["x-opencode-session"],
    );
  });

  test("sends fixed model id with the output-token field and no tool fields", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    await provider.complete({ ...REQUEST, maxTokens: 512, jsonSchema: { type: "object" } });
    const body = bodyOf(calls[0] as Captured);
    expect(body["model"]).toBe("muse-spark-1.3-contributor");
    expect(body["max_output_tokens"]).toBe(512);
    expect(body["instructions"]).toBe("review");
    expect(body["input"]).toBe("find bugs");
    for (const key of ["tools", "tool_choice", "response_format", "text", "json_schema"]) {
      expect(body[key]).toBeUndefined();
    }
  });

  test("rejects any alternate model id before touching the network", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const err = await codeOf(provider.complete({ ...REQUEST, model: "other-model" }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("opencode provider gates", () => {
  test("blocks before fetch without the exact training opt-in", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({
      env: { [API_KEY_ENV]: "dummy-key" },
      version: "0.1.0",
      fetchFn,
    });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("blocks before fetch without an api key", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({
      env: { [TRAINING_OPT_IN_ENV]: "true" },
      version: "0.1.0",
      fetchFn,
    });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("opencode provider responses", () => {
  test("extracts output_text with usage and echoed model", async () => {
    const { fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const res = await provider.complete(REQUEST);
    expect(res.text).toBe("hello");
    expect(res.model).toBe(FIXED_MODEL_ID);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("walks the output array when output_text is absent", async () => {
    const { fetchFn } = captureFetch([
      jsonResponse({
        id: "resp_2",
        model: FIXED_MODEL_ID,
        status: "completed",
        output: [
          { type: "reasoning", content: [] },
          {
            type: "message",
            content: [
              { type: "output_text", text: "first " },
              { type: "output_text", text: "second" },
            ],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 7 },
      }),
    ]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const res = await provider.complete(REQUEST);
    expect(res.text).toBe("first second");
  });

  test("falls back to the fixed model id and unknown usage", async () => {
    const { fetchFn } = captureFetch([
      jsonResponse({ status: "completed", output_text: "hi" }),
    ]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const res = await provider.complete(REQUEST);
    expect(res.model).toBe(FIXED_MODEL_ID);
    expect(res.usage).toBeUndefined();
  });

  test("rejects completed responses without extractable text", async () => {
    const { fetchFn } = captureFetch([jsonResponse({ status: "completed", output: [] })]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    expect((await codeOf(provider.complete(REQUEST))).code).toBe("PROVIDER_BAD_OUTPUT");
  });

  test("rejects malformed json bodies", async () => {
    const { fetchFn } = captureFetch([jsonResponse("not json{{", 200)]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.code).toBe("PROVIDER_BAD_OUTPUT");
    expect(err.retryable).toBe(false);
  });

  test("refusals fail without retry", async () => {
    const { calls, fetchFn } = captureFetch([
      jsonResponse({
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      }),
    ]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.code).toBe("PROVIDER_FAILED");
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("incomplete responses fail distinctly with the reason preserved", async () => {
    const { calls, fetchFn } = captureFetch([
      jsonResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    ]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.code).toBe("PROVIDER_FAILED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("max_output_tokens");
    expect(calls).toHaveLength(1);
  });
});

describe("opencode provider retries", () => {
  test("retries 500 then succeeds within the bound", async () => {
    const { calls, fetchFn } = captureFetch([
      jsonResponse({ error: "busy" }, 500),
      jsonResponse(okBody()),
    ]);
    const provider = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn,
      sleep: () => Promise.resolve(),
    });
    expect((await provider.complete(REQUEST)).text).toBe("hello");
    expect(calls).toHaveLength(2);
  });

  test("stops after max retries on persistent 500", async () => {
    const { calls, fetchFn } = captureFetch([
      jsonResponse({ error: "x" }, 500),
      jsonResponse({ error: "x" }, 500),
      jsonResponse({ error: "x" }, 500),
      jsonResponse(okBody()),
    ]);
    const provider = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn,
      maxRetries: 2,
      sleep: () => Promise.resolve(),
    });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.code).toBe("PROVIDER_FAILED");
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test("honors retry-after on 429", async () => {
    const seen: number[] = [];
    const { calls, fetchFn } = captureFetch([
      jsonResponse({ error: "slow" }, 429, { "Retry-After": "2" }),
      jsonResponse(okBody()),
    ]);
    const provider = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn,
      sleep: (ms: number) => {
        seen.push(ms);
        return Promise.resolve();
      },
    });
    expect((await provider.complete(REQUEST)).text).toBe("hello");
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([2000]);
  });

  test("maps 400/401/403/404 without retry", async () => {
    for (const status of [400, 401, 403, 404]) {
      const { calls, fetchFn } = captureFetch([jsonResponse({ error: `e${status}` }, status)]);
      const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
      const err = await codeOf(provider.complete(REQUEST));
      expect(err.code).toBe("PROVIDER_FAILED");
      expect(err.retryable).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  test("times out requests with a retryable error", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) => new Promise<never>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
        once: true,
      });
    })) as unknown as typeof fetch;
    const provider = new OpenCodeProvider({
      env: GATE,
      version: "0.1.0",
      fetchFn: hanging,
      maxRetries: 0,
    });
    const err = await codeOf(provider.complete({ ...REQUEST, timeoutMs: 20 }));
    expect(err.code).toBe("PROVIDER_FAILED");
    expect(err.retryable).toBe(true);
  });

  test("external abort fails fast without retry", async () => {
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const err = await codeOf(provider.complete(REQUEST, controller.signal));
    expect(err.code).toBe("PROVIDER_FAILED");
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("opencode provider redaction", () => {
  test("redacts secrets pre-send across token and assignment forms", async () => {
    const slack = `${"xox"}b-123456789012-abcdefghijklmno`;
    const google = `AIzaSynthetic01234567890123456789012345`;
    const system = `key ${google} and ${slack} end`;
    const user = [
      "k sk_live_SyntheticKey123456789 end",
      "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end",
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      "auth Bearer hunter2value and Basic dXNlcjpwYXNzd29yZA== end",
      "https://x.test/cb?api_key=SECRET123&b=1",
      "MY_SECRET=hunter2 password: hunter2 OPENCODE_API_KEY=dummy-key",
    ].join("\n");
    const { calls, fetchFn } = captureFetch([jsonResponse(okBody())]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    await provider.complete({ system, user });
    const raw = String(calls[0]?.init.body);
    for (const secret of [
      google,
      slack,
      "sk_live_SyntheticKey123456789",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "MIIE",
      "hunter2value",
      "dXNlcjpwYXNzd29yZA==",
      "api_key=SECRET123",
      "hunter2",
      "dummy-key",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("[REDACTED]");
  });

  test("redacts the api key from provider error messages", async () => {
    const { fetchFn } = captureFetch([
      jsonResponse({ error: "bad key dummy-key rejected" }, 400),
    ]);
    const provider = new OpenCodeProvider({ env: GATE, version: "0.1.0", fetchFn });
    const err = await codeOf(provider.complete(REQUEST));
    expect(err.message).not.toContain("dummy-key");
  });
});
