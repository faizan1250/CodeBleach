// Validated glob subset for `.reviewer.yml` path fields (ADR 0007).
// Supported: `*` (within one segment), `**` (whole segments only),
// `**/` (zero or more leading directories), `?` (one char), `/` separators.
// Rejects brace/char-class/extglob/negation syntax instead of treating it
// as literal text. Independent of `config` to avoid import cycles.

function isSegmentValid(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return false;
  if (segment.includes("**") && segment !== "**") return false;
  for (const char of segment) {
    if (char === "{" || char === "}" || char === "[" || char === "]") return false;
    if (char === "(" || char === ")") return false;
  }
  return true;
}

export function isValidGlobPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.startsWith("!")) return false;
  if (pattern.includes("\0") || pattern.includes("\\")) return false;
  if (pattern.startsWith("/") || pattern.endsWith("/")) return false;
  return pattern.split("/").every(isSegmentValid);
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
}

function segmentMatches(segmentPattern: string, name: string): boolean {
  let source = "";
  for (const char of segmentPattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += escapeRegExpChar(char);
  }
  return new RegExp(`^${source}$`).test(name);
}

// Case-sensitive match of a repo-relative `/`-separated path.
export function matchGlob(path: string, pattern: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  let patternIndex = 0;
  let pathIndex = 0;
  let backtrackPattern = -1;
  let backtrackPath = -1;
  while (pathIndex < pathSegments.length) {
    const segment = patternSegments[patternIndex];
    if (segment === "**") {
      backtrackPattern = patternIndex;
      backtrackPath = pathIndex + 1;
      patternIndex += 1;
    } else if (segment !== undefined && segmentMatches(segment, pathSegments[pathIndex] ?? "")) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (backtrackPattern !== -1) {
      pathIndex = backtrackPath;
      backtrackPath += 1;
      patternIndex = backtrackPattern + 1;
    } else {
      return false;
    }
  }
  while (patternSegments[patternIndex] === "**") patternIndex += 1;
  return patternIndex === patternSegments.length;
}
