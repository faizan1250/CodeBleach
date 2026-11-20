// P4-00 spike harness (manual only, never CI).
// Derives the Responses endpoint ONLY from the authenticated catalog's
// api.responses.base_url after a live generic smoke succeeds. Nothing here is
// imported by src/; the production endpoint constant stays unset until then.
export const FIXED_PROVIDER = "opencode-go";
export const FIXED_MODEL_ID = "muse-spark-1.3-contributor";
export const TRAINING_OPT_IN_ENV = "CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING";
export const API_KEY_ENV = "OPENCODE_API_KEY";
export const AUTH_CATALOG_URL = "https://opencode.ai/console/api/v1/models";

// Tiny generic prompt: no repo paths, source, secrets, or private data.
// Its completion may still train future models per the Not-ZDR terms.
export const HARMLESS_PROMPT = "Reply with exactly the two words: spike ok";

export function isTrainingOptIn(env: Record<string, string | undefined> = {}): boolean {
  return env[TRAINING_OPT_IN_ENV] === "true";
}

// Appends the Responses path exactly once. Rejects empty/non-https input;
// the caller must supply base_url from the authenticated model record.
export function deriveResponsesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new Error("empty base_url");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("base_url is not a URL");
  }
  if (parsed.protocol !== "https:") throw new Error("base_url must be https");
  const suffix = "/openai/v1/responses";
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

export function mintSessionId(): string {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Diagnostic headers only: Authorization is attached at send time, never logged.
export function buildSpikeHeaders(input: { sessionId: string; version: string }): Record<string, string> {
  if (input.sessionId.length === 0) throw new Error("sessionId required");
  return {
    "Content-Type": "application/json",
    "User-Agent": `codebleach/${input.version}`,
    "x-opencode-session": input.sessionId,
  };
}

interface CatalogModel {
  api?: { responses?: { base_url?: unknown } };
}

function readBaseUrl(catalog: unknown): string {
  if (typeof catalog !== "object" || catalog === null) throw new Error("catalog is not an object");
  const models = (catalog as Record<string, unknown>)["opencode-go"];
  if (typeof models !== "object" || models === null) throw new Error("catalog lacks opencode-go provider");
  const entry = (models as Record<string, unknown>)[FIXED_MODEL_ID] as CatalogModel | undefined;
  const baseUrl = entry?.api?.responses?.base_url;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("catalog model record lacks api.responses.base_url");
  }
  return baseUrl;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`request failed: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

if (import.meta.main) {
  const env = Bun.env;
  if (!isTrainingOptIn(env)) {
    console.error(
      `[spike] refused: set ${TRAINING_OPT_IN_ENV}=true first (Not-ZDR: prompts/completions may train future models)`,
    );
    process.exit(2);
  }
  const apiKey = env[API_KEY_ENV];
  if (!apiKey) {
    console.error(`[spike] refused: ${API_KEY_ENV} is unset`);
    process.exit(2);
  }
  const sessionId = mintSessionId();
  const headers: Record<string, string> = {
    ...buildSpikeHeaders({ sessionId, version: "0.1.0" }),
    Authorization: "Bearer [REDACTED]",
  };
  console.error(`[spike] catalog: GET ${AUTH_CATALOG_URL}`);
  console.error(`[spike] headers: ${JSON.stringify({ ...headers, Authorization: "[REDACTED]" })}`);
  const catalog = await fetchJson(
    AUTH_CATALOG_URL,
    { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": headers["User-Agent"] ?? "" } },
    30_000,
  );
  const endpoint = deriveResponsesEndpoint(readBaseUrl(catalog));
  console.error(`[spike] derived endpoint: ${endpoint} (unpinned until generic smoke succeeds)`);
  const body = JSON.stringify({
    model: FIXED_MODEL_ID,
    input: HARMLESS_PROMPT,
    max_output_tokens: 64,
  });
  const out = await fetchJson(endpoint, { method: "POST", headers: { ...headers, Authorization: `Bearer ${apiKey}` }, body }, 90_000);
  const redacted = JSON.stringify(out).slice(0, 500);
  console.error(`[spike] response (truncated, redacted): ${redacted}`);
  console.log(JSON.stringify({ ok: true, endpoint, sessionHeaderSent: true }));
}
