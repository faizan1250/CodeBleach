import type { LlmProvider, LlmRequest, LlmResponse } from "./types.ts";

export interface ScriptedStep {
  match?: ((request: LlmRequest) => boolean) | undefined;
  respond: string | object | Error;
}

/** Scripted provider for tests: first matching step wins, unmatched requests fail loudly. */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly capabilities = { structuredOutput: false, streaming: false };
  readonly calls: LlmRequest[] = [];

  private readonly steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    this.steps = [...steps];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push({ ...request });
    const index = this.steps.findIndex(
      (step) => step.match === undefined || step.match(request),
    );
    if (index === -1) {
      throw new Error(`FakeProvider: no scripted step matched request to ${request.system}`);
    }
    const [step] = this.steps.splice(index, 1);
    if (step === undefined) throw new Error("FakeProvider: step vanished after match");
    if (step.respond instanceof Error) throw step.respond;
    const text = typeof step.respond === "string" ? step.respond : JSON.stringify(step.respond);
    return { text, model: "fake-model" };
  }
}
