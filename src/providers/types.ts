export interface LlmRequest {
  system: string;
  user: string;
  jsonSchema?: object | undefined;
  model?: string | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | undefined;
}

export interface LlmResponse {
  text: string;
  parsed?: unknown;
  usage?: LlmUsage | undefined;
  /** Provider-reported charge in USD; present only when the API reports it. */
  costUsd?: number | undefined;
  /** Transport retries performed inside complete() before this response. */
  retries?: number | undefined;
  model: string;
  raw?: unknown;
}

export interface LlmProvider {
  readonly name: string;
  readonly capabilities: {
    structuredOutput: boolean;
    streaming: boolean;
  };
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
