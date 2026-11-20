import { z } from "zod";
import { ReviewerError } from "../core/errors.ts";
import type { LlmProvider, LlmRequest } from "./types.ts";

const FENCED_BLOCK = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;

// Bound the untrusted snippets appended to a repair request; the original
// request payload is resent intact so the model keeps full context.
const REPAIR_ERROR_CHARS = 2000;
const REPAIR_RESPONSE_CHARS = 4000;

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

/** Strip a Markdown fence only when it wraps the entire response. */
function unfence(text: string): string {
  return text.match(FENCED_BLOCK)?.[1] ?? text;
}

function tryParseJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) as unknown };
  } catch {
    return { parsed: false };
  }
}

function badOutput(message: string, cause?: unknown): ReviewerError {
  return new ReviewerError({
    code: "PROVIDER_BAD_OUTPUT",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Parse provider text as JSON and validate it. Never trusts `response.parsed`.
 * One repair retry with the original text plus validation errors, then gives up.
 */
export async function completeJson<T>(
  provider: LlmProvider,
  request: LlmRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const first = await provider.complete(request);
  const attempt = tryParseJson(unfence(first.text));
  if (attempt.parsed) {
    const validated = schema.safeParse(attempt.value);
    if (validated.success) return validated.data;
    return repair(provider, request, schema, first.text, describeIssues(validated.error));
  }
  return repair(provider, request, schema, first.text, "response was not valid JSON");
}

async function repair<T>(
  provider: LlmProvider,
  request: LlmRequest,
  schema: z.ZodType<T>,
  originalText: string,
  errorText: string,
): Promise<T> {
  const retry = await provider.complete({
    ...request,
    user:
      `${request.user}\n\nThe previous response was invalid. ` +
      `Fix it and reply with valid JSON only.\n\n` +
      `Errors:\n${truncateSnippet(errorText, REPAIR_ERROR_CHARS)}\n\nInvalid response:\n${truncateSnippet(originalText, REPAIR_RESPONSE_CHARS)}`,
  });
  const attempt = tryParseJson(unfence(retry.text));
  if (!attempt.parsed) {
    throw badOutput("provider returned invalid JSON twice");
  }
  const validated = schema.safeParse(attempt.value);
  if (!validated.success) {
    throw badOutput(
      `provider response failed schema validation twice: ${describeIssues(validated.error)}`,
    );
  }
  return validated.data;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
