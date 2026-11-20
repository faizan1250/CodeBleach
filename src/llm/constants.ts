import { ReviewerError } from "../core/errors.ts";

// Single fixed integration: OpenCode Go + Muse Spark 1.3 Contributor.
// There is no provider/model/endpoint/API-family fallback (ADR 0015);
// P4-02 owns the transport behind LlmProvider.
export const FIXED_PROVIDER = "opencode-go";
export const FIXED_MODEL_DISPLAY_NAME = "Muse Spark 1.3 Contributor";
export const FIXED_MODEL_ID = "muse-spark-1.3-contributor";

// Key is environment-only, never config/source/log/artifact (ADR 0016).
export const API_KEY_ENV = "OPENCODE_API_KEY";
// Exact-match opt-in; Not-ZDR model, workspace toggle stays owner-operated.
export const TRAINING_OPT_IN_ENV = "CODEBLEACH_ALLOW_MUSE_SPARK_TRAINING";

// Authenticated catalog value (GET console/api/v1/models, live 2026-11-20).
export const OPENCODE_CATALOG_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
// Same smoke, Responses path appended exactly once; only pinned value in use.
export const OPENCODE_RESPONSES_ENDPOINT = `${OPENCODE_CATALOG_BASE_URL}/responses`;

// LlmRequest.model stays for interface compatibility; any caller-supplied value
// must equal the fixed id. Anything else fails loudly, never reroutes.
export function resolveModelId(override: string | undefined): string {
  if (override === undefined || override === FIXED_MODEL_ID) return FIXED_MODEL_ID;
  throw new ReviewerError({
    code: "CONFIG_INVALID",
    message: `unsupported model override ${JSON.stringify(override)}: CodeBleach only uses ${FIXED_MODEL_ID}`,
  });
}
