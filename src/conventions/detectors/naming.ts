// Naming and export-style detector (P6-01, plan section 6.2).
//
// Observes only AST-visible ES export declarations the syntax parser
// identifies reliably. Filename-only patterns are out of scope: they cannot
// be checked from one changed code unit.

import { getAdapter } from "../../context/language.ts";
import { CONVENTION_DETECTOR_NAMING, CONVENTION_DETECTOR_NAMING_VERSION } from "../constants.ts";
import { orderSampledFiles, toCandidate } from "./index.ts";
import type { DetectorCandidate, FileMatch, ParsedSampledFile } from "./index.ts";

const NAMED_PATTERN = "Modules predominantly use named exports.";
const DEFAULT_PATTERN = "Modules predominantly use default exports.";

// A module is eligible with any ES export. Star re-exports surface named
// bindings, so they vote named; namespace re-exports bind a single namespace
// object and vote for neither style while keeping the file eligible.
export function detectNamingExports(files: readonly ParsedSampledFile[]): DetectorCandidate[] {
  const named: FileMatch[] = [];
  const defaulted: FileMatch[] = [];
  let eligibleFiles = 0;
  for (const file of orderSampledFiles(files)) {
    const adapter = getAdapter(file.language);
    const exports = adapter.extractExports(file.tree, file.source);
    if (exports.length === 0) continue;
    eligibleFiles += 1;
    let namedCount = 0;
    let defaultCount = 0;
    let earliest: FileMatch | null = null;
    for (const exported of exports) {
      if (exported.kind === "named" || exported.kind === "star") namedCount += 1;
      else if (exported.kind === "default") defaultCount += 1;
      const span: FileMatch = {
        path: file.path,
        startLine: exported.range.startLine,
        endLine: exported.range.endLine,
      };
      if (earliest === null || span.startLine < earliest.startLine) earliest = span;
    }
    // Mixed named-plus-default modules are eligible but exemplify neither.
    if (namedCount > 0 && defaultCount === 0 && earliest !== null) named.push(earliest);
    else if (defaultCount > 0 && namedCount === 0 && earliest !== null) defaulted.push(earliest);
  }
  const winner =
    named.length > defaulted.length
      ? { pattern: NAMED_PATTERN, matches: named }
      : defaulted.length > named.length
        ? { pattern: DEFAULT_PATTERN, matches: defaulted }
        : null;
  if (winner === null) return [];
  const candidate = toCandidate({
    detector: CONVENTION_DETECTOR_NAMING,
    detectorVersion: CONVENTION_DETECTOR_NAMING_VERSION,
    pattern: winner.pattern,
    matches: winner.matches,
    eligibleFiles,
    sampledFiles: files.length,
  });
  return candidate === null ? [] : [candidate];
}
