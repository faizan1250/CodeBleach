const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /xox[a-z]-[A-Za-z0-9-]{8,}/g,
  /sk_(live|test)_[A-Za-z0-9]+/g,
  /rk_(live|test)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+/=]{10,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]+/g,
  /Basic\s+[A-Za-z0-9+/=]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  // DB connection strings with embedded credentials (user:pass@host). The
  // `@` requirement keeps credential-less `postgres://localhost/db` prose
  // intact; assigned forms are covered by the DATABASE_URL key rules below.
  /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|amqp|sqlserver):\/\/[^/\s"'<>]*@[^\s"'<>]+/g,
];

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "privatekey",
  "clientsecret",
  "apikey",
  "apitoken",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "accesskey",
  "credential",
  "credentials",
  "signingkey",
  "webhooksecret",
  "databaseurl",
  "dburl",
  "mongodburi",
  "redisurl",
  "accountkey",
  "connectionstring",
  "opencodeapikey",
]);

// Normalized suffixes covering prefixed variants such as OPENCODE_API_KEY.
const SENSITIVE_SUFFIXES: readonly string[] = [
  "apikey",
  "apisecret",
  "apitoken",
  "accesskey",
  "credential",
  "credentials",
  "signingkey",
  "webhooksecret",
  "databaseurl",
  "dburl",
  "mongodburi",
  "redisurl",
  "accountkey",
  "connectionstring",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

// Segment check for free-text `key=value` / `key: value` forms: whole-key rules
// miss snake_case names like MY_SECRET, while substring matching would eat
// telemetry ("tokenCount"). A camel/snake/dot segment must equal a sensitive
// word; bare "key" alone is not sensitive (preserves "cache key=..." prose).
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "apisecret",
  "apitoken",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "auth",
  "authorization",
  "privatekey",
  "clientsecret",
]);

function hasSensitiveSegment(key: string): boolean {
  // Split on separators plus lower->Upper and acronym boundaries (DB|Password,
  // HTTP|Auth|Token) so leading-acronym keys classify without broad DB/API rules.
  // Single-token all-caps concatenations (DBPASSWORD) have no boundary and stay
  // non-sensitive by design.
  const segments = key.split(/[_\-.]+/).flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));
  return segments.some((segment) => {
    const normalized = segment.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(normalized)) return true;
    return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  });
}

function isSensitiveAssignmentKey(key: string): boolean {
  return isSensitiveKey(key) || hasSensitiveSegment(key);
}

// Exact telemetry counters that may share a segment with secrets ("token" in
// tokenCount) but carry counts, not secrets. Key-based, never value-based:
// only these normalized keys pass, and only on segment-only hits —
// whole-key classification always wins. Only "tokencount" actively reaches
// the exemption today (other *-tokens keys match no sensitive rule, so they
// pass through as non-sensitive); the rest are defense-in-depth against
// future segment-rule widening.
const TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  "tokencount",
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "maxtokens",
]);

function isTelemetryKey(key: string): boolean {
  return TELEMETRY_KEYS.has(normalizeKey(key));
}

