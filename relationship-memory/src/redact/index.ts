/**
 * Secret redaction for transcript text, before it is stored as evidence or sent to Letta.
 *
 * Both transcript paths (canonical evidence in `adapter/index.ts` and the Letta transcript in
 * `scripts/transcript_utils.ts`) call this one module, on the whole block and before any truncation, so a cut can't
 * split a secret past its pattern. It is pattern-based (known token shapes, `key = value` assignments, credentials in
 * URLs, private keys, sensitive field names in structured tool input): it lowers the risk, it can't promise every
 * secret is caught. A redacted span becomes `[redacted:<kind>]` so a reader still sees something was there.
 */

export type RedactionCounts = Record<string, number>;

// Order matters: specific token shapes run before the generic assignment rule.
const PATTERNS: Array<[string, RegExp]> = [
  // a BEGIN marker with no END redacts to the end of the text: the rest may be key material
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_\-]{20,}/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google_key', /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9\-]{10,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g],
  ['bearer', /(\bbearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi],
  ['url_credentials', /(\b[a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi],
  // `KEY=value`, `key: value`, and JSON `"key": "value"` (the closing quote before the colon)
  ['assignment', /(\b[A-Z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Z0-9_]*\b["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;]{6,}/gi],
];

// Field names in structured tool input/output whose string values are secrets, whatever they look like
const SENSITIVE_FIELD = /api[_-]?key|secret|token|passw(?:or)?d|credential|authorization|private[_-]?key/i;

function count(counts: RedactionCounts | undefined, kind: string): void {
  if (counts) counts[kind] = (counts[kind] ?? 0) + 1;
}

export function redactText(text: string, counts?: RedactionCounts): string {
  let result = text;
  for (const [kind, pattern] of PATTERNS) {
    result = result.replace(pattern, (...args: unknown[]) => {
      count(counts, kind);
      // Keep a captured prefix ("Bearer ", "KEY=", "scheme://user:") and suffix ("@") so the text stays readable
      const groups = args.slice(1, -2).filter((g) => typeof g === 'string') as string[];
      return `${groups[0] ?? ''}[redacted:${kind}]${groups[1] ?? ''}`;
    });
  }
  return result;
}

/** A copy of a JSON value with the string values of sensitive fields replaced (counted as `field`). */
export function redactFields(value: unknown, counts?: RedactionCounts): unknown {
  if (Array.isArray(value)) return value.map((item) => redactFields(item, counts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (SENSITIVE_FIELD.test(key) && typeof item === 'string' && item) {
        count(counts, 'field');
        return [key, '[redacted:field]'];
      }
      return [key, redactFields(item, counts)];
    }));
  }
  return value;
}

/** Structured values: sensitive fields scrubbed, serialized, then the whole text redacted. */
export function redactedJson(value: unknown, counts?: RedactionCounts, space?: number): string {
  let text: string;
  try { text = JSON.stringify(redactFields(value, counts), null, space) ?? String(value); } catch { text = String(value); }
  return redactText(text, counts);
}
