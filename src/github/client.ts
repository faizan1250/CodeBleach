import { Octokit } from "@octokit/rest";
import { ReviewerError } from "../core/errors.ts";
import type { PublishRunFailure } from "../types/publish.ts";

// Narrow GitHub transport seam for Phase 7 (ADR 0045). Only this module may
// import Octokit. Reads use bounded GET retries; writes (P7-03) are sent
// exactly once — no automatic retries — and classify outcomes as success,
// definitive per-comment rejection, or ambiguous application.

const GITHUB_API_BASE_URL = "https://api.github.com";
const USER_AGENT = "codebleach";
const REVIEW_COMMENTS_PER_PAGE = 100;
const REVIEW_COMMENT_MAX_PAGES = 20;
const GET_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000];
const RETRY_BACKOFF_CAP_MS = 5000;
const RETRY_WAIT_BUDGET_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Minimal shape of an Octokit/request response used by the client. */
export interface GitHubTransportResponse {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Record<string, string>;
}

/** HTTP-boundary seam; tests inject a stub, production uses one Octokit instance. */
export interface GitHubTransport {
  send(route: string, parameters: Record<string, unknown>): Promise<GitHubTransportResponse>;
}

export interface PullRequestSnapshot {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly baseSha: string;
  readonly headSha: string;
}

export interface ReviewCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly commitId: string | null;
  readonly authorLogin: string | null;
  readonly inReplyToId: number | null;
}

/** Read/write transport surface the publisher builds on. Writes are sent
 * exactly once; policy (freshness, dedupe, budgets, pacing) lives in the
 * publisher, never here. */
export interface GitHubApi {
  getPullRequest(input: { owner: string; repo: string; number: number }): Promise<PullRequestSnapshot>;
  listReviewComments(input: { owner: string; repo: string; number: number }): Promise<ReviewCommentRecord[]>;
  getAuthenticatedLogin(): Promise<string>;
  createReviewComment(input: {
    owner: string;
    repo: string;
    number: number;
    commitId: string;
    path: string;
    line: number;
    body: string;
  }): Promise<CreatedReviewComment>;
  deleteReviewComment(input: { owner: string; repo: string; commentId: number }): Promise<void>;
}

/** Identifier of a newly created review comment; the publisher pins deletes by id. */
export interface CreatedReviewComment {
  readonly id: number;
}

export interface CreateGitHubClientOptions {
  readonly token: string;
  readonly timeoutMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly transport?: GitHubTransport | undefined;
}

/** Transport failure mapped to a stable run-level code; never carries raw bodies. */
export class GitHubApiError extends ReviewerError {
  readonly status: number | undefined;
  readonly runFailure: PublishRunFailure;

  constructor(input: {
    operation: string;
    resource?: string | undefined;
    status: number | undefined;
    runFailure: PublishRunFailure;
  }) {
    const target = input.resource === undefined ? "" : ` ${input.resource}`;
    super({
      code: "GITHUB_FAILED",
      message: `github ${input.operation}${target} failed: ${input.runFailure.message ?? input.runFailure.code}`,
    });
    this.name = "GitHubApiError";
    this.status = input.status;
    this.runFailure = input.runFailure;
  }
}

/** Write outcome where the server may have applied the comment: timeout,
 * connection reset, or 5xx response. Never retried; the publisher resolves it
 * with one bounded inventory refresh. Carries no raw bodies. */
export class AmbiguousGitHubWriteError extends ReviewerError {
  readonly status: number | undefined;

  constructor(input: { operation: string; resource?: string | undefined; status: number | undefined }) {
    const target = input.resource === undefined ? "" : ` ${input.resource}`;
    super({
      code: "GITHUB_FAILED",
      message: `github ${input.operation}${target} outcome is ambiguous and must be reconciled from inventory`,
    });
    this.name = "AmbiguousGitHubWriteError";
    this.status = input.status;
  }
}

/** Definitive per-comment write rejection (422/409 and other 4xx): the
 * comment was not created. The publisher re-checks freshness once, then
 * records a bounded per-finding failure or stops. */
export class RejectedGitHubWriteError extends ReviewerError {
  readonly status: number;

  constructor(input: { operation: string; resource?: string | undefined; status: number }) {
    const target = input.resource === undefined ? "" : ` ${input.resource}`;
    super({
      code: "GITHUB_FAILED",
      message: `github ${input.operation}${target} was rejected (status ${input.status})`,
    });
    this.name = "RejectedGitHubWriteError";
    this.status = input.status;
  }
}

