import { DEFAULT_MAX_PARSE_TIME_MS } from "../config/defaults.ts";
import { parseSource } from "../context/parser.ts";
import type { SupportedLanguage } from "../context/runtime.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { ConventionEngine } from "../core/contracts.ts";
import { ReviewerError } from "../core/errors.ts";
import type { DiffResult } from "../types/index.ts";
import type { ConventionBuildDiagnostics, ConventionBuildResult } from "../types/conventions.ts";
import type { DetectorCandidate, ParsedSampledFile } from "./detectors/index.ts";
import { detectCommonWrappers, detectErrorHandling, detectNamingExports } from "./detectors/index.ts";
import { sampleMergeBase } from "./sampling.ts";
import { filterConventions } from "./support.ts";

function internal(message: string): ReviewerError {
  return new ReviewerError({ code: "INTERNAL", message });
}

function pushCode(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

// Sample -> parse -> detect -> support orchestration (plan 3.1, 5-7). Pure
// scan in memory: blobs are read by object id from the merge-base tree, never
// the working tree, and every sampled blob, tree, and intermediate is
// discarded after orchestration. Fail-open by design: ordinary snapshot or
// detector failures yield empty conventions (primary review continues), while
// caller abort still cancels the run.
export class ConventionEngineImpl implements ConventionEngine {
  async build(input: {
    repoDir: string;
    diff: DiffResult;
    config: ResolvedConfig;
    signal?: AbortSignal | undefined;
  }): Promise<ConventionBuildResult> {
    if (input === null || input === undefined || typeof input !== "object") {
      throw internal("ConventionEngine requires an input object");
    }
    if (typeof input.repoDir !== "string" || input.repoDir.length === 0) {
      throw internal("ConventionEngine requires repoDir to be a non-empty path");
    }
    if (input.diff === null || input.diff === undefined || typeof input.diff !== "object") {
      throw internal("ConventionEngine requires a diff result");
    }
    if (input.config === null || input.config === undefined || typeof input.config !== "object") {
      throw internal("ConventionEngine requires a resolved config");
    }
    const signal = input.signal;
    signal?.throwIfAborted();

    const codes: string[] = [];
    let sampledFiles = 0;
    let skippedFiles = 0;
    try {
      const sample = await sampleMergeBase({
        repoRoot: input.repoDir,
        mergeBase: input.diff.mergeBase,
        headSha: input.diff.headSha,
        files: input.diff.files,
        ignorePaths: input.config.ignore.paths,
        signal,
      });
      sampledFiles = sample.files.length;
      skippedFiles += sample.stats.contentSkipped;
      if (sample.files.length === 0) {
        pushCode(codes, "convention_sample_empty");
        return { conventions: [], diagnostics: { sampledFiles, skippedFiles, conventions: 0, codes } };
      }
      const parsed = await this.parseSampled(sample.files.map((file) => ({ ...file })), signal);
      skippedFiles += sample.files.length - parsed.files.length;
      if (parsed.files.length === 0) {
        pushCode(codes, "convention_sample_empty");
        return { conventions: [], diagnostics: { sampledFiles, skippedFiles, conventions: 0, codes } };
      }
      const candidates = this.runDetectors(parsed.files, codes);
      const conventions = filterConventions(candidates);
      if (conventions.length === 0) pushCode(codes, "convention_none_retained");
      if (skippedFiles > 0) pushCode(codes, "convention_files_skipped");
      const diagnostics: ConventionBuildDiagnostics = {
        sampledFiles,
        skippedFiles,
        conventions: conventions.length,
        codes,
      };
      return { conventions, diagnostics };
    } catch (error) {
      signal?.throwIfAborted();
      pushCode(codes, "convention_sample_failed");
      const diagnostics: ConventionBuildDiagnostics = { sampledFiles, skippedFiles, conventions: 0, codes };
      return { conventions: [], diagnostics };
    }
  }

  private async parseSampled(
    files: Array<{ path: string; language: SupportedLanguage; source: string }>,
    signal: AbortSignal | undefined,
  ): Promise<{ files: ParsedSampledFile[] }> {
    const parsed: ParsedSampledFile[] = [];
    try {
      for (const file of files) {
        signal?.throwIfAborted();
        let tree: ParsedSampledFile["tree"] | null = null;
        try {
          const result = await parseSource({
            source: file.source,
            language: file.language,
            filePath: file.path,
            perFileMs: DEFAULT_MAX_PARSE_TIME_MS,
          });
          tree = result.tree;
        } catch {
          signal?.throwIfAborted();
          tree = null;
        }
        if (tree === null) continue;
        parsed.push({ path: file.path, language: file.language, source: file.source, tree });
      }
      const kept = [...parsed];
      parsed.length = 0;
      return { files: kept };
    } catch (error) {
      for (const entry of parsed) entry.tree.delete();
      throw error;
    }
  }

  private runDetectors(files: ParsedSampledFile[], codes: string[]): DetectorCandidate[] {
    const candidates: DetectorCandidate[] = [];
    const detectors: Array<() => DetectorCandidate[]> = [
      () => detectNamingExports(files),
      () => detectErrorHandling(files),
      () => detectCommonWrappers(files),
    ];
    try {
      for (const detect of detectors) {
        try {
          candidates.push(...detect());
        } catch {
          pushCode(codes, "convention_detector_failed");
        }
      }
      return candidates;
    } finally {
      for (const file of files) file.tree.delete();
    }
  }
}
