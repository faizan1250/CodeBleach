const REDACTED = "[REDACTED]";

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]+/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
];

const SENSITIVE_KEY_PARTS = ["token", "password", "secret", "api_key", "apikey", "authorization"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part.replace(/[_-]/g, "")));
}

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
    return {
      name: value.name,
      message: redact(value.message, extraSecrets),
      ...(value.stack !== undefined ? { stack: redact(value.stack, extraSecrets) } : {}),
    };
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
