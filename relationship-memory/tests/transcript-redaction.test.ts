import { describe, expect, it } from 'vitest';
import { buildCanonicalMessages } from '../src/adapter/index.js';
import { redactText, redactFields } from '../src/redact/index.js';
import { formatMessagesForLetta, type TranscriptMessage } from '../../scripts/transcript_utils.js';

// Wholly synthetic secrets and text (REVIEW.md class 7)
const SECRET = 'synthetic-password-only';
const KEY_BODY = 'SYNTHETICKEYBODY';
const longKey = `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n${'A'.repeat(13_000)}\n-----END RSA PRIVATE KEY-----`;

function fixture(): TranscriptMessage[] {
  return [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-19T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: `export DEPLOY_TOKEN=${SECRET}` }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-19T00:00:01Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: `the key is sk-ant-${'x'.repeat(30)}` },
      { type: 'tool_use', id: 't1', name: 'ExampleTool', input: { password: SECRET, nested: { apiKey: SECRET }, max_tokens: 4096, query: 'ok' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${'b'.repeat(24)}" https://example.test` } },
    ] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-19T00:00:02Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: `{"api_key": "${SECRET}", "user": "mika"}` },
    ] } },
    { type: 'user', uuid: 'u3', timestamp: '2026-10-19T00:00:03Z', message: { role: 'user', content: [{ type: 'text', text: longKey }] } },
  ] as TranscriptMessage[];
}

describe('transcript redaction', () => {
  it('scrubs canonical evidence: text, structured tool input by field name, JSON text, long keys before the cap', () => {
    const events = buildCanonicalMessages(fixture(), -1, 'conv-synthetic');
    const all = events.map((e) => e.quote).join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(KEY_BODY);
    expect(all).not.toContain('x'.repeat(30));
    const input = JSON.parse(events.find((e) => e.tool_use_id === 't1' && e.event_kind === 'assistant_tool_use')!.quote);
    expect(input).toEqual({ password: '[redacted:field]', nested: { apiKey: '[redacted:field]' }, max_tokens: 4096, query: 'ok' });
    expect(all).toContain('mika');
    expect(all).toContain('[redacted:private_key]');
  });

  it('scrubs the Letta transcript the same way (twin path)', () => {
    const text = formatMessagesForLetta(fixture(), -1).map((m) => m.text).join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(KEY_BODY);
    expect(text).not.toContain('b'.repeat(24));
    expect(text).not.toContain('x'.repeat(30));
    expect(text).toContain('mika');
  });

  it('redacts a private key with no END marker to the end of the text', () => {
    expect(redactText(`here:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\nmore`)).toBe('here:\n[redacted:private_key]');
  });

  it('leaves ordinary prose and non-secret fields alone, and counts what it redacted', () => {
    const prose = 'We pinned the token budget to 4096 and the password reset page moved.';
    expect(redactText(prose)).toBe(prose);
    const counts: Record<string, number> = {};
    expect(redactFields({ token: SECRET, tokens: 12, note: 'fine' }, counts)).toEqual({ token: '[redacted:field]', tokens: 12, note: 'fine' });
    expect(counts).toEqual({ field: 1 });
  });
});
