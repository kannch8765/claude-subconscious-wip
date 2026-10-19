/**
 * Secret redaction for transcript text, before it is stored as evidence or sent to Letta.
 *
 * Every path that copies transcript text calls this one module: canonical evidence (`adapter/index.ts`), the Letta
 * transcript and recall's transcript search (`scripts/transcript_utils.ts`), and assistant remember intents
 * (`intent/index.ts`). It runs on the whole block and before any truncation, so a cut can't split a secret past its
 * pattern. It is pattern-based (known token shapes, `key = value` assignments, credentials in
 * URLs, private keys, sensitive field names in structured tool input): it lowers the risk, it can't promise every
 * secret is caught. A redacted span becomes `[redacted:<kind>]` so a reader still sees something was there.
 */

export type RedactionCounts = Record<string, number>;

// Longest text the patterns run on. Longer text is cut here first, so a pathological single line can't make the
// regexes slow; evidence is capped far below this anyway, and a private key cut off here still redacts to the end.
export const MAX_REDACT_CHARS = 64_000;

// A secret value: printable ASCII with no spaces, quotes or separators. ASCII-only on purpose, so prose (and CJK text,
// which has no spaces) after `secret:` is never swallowed.
const VALUE = String.raw`[\x21\x23-\x26\x28-\x2b\x2d-\x3a\x3c-\x7e]`;
const KEY = String.raw`\b[A-Z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Z0-9_]*\b["']?`;

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
  // `KEY=value` (env style): any value of 6+ characters
  ['assignment', new RegExp(String.raw`(${KEY}\s*=\s*["']?)(?!\[redacted)${VALUE}{6,}`, 'gi')],
  // `key: value` and JSON `"key": "value"`: only a value that looks like a secret (has a digit, or is 16+ long), so
  // "my secret: honestly…" stays prose
  ['assignment', new RegExp(String.raw`(${KEY}\s*:\s*["']?)(?!\[redacted)(?=${VALUE}*[0-9]|${VALUE}{16})${VALUE}{6,}`, 'gi')],
];

// Field names whose string values are secrets, whatever they look like. Matched on whole name words, so `apiKey`,
// `access_token` and `x-api-key` count but `tokenizer`, `secretary` and `max_tokens` don't.
const SENSITIVE_WORDS = new Set(['password', 'passwd', 'passphrase', 'secret', 'token', 'credential', 'credentials',
  'authorization', 'apikey', 'privatekey', 'accesskey']);

function sensitiveField(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word, i) => SENSITIVE_WORDS.has(word) || SENSITIVE_WORDS.has(word + (words[i + 1] ?? '')));
}

function count(counts: RedactionCounts | undefined, kind: string): void {
  if (counts) counts[kind] = (counts[kind] ?? 0) + 1;
}

export function redactText(text: string, counts?: RedactionCounts): string {
  let result = text.length > MAX_REDACT_CHARS
    ? `${text.slice(0, MAX_REDACT_CHARS)}\n... [text cut at ${MAX_REDACT_CHARS} chars before redaction]`
    : text;
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
      if (sensitiveField(key) && typeof item === 'string' && item) {
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
