export type ErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_UNSUPPORTED_VERSION"
  | "GIT_FAILED"
  | "PARSE_FAILED"
  | "PROVIDER_FAILED"
  | "PROVIDER_BAD_OUTPUT"
  | "GITHUB_FAILED"
  | "NOT_IMPLEMENTED"
  | "INTERNAL";

export class ReviewerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(input: { code: ErrorCode; message: string; retryable?: boolean; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ReviewerError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
  }
}
