import { z } from "zod";
import { SeveritySchema } from "../types/finding.ts";
import { RULE_KINDS } from "../types/rules.ts";
import { isValidGlobPattern } from "../utils/glob.ts";
import {
  CONFIG_VERSION,
  DEFAULT_CATEGORIES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_ENABLED,
  DEFAULT_LANGUAGE,
  DEFAULT_LLM_MAX_CONCURRENT_REQUESTS,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_LLM_REVIEW_TIMEOUT_MS,
  DEFAULT_MAX_CHANGED_LINES_PER_FILE,
  DEFAULT_MAX_FILE_SIZE_KB,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MAX_PARSE_TIME_MS,
  DEFAULT_MAX_RUN_TIME_MS,
  DEFAULT_MAX_TOKENS_PER_UNIT,
  DEFAULT_MAX_TOTAL_PARSE_TIME_MS,
  DEFAULT_SEVERITY_THRESHOLD,
  MAX_LLM_MAX_CONCURRENT_REQUESTS,
  MAX_LLM_MAX_OUTPUT_TOKENS,
  MAX_LLM_MAX_RETRIES,
  MAX_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS,
  MAX_LLM_REQUEST_TIMEOUT_MS,
  MAX_LLM_REVIEW_TIMEOUT_MS,
  MAX_MAX_FILE_SIZE_KB,
  MAX_MAX_PARSE_TIME_MS,
  MAX_MAX_RUN_TIME_MS,
  MAX_MAX_TOKENS_PER_UNIT,
  MAX_MAX_TOTAL_PARSE_TIME_MS,
  MIN_LLM_MAX_CONCURRENT_REQUESTS,
  MIN_LLM_MAX_OUTPUT_TOKENS,
  MIN_LLM_MAX_RETRIES,
  MIN_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS,
  MIN_LLM_REQUEST_TIMEOUT_MS,
  MIN_LLM_REVIEW_TIMEOUT_MS,
  MIN_MAX_PARSE_TIME_MS,
  MIN_MAX_RUN_TIME_MS,
  MIN_MAX_TOKENS_PER_UNIT,
  MIN_MAX_TOTAL_PARSE_TIME_MS,
  mergeIgnorePaths,
} from "./defaults.ts";
import { CONTEXT_SAFETY_MARGIN_TOKENS, MODEL_CONTEXT_TOKENS } from "../llm/limits.ts";

export const LANGUAGES = ["typescript", "tsx", "javascript"] as const;

const GlobPatternSchema = z
  .string()
  .min(1)
  .check((ctx) => {
    if (!isValidGlobPattern(ctx.value)) {
      ctx.issues.push({
        code: "custom",
        message: `invalid glob pattern ${JSON.stringify(ctx.value)}: supported syntax is *, **, **/, and ? with / separators`,
        input: ctx.value,
      });
    }
  });

const CategoriesSchema = z.strictObject({
  bugs: z.boolean().default(DEFAULT_CATEGORIES.bugs),
  security: z.boolean().default(DEFAULT_CATEGORIES.security),
  performance: z.boolean().default(DEFAULT_CATEGORIES.performance),
  concurrency: z.boolean().default(DEFAULT_CATEGORIES.concurrency),
});

const CategoryOverrideSchema = z.strictObject({
  severity_threshold: SeveritySchema.optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
});

const ReviewSchema = z.strictObject({
  enabled: z.boolean().default(DEFAULT_ENABLED),
  categories: CategoriesSchema.prefault({}),
  severity_threshold: SeveritySchema.default(DEFAULT_SEVERITY_THRESHOLD),
  confidence_threshold: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE_THRESHOLD),
  category_overrides: z
    .strictObject({
      bugs: CategoryOverrideSchema.optional(),
      security: CategoryOverrideSchema.optional(),
      performance: CategoryOverrideSchema.optional(),
      concurrency: CategoryOverrideSchema.optional(),
    })
    .default({}),
  max_findings: z.number().int().positive().default(DEFAULT_MAX_FINDINGS),
  max_changed_lines_per_file: z.number().int().positive().default(DEFAULT_MAX_CHANGED_LINES_PER_FILE),
  max_file_size_kb: z
    .number()
    .int()
    .positive()
    .max(
      MAX_MAX_FILE_SIZE_KB,
      `max_file_size_kb must be <= ${MAX_MAX_FILE_SIZE_KB} KB so an accepted blob always fits the 26 MiB blob-read cap`,
    )
    .default(DEFAULT_MAX_FILE_SIZE_KB),
});

const PartialCategoriesSchema = z.strictObject({
  bugs: z.boolean().optional(),
  security: z.boolean().optional(),
  performance: z.boolean().optional(),
  concurrency: z.boolean().optional(),
});

const PartialReviewSchema = z.strictObject({
  enabled: z.boolean().optional(),
  categories: PartialCategoriesSchema.optional(),
  severity_threshold: SeveritySchema.optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  max_findings: z.number().int().positive().optional(),
  max_changed_lines_per_file: z.number().int().positive().optional(),
  max_file_size_kb: z
    .number()
    .int()
    .positive()
    .max(
      MAX_MAX_FILE_SIZE_KB,
      `max_file_size_kb must be <= ${MAX_MAX_FILE_SIZE_KB} KB so an accepted blob always fits the 26 MiB blob-read cap`,
    )
    .optional(),
});

const RuleSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(RULE_KINDS),
  text: z.string().min(1),
  paths: z.array(GlobPatternSchema).optional(),
  severity: SeveritySchema.optional(),
});

