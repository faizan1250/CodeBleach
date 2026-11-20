import type { ContextEngine, DiffEngine, Publisher, ReviewEngine, ValidationEngine } from "./contracts.ts";
import { ReviewerError } from "./errors.ts";

function notImplemented(stage: string, phase: string): ReviewerError {
  return new ReviewerError({
    code: "NOT_IMPLEMENTED",
    message: `${stage} engine is not implemented until ${phase}`,
  });
}

/** Default Phase 1 wiring: every stage throws NOT_IMPLEMENTED. */
export const stubDiffEngine: DiffEngine = {
  run: () => Promise.reject(notImplemented("diff", "Phase 2")),
};

export const stubContextEngine: ContextEngine = {
  build: () => Promise.reject(notImplemented("context", "Phase 3")),
};

export const stubReviewEngine: ReviewEngine = {
  review: () => Promise.reject(notImplemented("review", "Phase 4")),
};

export const stubValidationEngine: ValidationEngine = {
  validate: () => Promise.reject(notImplemented("validation", "Phase 5")),
};

export const stubPublisher: Publisher = {
  publish: () => Promise.reject(notImplemented("publisher", "Phase 7")),
};
