import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeTranscriptBatch } from '../../scripts/sanitize_transcript_batch.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-batch-sanitize-')); dirs.push(dir); return dir; }

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function transcript(label: string): unknown[] {
  return [
    { type: 'system', subtype: 'turn_start', large: 'x'.repeat(5000) },
    { type: 'user', uuid: `${label}-u1`, timestamp: '2026-08-12T00:00:00Z', message: { content: [{ type: 'text', text: `猫-${label}` }] }, toolUseResult: { duplicated: 'y'.repeat(5000) } },
    { type: 'assistant', uuid: `${label}-a1`, timestamp: '2026-08-12T00:00:01Z', message: { content: [{ type: 'text', text: `琥珀-${label}` }] }, cwd: '/ignored' },
  ];
}

describe('transcript wrapper sanitizer batch runner', () => {
  it('mirrors JSONL paths, excludes archive/subagents, writes a resumable manifest, and skips verified outputs', async () => {
    const dir = tempDir();
    const inputRoot = path.join(dir, 'raw');
    const outputRoot = path.join(dir, 'sanitized');
    writeJsonl(path.join(inputRoot, 'project-a', 'one.jsonl'), transcript('one'));
    writeJsonl(path.join(inputRoot, 'project-b', 'nested', 'two.jsonl'), transcript('two'));
    writeJsonl(path.join(inputRoot, 'project-a', 'archive', 'old.jsonl'), transcript('archive'));
    writeJsonl(path.join(inputRoot, 'project-a', 'subagents', 'agent.jsonl'), transcript('agent'));
    fs.writeFileSync(path.join(inputRoot, 'ignore.txt'), 'not-jsonl', 'utf8');

    const first = await sanitizeTranscriptBatch({ inputRoot, outputRoot });
    expect(first.summary.files_total).toBe(2);
    expect(first.summary.files_processed).toBe(2);
    expect(first.summary.files_skipped).toBe(0);
    expect(first.summary.output_bytes).toBeLessThan(first.summary.input_bytes * 0.25);
    expect(fs.existsSync(path.join(outputRoot, 'project-a', 'one.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, 'project-b', 'nested', 'two.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, 'project-a', 'archive', 'old.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(outputRoot, 'project-a', 'subagents', 'agent.jsonl'))).toBe(false);

    const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
    expect(manifest.complete).toBe(true);
    expect(manifest.excluded_segments).toEqual(['archive', 'subagents']);
    expect(manifest.entries.map((entry: any) => entry.relative_path)).toEqual([
      'project-a/one.jsonl',
      'project-b/nested/two.jsonl',
    ]);
    expect(manifest.entries.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.input_sha256))).toBe(true);
    expect(manifest.entries.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.output_sha256))).toBe(true);

    const oneBefore = fs.readFileSync(path.join(outputRoot, 'project-a', 'one.jsonl'));
    const second = await sanitizeTranscriptBatch({ inputRoot, outputRoot });
    expect(second.summary.files_processed).toBe(0);
    expect(second.summary.files_skipped).toBe(2);
    expect(fs.readFileSync(path.join(outputRoot, 'project-a', 'one.jsonl'))).toEqual(oneBefore);
  });

  it('dry-runs without creating an output root and rejects overlapping roots or ambiguous stale outputs', async () => {
    const dir = tempDir();
    const inputRoot = path.join(dir, 'raw');
    const outputRoot = path.join(dir, 'sanitized');
    writeJsonl(path.join(inputRoot, 'one.jsonl'), transcript('one'));

    const dry = await sanitizeTranscriptBatch({ inputRoot, outputRoot, dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.summary.files_total).toBe(1);
    expect(fs.existsSync(outputRoot)).toBe(false);

    await expect(sanitizeTranscriptBatch({ inputRoot, outputRoot: path.join(inputRoot, 'inside') }))
      .rejects.toThrow(/disjoint/);

    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'one.jsonl'), '{}\n', 'utf8');
    await expect(sanitizeTranscriptBatch({ inputRoot, outputRoot }))
      .rejects.toThrow(/ambiguous existing output/);
  });
});
