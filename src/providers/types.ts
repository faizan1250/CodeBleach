export interface LlmRequest {
  system: string;
  user: string;
  jsonSchema?: object | undefined;
  model?: string | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface LlmResponse {
  text: string;
  parsed?: unknown;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
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