// `?key=value` / `&key=value` in free text; value replaced, key kept for context.
// Literal `#` starts a fragment: excluded from the value so `?api_key=S#frag`
// keeps `#frag`, and pairs after it in the same token stay opaque (`%23` is
// not a delimiter and stays inside the value).
const URL_QUERY_SECRET_RE = /([?&])([A-Za-z0-9_.\-~%]+)=([^&#\s"'<>]+)/g;

// Percent-encoded query names classify on the once-decoded form; the raw
// capture is always re-emitted. decodeURIComponent runs exactly one pass
// (`%2521` -> `%21`, never `!`). Malformed sequences (lone/trailing `%`,
// non-hex like `%ZZ`) fall back to the raw key: never throw, never treat
// undecodable bytes as sensitive.
function decodeQueryKeyOnce(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

// `.env` / YAML / JSON / log `KEY=value` / `KEY: value` (optionally quoted).
// Runs after TOKEN_PATTERNS so structured tokens are already gone. The opening
// value quote is consumed and the original closing quote stays, so quoted JSON
// keeps balanced quotes; `]` stays in the value class so a second pass sees
// the full `[REDACTED]` sentinel and stops. Quoted values may contain spaces
// (`PASSWORD="correct horse battery staple"`); an optional backslash before
// the quotes covers escaped `\"secret\"` forms. Only sensitive keys redact,
// so quoted prose under other keys is untouched. Known limits (by design, not
// bugs): infix names (`X_MONGODB_URI_BACKUP`) and affixed shapes like
// `MY_API_KEY_SUFFIX` match no rule; bare `key` alone stays non-sensitive.
// No pattern set detects every secret shape — this is layered redaction,
// not a universal-detection claim.
const ASSIGNMENT_SECRET_RE =
  /(^|[\s{,;("'])(["']?)([A-Za-z0-9_.-]+)(["']?)\s*([:=])\s*(?:(\\?")((?:\\.|[^"\\])*?)(\\?")|(\\?')((?:\\.|[^'\\])*?)(\\?')|(["']?)([^"'\s,};&]+))/gim;

/** Replace exact secrets (longest first) and known token patterns with [REDACTED].
 *
 * Blind literal replacement applies only to secrets of at least
 * MIN_LITERAL_SECRET_LENGTH chars: shorter values collide with ordinary prose
 * (`OPENCODE_API_KEY=x` would otherwise rewrite every `x`). Context-aware
 * paths (sensitive `KEY=value` assignments, `?key=value` query pairs,
 * `sanitizePayload` whole-value drops, Bearer/Basic/JWT/token patterns)
 * classify by key or shape and stay length-independent. */
// Blind literal secrets need a length floor: below 8 chars collisions with
// prose/tokens are near-certain, while real keys (Bearer, `sk-`, API values)
// are far longer. Only this literal replacer is gated; key-driven paths below
// and TOKEN_PATTERNS above keep full recall on short values.
const MIN_LITERAL_SECRET_LENGTH = 8;

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  const secrets = [...new Set(extraSecrets.filter((s) => s.length >= MIN_LITERAL_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  URL_QUERY_SECRET_RE.lastIndex = 0;
  out = out.replace(
    URL_QUERY_SECRET_RE,
    (match: string, mark: string, key: string, value: string, offset: number, input: string) => {
      if (value === REDACTED) return match;
      // Fragment-opaque: skip pairs after the first literal `#` in this token.
      const token = /[^\s"'<>]*$/.exec(input.slice(0, offset))?.[0] ?? "";
      if (token.includes("#")) return match;
      const decodedKey = decodeQueryKeyOnce(key);
      if (!isSensitiveAssignmentKey(decodedKey)) return match;
      if (!isSensitiveKey(decodedKey) && isTelemetryKey(decodedKey)) return match;
      return `${mark}${key}=[REDACTED]`;
    },
  );
  ASSIGNMENT_SECRET_RE.lastIndex = 0;
  out = out.replace(
    ASSIGNMENT_SECRET_RE,
    (
      match: string,
      pre: string,
      openKey: string,
      key: string,
      closeKey: string,
      sep: string,
      dqOpen: string | undefined,
      dqValue: string | undefined,
      dqClose: string | undefined,
      sqOpen: string | undefined,
      sqValue: string | undefined,
      sqClose: string | undefined,
      uqOpen: string,
      uqValue: string,
    ) => {
      const openValue = dqValue !== undefined ? (dqOpen as string) : sqValue !== undefined ? (sqOpen as string) : uqOpen;
      const value =
        dqValue !== undefined ? dqValue : sqValue !== undefined ? (sqValue as string) : uqValue;
      const closeValue =
        dqValue !== undefined
          ? (dqClose as string)
          : sqValue !== undefined
            ? (sqClose as string)
            : "";
      if (value === REDACTED || !isSensitiveAssignmentKey(key)) return match;
      // Sensitive classification first: numerics and boolean-like values
      // never bypass password/secret/token/api-key/credential keys. The only
      // pass-through is exact-key telemetry on segment-only hits
      // (tokenCount); whole-key hits always redact.
      if (!isSensitiveKey(key) && isTelemetryKey(key)) return match;
      return `${pre}${openKey}${key}${closeKey}${sep}${openValue}[REDACTED]${closeValue}`;
    },
  );
  return out;
}

/** Recursively redact nested payloads; values under sensitive keys are always dropped. */
export function sanitizePayload(value: unknown, extraSecrets: string[] = []): unknown {
  return sanitizeValue(value, extraSecrets, new WeakSet());
}

function sanitizeValue(value: unknown, extraSecrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redact(value, extraSecrets);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const errorOut: Record<string, unknown> = {
      name: value.name,
      message: redact(value.message, extraSecrets),
    };
    if (value.stack !== undefined) errorOut["stack"] = redact(value.stack, extraSecrets);
    if ("code" in value && (typeof value.code === "string" || typeof value.code === "number")) {
      errorOut["code"] = value.code;
    }
    if ("retryable" in value && typeof value.retryable === "boolean") {
      errorOut["retryable"] = value.retryable;
    }
    if (value.cause !== undefined) {
      errorOut["cause"] = sanitizeValue(value.cause, extraSecrets, seen);
    }
    seen.delete(value);
    return errorOut;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitizeValue(item, extraSecrets, seen));
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Whole-key and segment-only hits drop the entire value (any type);
      // never recurse under a sensitive parent. Only exact-key telemetry
      // on segment-only hits passes through. Mirrors redact().
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else if (hasSensitiveSegment(key)) {
        if (isTelemetryKey(key)) {
          out[key] = sanitizeValue(entry, extraSecrets, seen);
        } else {
          out[key] = REDACTED;
        }
      } else {
        out[key] = sanitizeValue(entry, extraSecrets, seen);
      }
    }
    result = out;
  }
  seen.delete(value);
  return result;
}