/** Environment boundary for the token; returns undefined when unset/blank. Never logs. */
export function resolveGitHubToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.GITHUB_TOKEN;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function createGitHubClient(options: CreateGitHubClientOptions): GitHubApi {
  const token = options.token.trim();
  if (token.length === 0) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "GITHUB_TOKEN is missing or empty; set it to a write-capable token for live publish",
    });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "github client timeout must be a positive integer of milliseconds",
    });
  }
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const transport =
    options.transport ??
    createOctokitTransport(
      new Octokit({
        auth: token,
        baseUrl: GITHUB_API_BASE_URL,
        userAgent: USER_AGENT,
        // Silent: the bundled request-log plugin would otherwise emit request
        // lines; diagnostics travel as stable codes, never log output.
        log: { debug: noop, info: noop, warn: noop, error: noop },
      }),
      timeoutMs,
    );

  return {
    getPullRequest: (input) => getPullRequest(transport, sleep, now, input),
    listReviewComments: (input) => listReviewComments(transport, sleep, now, input),
    getAuthenticatedLogin: () => getAuthenticatedLogin(transport, sleep, now),
    createReviewComment: (input) => createReviewComment(transport, input),
    deleteReviewComment: (input) => deleteReviewComment(transport, input),
  };
}

async function getPullRequest(
  transport: GitHubTransport,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  input: { owner: string; repo: string; number: number },
): Promise<PullRequestSnapshot> {
  const resource = repoResource(input);
  requireRepoIdentity(input);
  const response = await sendWithGetRetry(transport, sleep, now, {
    operation: "get pull request",
    resource,
    route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    parameters: { owner: input.owner, repo: input.repo, pull_number: input.number },
  });
  const parsed = parsePullRequest(response.data);
  return { owner: input.owner, repo: input.repo, number: input.number, ...parsed };
}

async function listReviewComments(
  transport: GitHubTransport,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  input: { owner: string; repo: string; number: number },
): Promise<ReviewCommentRecord[]> {
  const resource = repoResource(input);
  requireRepoIdentity(input);
  const collected: ReviewCommentRecord[] = [];
  for (let page = 1; page <= REVIEW_COMMENT_MAX_PAGES; page += 1) {
    const response = await sendWithGetRetry(transport, sleep, now, {
      operation: "list review comments",
      resource,
      route: "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      parameters: {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        per_page: REVIEW_COMMENTS_PER_PAGE,
        page,
      },
    });
    const items = parseCommentList(response.data);
    for (const item of items) collected.push(item);
    if (items.length < REVIEW_COMMENTS_PER_PAGE) return collected;
  }
  // A full final page may hide a next page; without a 21st request the
  // inventory state is unknowable, so fail closed rather than publish blind.
  throw new GitHubApiError({
    operation: "list review comments",
    resource,
    status: 200,
    runFailure: {
      code: "comment_inventory_incomplete",
      message: "review comment inventory exceeds the 20-page cap",
    },
  });
}

async function getAuthenticatedLogin(
  transport: GitHubTransport,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<string> {
  const response = await sendWithGetRetry(transport, sleep, now, {
    operation: "get authenticated user",
    route: "GET /user",
    parameters: {},
  });
  if (!isRecord(response.data) || typeof response.data.login !== "string" || response.data.login.length === 0) {
    throw new ReviewerError({ code: "INTERNAL", message: "github user response had an unexpected shape" });
  }
  return response.data.login;
}

async function createReviewComment(
  transport: GitHubTransport,
  input: { owner: string; repo: string; number: number; commitId: string; path: string; line: number; body: string },
): Promise<CreatedReviewComment> {
  const resource = repoResource(input);
  requireRepoIdentity(input);
  const response = await sendWrite(transport, {
    operation: "create review comment",
    resource,
    route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    parameters: {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.number,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
      side: "RIGHT",
      body: input.body,
    },
  });
  if (!isRecord(response.data) || typeof response.data.id !== "number" || !Number.isSafeInteger(response.data.id)) {
    // A 2xx without a usable id: the server may have applied the comment, so
    // resolve through the ambiguous path rather than claiming success or failure.
    throw new AmbiguousGitHubWriteError({ operation: "create review comment", resource, status: response.status });
  }
  return { id: response.data.id };
}

async function deleteReviewComment(
  transport: GitHubTransport,
  input: { owner: string; repo: string; commentId: number },
): Promise<void> {
  if (input.owner.length === 0 || input.repo.length === 0 || !Number.isSafeInteger(input.commentId)) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "github client requires a non-empty owner/repo and an integer comment id for deletion",
    });
  }
  const resource = `${input.owner}/${input.repo}#comment-${input.commentId}`;
  try {
    await sendWrite(transport, {
      operation: "delete review comment",
      resource,
      route: "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}",
      parameters: { owner: input.owner, repo: input.repo, comment_id: input.commentId },
    });
  } catch (error) {
    // Deleting an already-absent comment is the desired end state.
    if (error instanceof GitHubApiError && error.status === 404) return;
    throw error;
  }
}

