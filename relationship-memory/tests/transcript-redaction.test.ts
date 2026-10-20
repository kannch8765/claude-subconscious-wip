import { describe, expect, it } from 'vitest';
import { buildCanonicalMessages } from '../src/adapter/index.js';
import { MAX_REDACT_CHARS, redactText, redactValue } from '../src/redact/index.js';
import { extractAssistantRememberIntents } from '../src/intent/index.js';
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
    expect(redactValue({ token: SECRET, tokens: 12, note: 'fine' }, counts)).toEqual({ token: '[redacted:field]', tokens: 12, note: 'fine' });
    expect(counts).toEqual({ field: 1 });
  });

  it('never swallows prose or CJK text after a secret-looking word', () => {
    for (const prose of [
      '告诉你一个secret: 我其实很喜欢你送的那个杯子。明天见',
      'my secret: honestly I miss you',
      'the token: 一緒に頑張ろうね',
      'password: please reset it tomorrow',
    ]) expect(redactText(prose)).toBe(prose);
    expect(redactText('password: hunter2hunter2')).toBe('password: [redacted:assignment]');
    expect(redactText(`DEPLOY_TOKEN=abcdefgh 次に`)).toBe('DEPLOY_TOKEN=[redacted:assignment] 次に');
  });

  it('matches sensitive field names on whole words', () => {
    const counts: Record<string, number> = {};
    expect(redactValue({ apiKey: 'v1', access_token: 'v2', 'x-api-key': 'v3', tokenizer: 'cl100k', secretary: 'Mika', max_tokens: 'many' }, counts))
      .toEqual({ apiKey: '[redacted:field]', access_token: '[redacted:field]', 'x-api-key': '[redacted:field]', tokenizer: 'cl100k', secretary: 'Mika', max_tokens: 'many' });
    expect(counts).toEqual({ field: 3 });
  });

  it('redacts assistant remember intents copied from the same tool_use block', () => {
    const messages = [{ type: 'assistant', uuid: 'a1', timestamp: '2026-10-19T00:00:00Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'mcp__plugin_claude-subconscious_relationship-memory-intent__remember',
        input: { memory: { text: `the deploy uses DEPLOY_TOKEN=${SECRET}` }, feel: { text: 'relieved' } } },
    ] } }] as TranscriptMessage[];
    const [intent] = extractAssistantRememberIntents(messages, -1, 'session-synthetic', 'subject-synthetic');
    expect(intent.memory.text).toBe('the deploy uses DEPLOY_TOKEN=[redacted:assignment]');
    expect(intent.feel.text).toBe('relieved');
  });

  it('bounds the text the patterns run on, and says so', () => {
    const huge = 'my_token_'.repeat(30_000);
    const started = Date.now();
    const out = redactText(huge);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.endsWith(`[text cut at ${MAX_REDACT_CHARS} chars before redaction]`)).toBe(true);
  });

  // Haru review round 1 (PR #142)
  it('redacts JSON quoted inside string values, on both paths', () => {
    const json = `{"api_key":"${SECRET}"}`;
    const messages = [
      { type: 'assistant', uuid: 'a1', timestamp: '2026-10-19T00:00:00Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -d '${json}' https://example.test` } },
      ] } },
      { type: 'user', uuid: 'u1', timestamp: '2026-10-19T00:00:01Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: json }] },
      ] } },
    ] as TranscriptMessage[];
    const evidence = buildCanonicalMessages(messages, -1, 'conv-synthetic').map((e) => e.quote).join('\n');
    const letta = formatMessagesForLetta(messages, -1).map((m) => m.text).join('\n');
    for (const text of [evidence, letta]) expect(text).not.toContain(SECRET);
    expect(evidence).toContain('[redacted:assignment]');
  });

  it('matches assignment names on whole words too', () => {
    for (const prose of ['my secretary: Alice123', 'My preferred tokenizer: cl100k_base', 'max_tokens: 4096',
      '{"tokenizer": "cl100k_base"}']) expect(redactText(prose)).toBe(prose);
    expect(redactText('client_secret: abc123def456')).toBe('client_secret: [redacted:assignment]');
    expect(redactText('x-api-key: abc123def456')).toBe('x-api-key: [redacted:assignment]');
    expect(redactText('apiKey=abcdefgh')).toBe('apiKey=[redacted:assignment]');
  });

  // Haru review round 2 (PR #142): a harmless outer name must not swallow a secret inside its value
  const NESTED = [`note: DEPLOY_TOKEN=${SECRET}`, `https://example.test?DEPLOY_TOKEN=${SECRET}`,
    `url=https://example.test?DEPLOY_TOKEN=${SECRET}`, `see https://example.test/cb?state=abc123&access_token=${SECRET}&x=1`];

  it('finds a sensitive assignment inside a non-sensitive value', () => {
    expect(redactText(NESTED[0])).toBe('note: DEPLOY_TOKEN=[redacted:assignment]');
    expect(redactText(NESTED[2])).toBe('url=https://example.test?DEPLOY_TOKEN=[redacted:assignment]');
    expect(redactText(NESTED[3])).toBe('see https://example.test/cb?state=abc123&access_token=[redacted:assignment]');
    expect(redactText(`DEPLOY_TOKEN=${'s'.repeat(1_000)} tail`)).toBe('DEPLOY_TOKEN=[redacted:assignment] tail');
  });

  it('finds nested assignments on both transcript paths and the intent path', () => {
    const messages = NESTED.flatMap((text, i) => [
      { type: 'user', uuid: `u${i}`, timestamp: '2026-10-20T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text }] } },
      { type: 'assistant', uuid: `a${i}`, timestamp: '2026-10-20T00:00:01Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: `t${i}`, name: 'mcp__plugin_claude-subconscious_relationship-memory-intent__remember',
          input: { memory: { text }, feel: { text: 'relieved' } } },
      ] } },
    ]) as TranscriptMessage[];
    const evidence = buildCanonicalMessages(messages, -1, 'conv-synthetic').map((e) => e.quote).join('\n');
    const letta = formatMessagesForLetta(messages, -1).map((m) => m.text).join('\n');
    const intents = extractAssistantRememberIntents(messages, -1, 'session-synthetic', 'subject-synthetic').map((i) => i.memory.text).join('\n');
    for (const text of [evidence, letta, intents]) {
      expect(text).not.toContain(SECRET);
      expect(text).toContain('example.test');
    }
  });

  it('stays fast on adversarial input for every pattern', () => {
    for (const huge of ['a-'.repeat(32_000), 'my_token_'.repeat(7_000), 'ab+'.repeat(21_000), 'a='.repeat(32_000),
      'note: '.repeat(10_000), `token=${'x'.repeat(63_000)}`]) {
      const started = Date.now();
      redactText(huge);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
});
