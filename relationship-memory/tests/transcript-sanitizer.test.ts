import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalMessages } from '../src/adapter/index.js';
import { formatMessagesForLetta, type TranscriptMessage } from '../../scripts/transcript_utils.js';
import { sanitizeTranscriptFile, sanitizeTranscriptRecord } from '../../scripts/sanitize_transcript.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-sanitize-')); dirs.push(dir); return dir; }

function fixture(): TranscriptMessage[] {
  return [
    { type: 'system', subtype: 'turn_start', stopReason: 'unused' },
    {
      type: 'user', uuid: 'u1', timestamp: '2026-08-12T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: '猫今天画画了。' }] },
      tool_result: { duplicated: 'x'.repeat(50_000) },
    } as any,
    {
      type: 'assistant', uuid: 'a1', timestamp: '2026-08-12T00:01:00Z',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '先想一下。' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { id: 'toolu_1', command: "cat >> diary.md <<'EOF'\n猫今天画画了。\nEOF" } },
        { type: 'text', text: '我记住啦。' },
      ] },
      cwd: '/huge/unneeded/path', parentUuid: 'u1', requestId: 'req-1',
    } as any,
    {
      type: 'user', uuid: 'u2', timestamp: '2026-08-12T00:02:00Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }], is_error: false }] },
      toolUseResult: { duplicated: 'y'.repeat(80_000) },
    } as any,
    { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { a: { content: 'z'.repeat(30_000) } } } } as any,
    { type: 'summary', summary: '猫今天画画，琥珀记录了。', uuid: 'unused-summary-wrapper' } as any,
  ];
}

describe('transcript wrapper sanitizer', () => {
  it('removes only fields ignored by both historical consumers', () => {
    const raw = fixture();
    const sanitized = raw.map((record) => sanitizeTranscriptRecord(record)) as TranscriptMessage[];

    expect(sanitized[0]).toEqual({});
    expect(sanitized[1]).toEqual({
      type: 'user', uuid: 'u1', timestamp: '2026-08-12T00:00:00Z',
      message: { content: [{ type: 'text', text: '猫今天画画了。' }] },
    });
    expect(sanitized[2]).not.toHaveProperty('cwd');
    expect(sanitized[3]).not.toHaveProperty('toolUseResult');
    expect(sanitized[4]).toEqual({});
    expect(sanitized[5]).toEqual({ type: 'summary', summary: '猫今天画画，琥珀记录了。' });

    expect(buildCanonicalMessages(sanitized, -1, 'fixed-conversation'))
      .toEqual(buildCanonicalMessages(raw, -1, 'fixed-conversation'));
    expect(formatMessagesForLetta(sanitized, -1))
      .toEqual(formatMessagesForLetta(raw, -1));
  });

  it('streams to a distinct output, preserves record count, and reports substantial wrapper savings', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'raw.jsonl');
    const output = path.join(dir, 'sanitized.jsonl');
    const raw = fixture();
    fs.writeFileSync(input, `${raw.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const stats = await sanitizeTranscriptFile({ inputPath: input, outputPath: output });
    const sanitized = fs.readFileSync(output, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));

    expect(stats.records).toBe(raw.length);
    expect(sanitized).toHaveLength(raw.length);
    expect(stats.output_bytes).toBeLessThan(stats.input_bytes * 0.25);
    expect(stats.placeholder_records).toBe(2);
    expect(buildCanonicalMessages(sanitized, -1, 'fixed-conversation'))
      .toEqual(buildCanonicalMessages(raw, -1, 'fixed-conversation'));
    expect(formatMessagesForLetta(sanitized, -1))
      .toEqual(formatMessagesForLetta(raw, -1));
  });

  it('dry-runs without writing and refuses in-place or malformed input', async () => {
    const dir = tempDir();
    const input = path.join(dir, 'raw.jsonl');
    const output = path.join(dir, 'would-be-output.jsonl');
    fs.writeFileSync(input, `${JSON.stringify(fixture()[1])}\n`, 'utf8');

    const dry = await sanitizeTranscriptFile({ inputPath: input, outputPath: output, dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(fs.existsSync(output)).toBe(false);
    await expect(sanitizeTranscriptFile({ inputPath: input, outputPath: input })).rejects.toThrow(/in-place/);

    const malformed = path.join(dir, 'malformed.jsonl');
    fs.writeFileSync(malformed, '{broken\n', 'utf8');
    await expect(sanitizeTranscriptFile({ inputPath: malformed, outputPath: path.join(dir, 'bad-out.jsonl') }))
      .rejects.toThrow(/Malformed transcript JSONL at line 1/);
  });
});