interface WriteOperation {
  operation: string;
  resource?: string | undefined;
  route: string;
  parameters: Record<string, unknown>;
}

/** Single-shot write send: exactly one transport call, never retried. Maps
 * transport failures to ambiguous (may have applied), definitive rejection,
 * or stable run-level errors. */
async function sendWrite(transport: GitHubTransport, op: WriteOperation): Promise<GitHubTransportResponse> {
  try {
    return await transport.send(op.route, op.parameters);
  } catch (error) {
    const status = readStatus(error);
    const headers = readHeaders(error);
    if (isAbortError(error) || status === undefined || status >= 500) {
      throw new AmbiguousGitHubWriteError({ operation: op.operation, resource: op.resource, status });
    }
    if (status === 401) {
      throw new GitHubApiError({
        operation: op.operation,
        resource: op.resource,
        status,
        runFailure: {
          code: "permission_denied",
          message: "github token is invalid or lacks pull-request write permission",
        },
      });
    }
    if (status === 403 && !isRateLimitResponse(headers)) {
      throw new GitHubApiError({
        operation: op.operation,
        resource: op.resource,
        status,
        runFailure: {
          code: "permission_denied",
          message: "github token is invalid or lacks pull-request write permission",
        },
      });
    }
    if (status === 404) {
      throw new GitHubApiError({
        operation: op.operation,
        resource: op.resource,
        status,
        runFailure: {
          code: "pr_identity_mismatch",
          message: "pull request or review comment was not found for the given owner, repository, and number",
        },
      });
    }
    if (status === 429 || (status === 403 && isRateLimitResponse(headers))) {
      throw new GitHubApiError({
        operation: op.operation,
        resource: op.resource,
        status,
        runFailure: { code: "rate_limited", message: "github rate limit reached; no write was retried" },
      });
    }
    throw new RejectedGitHubWriteError({ operation: op.operation, resource: op.resource, status });
  }
}

interface GetOperation {
  operation: string;
  resource?: string | undefined;
  route: string;
  parameters: Record<string, unknown>;
}

async function sendWithGetRetry(
  transport: GitHubTransport,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  op: GetOperation,
): Promise<GitHubTransportResponse> {
  let waitedMs = 0;
  for (let attempt = 1; attempt <= GET_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await transport.send(op.route, op.parameters);
    } catch (error) {
      const status = readStatus(error);
      const headers = readHeaders(error);
      if (!isRetryableGetError(error, status, headers) || attempt === GET_MAX_ATTEMPTS) {
        throw toGitHubApiError(op, status, classifyTransportError(status, headers));
      }
      const waitMs = computeWaitMs(status, headers, attempt, now());
      if (waitMs === undefined || waitedMs + waitMs > RETRY_WAIT_BUDGET_MS) {
        throw toGitHubApiError(op, status, classifyTransportError(status, headers));
      }
      waitedMs += waitMs;
      if (waitMs > 0) await sleep(waitMs);
    }
  }
  throw new ReviewerError({ code: "INTERNAL", message: "github retry loop exited without a result" });
}

function toGitHubApiError(op: GetOperation, status: number | undefined, runFailure: PublishRunFailure): GitHubApiError {
  return new GitHubApiError({ operation: op.operation, resource: op.resource, status, runFailure });
}

