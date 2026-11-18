import { z } from "zod";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Category =
  | "bug"
  | "null-handling"
  | "security"
  | "concurrency"
  | "error-handling"
  | "breaking-change"
  | "resource-leak"
  | "performance"
  | "api-usage"
  | "convention";

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export const CategorySchema = z.enum([
  "bug",
  "null-handling",
  "security",
  "concurrency",
  "error-handling",
  "breaking-change",
  "resource-leak",
  "performance",
  "api-usage",
  "convention",
]);

const positiveLine = z.number().int().positive();

export const EvidenceSchema = z
  .strictObject({
    file: z.string().min(1),
    startLine: positiveLine,
    endLine: positiveLine,
    quote: z.string().min(1),
  })
  .check((ctx) => {
    if (ctx.value.endLine < ctx.value.startLine) {
      ctx.issues.push({
        code: "custom",
        message: "endLine must be >= startLine",
        input: ctx.value.endLine,
        path: ["endLine"],
      });
    }
  });

export const RawFindingSchema = z
  .strictObject({
    title: z.string().min(1).max(120),
    severity: SeveritySchema,
    category: CategorySchema,
    file: z.string().min(1),
    line: positiveLine,
    endLine: positiveLine.optional(),
    description: z.string().min(1).max(2000),
    suggestion: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceSchema).min(1),
    introducedByPr: z.boolean(),
    ruleId: z.string().optional(),
  })
  .check((ctx) => {
    const endLine = ctx.value.endLine;
    if (endLine !== undefined && endLine < ctx.value.line) {
      ctx.issues.push({
        code: "custom",
        message: "endLine must be >= line",
        input: endLine,
        path: ["endLine"],
      });
    }
  });

export const RawReviewOutputSchema = z.strictObject({
  findings: z.array(RawFindingSchema),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type RawFinding = z.infer<typeof RawFindingSchema>;
export type RawReviewOutput = z.infer<typeof RawReviewOutputSchema>;

export interface Finding extends RawFinding {
  id: string;
  fingerprint: string;
  headSha: string;
  symbol?: string | undefined;
  origin: { pass: string; unitId: string };
}
