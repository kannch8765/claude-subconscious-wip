/**
 * Secret redaction for transcript text, before it is stored as evidence or sent to Letta.
 *
 * Every path that copies transcript text calls this one module: canonical evidence (`adapter/index.ts`), the Letta
 * transcript and recall's transcript search (`scripts/transcript_utils.ts`), and assistant remember intents
 * (`intent/index.ts`). It runs on the whole block and before any truncation, so a cut can't split a secret past its
 * pattern; structured values are redacted leaf by leaf before they are serialized, so JSON quoting can't hide one.
 * It is pattern-based (known token shapes, `key = value` assignments, credentials in URLs, private keys, sensitive
 * field names): it lowers the risk, it can't promise every secret is caught. A redacted span becomes
 * `[redacted:<kind>]` so a reader still sees something was there.
 *
 * Evidence is append-only, so a false positive loses text for good: sensitive names match on whole words, and secret
 * values are ASCII-only, so prose and CJK text are never swallowed.
 */

export type RedactionCounts = Record<string, number>;

// Longest text the patterns run on. Longer text is cut here first, so a pathological single line can't make the
// regexes slow; evidence is capped far below this anyway, and a private key cut off here still redacts to the end.
export const MAX_REDACT_CHARS = 64_000;

// Names whose values are secrets: whole words of a key or field name (`DEPLOY_TOKEN`, `apiKey`, `x-api-key`,
// `client_secret`), never parts of a word (`secretary`, `tokenizer`, `max_tokens`).
const SENSITIVE_WORDS = new Set(['password', 'passwd', 'passphrase', 'secret', 'token', 'credential', 'credentials',
  'authorization', 'apikey', 'privatekey', 'accesskey']);

export function sensitiveName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word, i) => SENSITIVE_WORDS.has(word) || SENSITIVE_WORDS.has(word + (words[i + 1] ?? '')));
}

// Known token shapes, in order. Every variable-length part is bounded, so no pattern can backtrack quadratically.
const PATTERNS: Array<[string, RegExp]> = [
  // a BEGIN marker with no END redacts to the end of the text: the rest may be key material
  ['private_key', /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_\-]{20,}/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google_key', /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9\-]{10,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g],
  ['bearer', /(\bbearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi],
  ['url_credentials', /(\b[a-z][a-z0-9+.\-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}(@)/gi],
];

// A secret value: printable ASCII with no spaces, quotes or separators.
const VALUE = String.raw`[\x21\x23-\x26\x28-\x2b\x2d-\x3a\x3c-\x7e]`;
// `name = value` / `name: value` / JSON `"name": "value"`. The name is captured whole and checked with
// sensitiveName. `=` (env style) takes any value of 6+ characters; `:` only one that looks like a secret (a digit, or
// 16+ long), so "my secret: honestly…" stays prose. The value is matched at most 256 characters at a time so the scan
// stays linear; VALUE_REST takes the rest of a sensitive one.
const ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_.\-])([A-Za-z][A-Za-z0-9_.\-]{0,63})(["']?\s*(=|:)\s*["']?)`
  + String.raw`(?!\[redacted)(${VALUE}{6,256})`, 'g');
const VALUE_REST = new RegExp(`${VALUE}*`, 'y');

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
      // Keep a captured prefix ("Bearer ", "scheme://user:") and suffix ("@") so the text stays readable
      const groups = args.slice(1, -2).filter((g) => typeof g === 'string') as string[];
      return `${groups[0] ?? ''}[redacted:${kind}]${groups[1] ?? ''}`;
    });
  }
  return redactAssignments(result, counts);
}

function redactAssignments(text: string, counts?: RedactionCounts): string {
  let out = '';
  let kept = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const [, name, sep, op, value] = m;
    const valueStart = m.index + name.length + sep.length;
    if (!sensitiveName(name) || (op === ':' && !/[0-9]/.test(value) && value.length < 16)) {
      // Not a secret itself, but its value may hold one (`note: DEPLOY_TOKEN=…`, `https://…?token=…`): scan on inside it
      ASSIGNMENT.lastIndex = valueStart;
      continue;
    }
    VALUE_REST.lastIndex = valueStart + value.length;
    VALUE_REST.exec(text);
    count(counts, 'assignment');
    out += `${text.slice(kept, valueStart)}[redacted:assignment]`;
    kept = ASSIGNMENT.lastIndex = VALUE_REST.lastIndex;
  }
  return out + text.slice(kept);
}

/** A copy of a JSON value with every string leaf redacted, and the string values of sensitive fields replaced. */
export function redactValue(value: unknown, counts?: RedactionCounts): unknown {
  if (typeof value === 'string') return redactText(value, counts);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, counts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (sensitiveName(key) && typeof item === 'string' && item) {
        count(counts, 'field');
        return [key, '[redacted:field]'];
      }
      return [key, redactValue(item, counts)];
    }));
  }
  return value;
}

/** Structured values: redacted leaf by leaf, then serialized (and the result checked once more as text). */
export function redactedJson(value: unknown, counts?: RedactionCounts, space?: number): string {
  let text: string;
  try { text = JSON.stringify(redactValue(value, counts), null, space) ?? String(value); } catch { text = redactText(String(value), counts); }
  return redactText(text, counts);
}