function classifyTransportError(status: number | undefined, headers: Record<string, string>): PublishRunFailure {
  if (status === 401) {
    return { code: "permission_denied", message: "github token is invalid or lacks pull-request read permission" };
  }
  if (status === 403 && !isRateLimitResponse(headers)) {
    return { code: "permission_denied", message: "github token is invalid or lacks pull-request read permission" };
  }
  if (status === 404) {
    return {
      code: "pr_identity_mismatch",
      message: "pull request was not found for the given owner, repository, and number",
    };
  }
  if (status === 429 || status === 403) {
    return { code: "rate_limited", message: "github rate limit reached and the retry wait budget is exhausted" };
  }
  return { code: "github_unavailable", message: "github api is temporarily unavailable" };
}

function isRetryableGetError(error: unknown, status: number | undefined, headers: Record<string, string>): boolean {
  if (isAbortError(error) || status === undefined) return true;
  if (status === 502 || status === 503 || status === 504 || status === 429) return true;
  return status === 403 && isRateLimitResponse(headers);
}

// Secondary limits arrive as 403/429 with Retry-After; primary limits expose a
// zero remaining quota or a reset timestamp. Anything else 403 is permissions.
function isRateLimitResponse(headers: Record<string, string>): boolean {
  return headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0";
}

function computeWaitMs(
  status: number | undefined,
  headers: Record<string, string>,
  attempt: number,
  nowMs: number,
): number | undefined {
  const retryAfter = parseSeconds(headers["retry-after"]);
  if (retryAfter !== undefined) return Math.round(retryAfter * 1000);
  if (status === 429 || status === 403) {
    const reset = parseSeconds(headers["x-ratelimit-reset"]);
    if (reset !== undefined) return Math.max(0, Math.round(reset * 1000 - nowMs));
  }
  const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_CAP_MS;
  return Math.min(backoff, RETRY_BACKOFF_CAP_MS);
}

function parseSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePullRequest(data: unknown): { state: "open" | "closed"; baseSha: string; headSha: string } {
  if (!isRecord(data)) failShape("github pull-request response had an unexpected shape");
  const state = data.state;
  if (state !== "open" && state !== "closed") failShape("github pull-request response had an unexpected shape");
  const baseSha = isRecord(data.base) ? data.base.sha : undefined;
  const headSha = isRecord(data.head) ? data.head.sha : undefined;
  if (typeof baseSha !== "string" || baseSha.length === 0 || typeof headSha !== "string" || headSha.length === 0) {
    failShape("github pull-request response had an unexpected shape");
  }
  return { state, baseSha, headSha };
}

function parseCommentList(data: unknown): ReviewCommentRecord[] {
  if (!Array.isArray(data)) failShape("github review-comment response had an unexpected shape");
  return data.map((item) => parseCommentItem(item));
}

function parseCommentItem(item: unknown): ReviewCommentRecord {
  if (!isRecord(item)) failShape("github review-comment item had an unexpected shape");
  const id = item.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    failShape("github review-comment item had an unexpected shape");
  }
  return {
    id,
    body: typeof item.body === "string" ? item.body : "",
    path: asNullableString(item.path),
    line: asNullableInt(item.line),
    commitId: asNullableString(item.commit_id),
    authorLogin: isRecord(item.user) && typeof item.user.login === "string" ? item.user.login : null,
    inReplyToId: asNullableInt(item.in_reply_to_id),
  };
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return failShape("github review-comment item had an unexpected shape");
}

function asNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return failShape("github review-comment item had an unexpected shape");
}

function failShape(message: string): never {
  throw new ReviewerError({ code: "INTERNAL", message });
}

function requireRepoIdentity(input: { owner: string; repo: string; number: number }): void {
  if (input.owner.length === 0 || input.repo.length === 0 || !Number.isSafeInteger(input.number) || input.number < 1) {
    throw new ReviewerError({
      code: "CONFIG_INVALID",
      message: "github client requires a non-empty owner/repo and a positive pull-request number",
    });
  }
}

function repoResource(input: { owner: string; repo: string; number: number }): string {
  return `${input.owner}/${input.repo}#${input.number}`;
}

function readStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function readHeaders(error: unknown): Record<string, string> {
  if (!isRecord(error) || !isRecord(error.headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(error.headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createOctokitTransport(octokit: Octokit, timeoutMs: number): GitHubTransport {
  return {
    send: async (route, parameters) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await octokit.request(route, { ...parameters, request: { signal: controller.signal } });
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        return { status: response.status, data: response.data, headers };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function noop(_message: string): unknown {
  return undefined;
}
