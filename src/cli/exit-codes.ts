import { ReviewerError } from "../core/errors.ts";

/**
 * Central exit-code mapping: 0 success, 1 runtime failure, 2 usage/config error.
 * `parseArgs` usage failures arrive as plain errors with an `ERR_PARSE_ARGS_*`
 * code, so they map to 2; every other non-ReviewerError failure maps to 1.
 */
export function exitCodeForError(error: unknown): number {
  if (error instanceof ReviewerError) {
    return error.code === "CONFIG_INVALID" || error.code === "CONFIG_UNSUPPORTED_VERSION" ? 2 : 1;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) return 2;
  return 1;
}