const PathOverrideSchema = z.strictObject({
  paths: z.array(GlobPatternSchema).min(1),
  review: PartialReviewSchema,
});

const ContextSchema = z
  .strictObject({
    max_run_time_ms: z.number().int().min(MIN_MAX_RUN_TIME_MS).max(MAX_MAX_RUN_TIME_MS).default(
      DEFAULT_MAX_RUN_TIME_MS,
    ),
    max_parse_time_ms: z
      .number()
      .int()
      .min(MIN_MAX_PARSE_TIME_MS)
      .max(MAX_MAX_PARSE_TIME_MS)
      .default(DEFAULT_MAX_PARSE_TIME_MS),
    max_total_parse_time_ms: z
      .number()
      .int()
      .min(MIN_MAX_TOTAL_PARSE_TIME_MS)
      .max(MAX_MAX_TOTAL_PARSE_TIME_MS)
      .default(DEFAULT_MAX_TOTAL_PARSE_TIME_MS),
    max_tokens_per_unit: z
      .number()
      .int()
      .min(MIN_MAX_TOKENS_PER_UNIT)
      .max(MAX_MAX_TOKENS_PER_UNIT)
      .default(DEFAULT_MAX_TOKENS_PER_UNIT),
  })
  .check((ctx) => {
    const context = ctx.value;
    if (context.max_parse_time_ms > context.max_total_parse_time_ms) {
      ctx.issues.push({
        code: "custom",
        message: `max_parse_time_ms (${context.max_parse_time_ms}) must be <= max_total_parse_time_ms (${context.max_total_parse_time_ms})`,
        input: ctx.value,
      });
    }
    if (context.max_total_parse_time_ms > context.max_run_time_ms) {
      ctx.issues.push({
        code: "custom",
        message: `max_total_parse_time_ms (${context.max_total_parse_time_ms}) must be <= max_run_time_ms (${context.max_run_time_ms})`,
        input: ctx.value,
      });
    }
  });

export const ConfigFileSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  review: ReviewSchema.prefault({}),
  // Non-secret fixed-model runtime controls (ADR 0016). Strict: no provider,
  // model, or api_family selectors exist; the target is pinned in code.
  llm: z
    .strictObject({
      request_timeout_ms: z
        .number()
        .int()
        .min(MIN_LLM_REQUEST_TIMEOUT_MS)
        .max(MAX_LLM_REQUEST_TIMEOUT_MS)
        .default(DEFAULT_LLM_REQUEST_TIMEOUT_MS),
      max_output_tokens: z
        .number()
        .int()
        .min(MIN_LLM_MAX_OUTPUT_TOKENS)
        .max(MAX_LLM_MAX_OUTPUT_TOKENS)
        .default(DEFAULT_LLM_MAX_OUTPUT_TOKENS),
      max_retries: z
        .number()
        .int()
        .min(MIN_LLM_MAX_RETRIES)
        .max(MAX_LLM_MAX_RETRIES)
        .default(DEFAULT_LLM_MAX_RETRIES),
      max_concurrent_requests: z
        .number()
        .int()
        .min(MIN_LLM_MAX_CONCURRENT_REQUESTS)
        .max(MAX_LLM_MAX_CONCURRENT_REQUESTS)
        .default(DEFAULT_LLM_MAX_CONCURRENT_REQUESTS),
      max_review_unit_input_tokens: z
        .number()
        .int()
        .min(MIN_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS)
        .max(MAX_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS)
        .default(DEFAULT_LLM_MAX_REVIEW_UNIT_INPUT_TOKENS),
      review_timeout_ms: z
        .number()
        .int()
        .min(MIN_LLM_REVIEW_TIMEOUT_MS)
        .max(MAX_LLM_REVIEW_TIMEOUT_MS)
        .default(DEFAULT_LLM_REVIEW_TIMEOUT_MS),
    })
    .check((ctx) => {
      // Output tokens ride inside the context window: an input budget that
      // cannot fit alongside the reserved output plus margin is rejected at
      // load instead of failing per-unit at request time.
      const llm = ctx.value;
      if (
        llm.max_review_unit_input_tokens + llm.max_output_tokens + CONTEXT_SAFETY_MARGIN_TOKENS >
        MODEL_CONTEXT_TOKENS
      ) {
        ctx.issues.push({
          code: "custom",
          message:
            `llm budgets do not fit the ${MODEL_CONTEXT_TOKENS}-token local context ceiling: ` +
            `max_review_unit_input_tokens (${llm.max_review_unit_input_tokens}) + max_output_tokens ` +
            `(${llm.max_output_tokens}) + margin (${CONTEXT_SAFETY_MARGIN_TOKENS}) exceeds it`,
          input: ctx.value,
        });
      }
    })
    .prefault({}),
  ignore: z
    .strictObject({
      // Additive: user entries extend the built-in defaults (merged, deduped).
      paths: z.array(GlobPatternSchema).optional().transform(mergeIgnorePaths),
    })
    .prefault({}),
  repository: z
    .strictObject({
      language: z.enum(LANGUAGES).default(DEFAULT_LANGUAGE),
    })
    .prefault({}),
  context: ContextSchema.prefault({}),
  rules: z
    .array(RuleSchema)
    .default([])
    .check((ctx) => {
      const ids = ctx.value.map((rule) => rule.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (duplicates.length > 0) {
        ctx.issues.push({
          code: "custom",
          message: `duplicate rule ids: ${[...new Set(duplicates)].join(", ")}`,
          input: ctx.value,
        });
      }
    }),
  path_overrides: z.array(PathOverrideSchema).default([]),
});

export type ResolvedConfig = z.infer<typeof ConfigFileSchema>;
