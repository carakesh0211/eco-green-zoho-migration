// Structured JSON-line logging with recursive secret redaction. See CONTRACTS.md §L.
// Must never throw: logging failures must never crash the pipeline.

const SENSITIVE_KEY_RE = /token|secret|password|authorization|refresh|client_secret/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 20;

/** Recursively redact values whose key matches SENSITIVE_KEY_RE. Never throws. */
export function redact(obj, depth = 0) {
  try {
    if (obj === null || obj === undefined) return obj;
    if (depth > MAX_DEPTH) return '[TRUNCATED]';
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
    if (obj instanceof Date) return obj.toISOString();
    if (typeof obj !== 'object') return obj;

    const out = {};
    for (const key of Object.keys(obj)) {
      try {
        if (SENSITIVE_KEY_RE.test(key)) {
          out[key] = REDACTED;
        } else {
          out[key] = redact(obj[key], depth + 1);
        }
      } catch {
        out[key] = '[UNREADABLE]';
      }
    }
    return out;
  } catch {
    return '[UNREADABLE]';
  }
}

/** Write one JSON line to stdout. Never throws. */
export function log(level, msg, fields = {}) {
  try {
    const safeFields = redact(fields ?? {});
    const line = { ts: new Date().toISOString(), level, msg, ...safeFields };
    let serialized;
    try {
      serialized = JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      serialized = JSON.stringify({ ts: line.ts, level, msg, logError: 'UNSERIALIZABLE_FIELDS' });
    }
    // eslint-disable-next-line no-console
    console.log(serialized);
  } catch {
    // Logging must never throw or crash the caller.
    try {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'LOG_FAILURE' }));
    } catch {
      /* truly nothing we can do */
    }
  }
}
