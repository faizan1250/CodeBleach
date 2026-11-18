import { z } from "zod";
import { SeveritySchema } from "../types/finding.ts";
import { RULE_KINDS } from "../types/rules.ts";
import {
  CONFIG_VERSION,
  DEFAULT_CATEGORIES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_ENABLED,
  DEFAULT_IGNORE_PATHS,
  DEFAULT_LANGUAGE,
  DEFAULT_MAX_CHANGED_LINES_PER_FILE,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_SEVERITY_THRESHOLD,
} from "./defaults.ts";

export const LANGUAGES = ["typescript", "tsx", "javascript"] as const;

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
});

const RuleSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(RULE_KINDS),
  text: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
  severity: SeveritySchema.optional(),
});

const PathOverrideSchema = z.strictObject({
  paths: z.array(z.string().min(1)).min(1),
  review: PartialReviewSchema,
});

export const ConfigFileSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  review: ReviewSchema.prefault({}),
  ignore: z
    .strictObject({
      paths: z.array(z.string().min(1)).default([...DEFAULT_IGNORE_PATHS]),
    })
    .prefault({}),
  repository: z
    .strictObject({
      language: z.enum(LANGUAGES).default(DEFAULT_LANGUAGE),
    })
    .prefault({}),
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
