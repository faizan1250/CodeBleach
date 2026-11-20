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
];

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "token",
  "password",
  "secret",
  "authorization",
  "privatekey",
  "clientsecret",
  "apikey",
  "apitoken",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "opencodeapikey",
]);

// Normalized suffixes covering prefixed variants such as OPENCODE_API_KEY.
const SENSITIVE_SUFFIXES: readonly string[] = ["apikey", "apisecret", "apitoken"];

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
  const segments = key.split(/[_\-.]+/).flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
  return segments.some((segment) => {
    const normalized = segment.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(normalized)) return true;
    return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  });
}

function isSensitiveAssignmentKey(key: string): boolean {
  return isSensitiveKey(key) || hasSensitiveSegment(key);
}

const NON_SECRET_VALUES = /^(?:true|false|null|undefined)$/i;

// `?key=value` / `&key=value` in free text; value replaced, key kept for context.
const URL_QUERY_SECRET_RE = /([?&])([A-Za-z0-9_.\-~%]+)=([^&\s"'<>]+)/g;

// `.env` / YAML / JSON / log `KEY=value` / `KEY: value` (optionally quoted).
// Runs after TOKEN_PATTERNS so structured tokens are already gone. The opening
// value quote is consumed and the original closing quote stays, so quoted JSON
// keeps balanced quotes; `]` stays in the value class so a second pass sees
// the full `[REDACTED]` sentinel and stops.
const ASSIGNMENT_SECRET_RE =
  /(^|[\s{,;("'])(["']?)([A-Za-z0-9_.-]+)(["']?)\s*([:=])\s*(["']?)([^"'\s,};&]+)/gim;

/** Replace exact secrets (longest first) and known token patterns with [REDACTED]. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  const secrets = [...new Set(extraSecrets.filter((s) => s.length > 0))].sort(
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
    (match: string, mark: string, key: string, value: string) => {
      if (value === REDACTED || !isSensitiveAssignmentKey(key)) return match;
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
      openValue: string,
      value: string,
    ) => {
      if (value === REDACTED || !isSensitiveAssignmentKey(key)) return match;
      if (!/[A-Za-z]/.test(value) || NON_SECRET_VALUES.test(value)) return match;
      return `${pre}${openKey}${key}${closeKey}${sep}${openValue}[REDACTED]`;
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
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(entry, extraSecrets, seen);
    }
    result = out;
  }
  seen.delete(value);
  return result;
}
