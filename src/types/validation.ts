import { z } from "zod";
import type { Finding } from "./finding.ts";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string | undefined;
}

export const LlmVerdictSchema = z.strictObject({
  verdict: z.enum(["confirmed", "refuted", "inconclusive"]),
  reasoning: z.string().min(1),
});

export type LlmVerdict = z.infer<typeof LlmVerdictSchema>;

export interface ValidatedFinding {
  finding: Finding;
  status: "accepted" | "rejected" | "inconclusive";
  checks: CheckResult[];
  llmVerdict?: LlmVerdict | undefined;
}
