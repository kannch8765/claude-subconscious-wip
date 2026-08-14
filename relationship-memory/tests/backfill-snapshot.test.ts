import * as crypto from 'crypto';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBackfillTranscriptInput, validateBackfillSnapshot } from '../src/backfill/snapshot.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (fs.existsSync(root)) {
      const reopen = (dir: string): void => {
        fs.chmodSync(dir, 0o700);
        for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
          if (child.isDirectory() && !child.isSymbolicLink()) reopen(path.join(dir, child.name));
        }
      };
      reopen(root);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { dir: string; manifest: string; transcript: string; uid: number } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-snapshot-parent-'));
  roots.push(parent);
  const dir = path.join(parent, 'snapshot');
  fs.mkdirSync(dir, { mode: 0o700 });
  const transcript = path.join(dir, 'transcript.jsonl');
  const content = '{"type":"user","message":{"id":"u1","content":"hello"}}\n';
  fs.writeFileSync(transcript, content, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    schema_version: 1,
    source_path: '/root/.claude/projects/example.jsonl',
    snapshot_file: 'transcript.jsonl',
    sha256,
    size_bytes: Buffer.byteLength(content),
    exported_at: '2026-08-09T14:00:00Z',
  }), { mode: 0o600 });
  fs.chmodSync(transcript, 0o440);
  fs.chmodSync(manifest, 0o440);
  fs.chmodSync(dir, 0o550);
  const uid = fs.statSync(dir).uid;
  return { dir, manifest, transcript, uid };
}

function batchFixture(): { dir: string; manifest: string; files: string[]; uid: number } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-batch-snapshot-parent-'));
  roots.push(parent);
  const dir = path.join(parent, 'snapshot');
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  const payloads = [
    { relative: 'a.jsonl', content: '{"type":"user","message":{"id":"u1","content":"hello"}}\n' },
    { relative: 'nested/b.jsonl', content: '{"type":"assistant","message":{"id":"a1","content":"hi"}}\n' },
  ];
  const entries = payloads.map((payload) => {
    const file = path.join(dir, ...payload.relative.split('/'));
    fs.writeFileSync(file, payload.content, { mode: 0o600 });
    return {
      relative_path: payload.relative,
      input_bytes: Buffer.byteLength(payload.content),
      input_sha256: crypto.createHash('sha256').update(payload.content).digest('hex'),
      output_bytes: Buffer.byteLength(payload.content),
      output_sha256: crypto.createHash('sha256').update(payload.content).digest('hex'),
      records: 1,
      pairs_striped: 0,
      records_striped: 0,
      placeholders_seen_between_pairs: 0,
    };
  });
  const manifest = path.join(dir, 'manifest.json');
  const summary = {
    files_total: entries.length,
    files_processed: entries.length,
    files_skipped: 0,
    input_bytes: entries.reduce((sum, entry) => sum + entry.input_bytes, 0),
    output_bytes: entries.reduce((sum, entry) => sum + entry.output_bytes, 0),
    pairs_striped: 0,
    records_striped: 0,
  };
  fs.writeFileSync(manifest, JSON.stringify({
    schema_version: 1,
    input_root: '/var/lib/subconscious-backfill-input/sanitized-source',
    output_root: dir,
    complete: true,
    updated_at: '2026-08-12T12:51:54.353Z',
    entries,
    summary,
  }), { mode: 0o600 });
  for (const payload of payloads) fs.chmodSync(path.join(dir, ...payload.relative.split('/')), 0o440);
  fs.chmodSync(manifest, 0o440);
  fs.chmodSync(nested, 0o550);
  fs.chmodSync(dir, 0o550);
  return { dir, manifest, files: payloads.map((payload) => path.join(dir, ...payload.relative.split('/'))), uid: fs.statSync(dir).uid };
}

describe('backfill snapshot authority boundary', () => {
  it('accepts an immutable owner snapshot whose digest and size match', () => {
    const f = fixture();
    const result = validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid });
    expect(result.transcriptPath).toBe(f.transcript);
    expect(result.manifest.source_path).toBe('/root/.claude/projects/example.jsonl');
  });

  it('refuses direct /root transcript access so privileged history must cross the snapshot boundary', () => {
    expect(() => resolveBackfillTranscriptInput({ transcript: '/root/.claude/projects/private.jsonl' })).toThrow(/direct \/root transcript access is disabled/);
  });

  it('refuses direct sealed-snapshot payload access so manifest validation cannot be bypassed', () => {
    expect(() => resolveBackfillTranscriptInput({
      transcript: '/var/lib/subconscious-backfill-input/owner-canary-03-post-093m/transcript.jsonl',
    })).toThrow(/direct privileged snapshot access is disabled.*--snapshot-manifest/);
  });

  it('refuses a filesystem alias resolving to a sealed privileged snapshot payload', () => {
    const alias = '/tmp/093n-sealed-link.jsonl';
    const sealed = '/var/lib/subconscious-backfill-input/owner-canary-03-post-093m/transcript.jsonl';
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(((input: fs.PathLike) => {
      if (String(input) === alias) return sealed;
      return String(input);
    }) as typeof fs.realpathSync);
    try {
      expect(() => resolveBackfillTranscriptInput({ transcript: alias })).toThrow(/direct privileged snapshot access is disabled.*--snapshot-manifest/);
    } finally {
      realpath.mockRestore();
    }
  });

  it('keeps ordinary caller-owned filesystem aliases supported and returns their canonical target', () => {
    const f = fixture();
    const alias = path.join(path.dirname(f.dir), 'ordinary-link.jsonl');
    fs.symlinkSync(f.transcript, alias);
    expect(resolveBackfillTranscriptInput({ transcript: alias })).toBe(f.transcript);
  });

  it('rejects a writable transcript before hashing or backfill', () => {
    const f = fixture();
    fs.chmodSync(f.dir, 0o750);
    fs.chmodSync(f.transcript, 0o640);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/transcript must not be writable/);
  });

  it('rejects a digest mismatch', () => {
    const f = fixture();
    fs.chmodSync(f.dir, 0o750);
    fs.chmodSync(f.transcript, 0o640);
    fs.writeFileSync(f.transcript, '{"changed":true}\n');
    fs.chmodSync(f.transcript, 0o440);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/size mismatch|SHA-256 mismatch/);
  });

  it('rejects a symlink transcript', () => {
    const f = fixture();
    fs.chmodSync(f.dir, 0o750);
    const target = path.join(f.dir, 'target.jsonl');
    fs.renameSync(f.transcript, target);
    fs.symlinkSync(target, f.transcript);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/transcript must not be a symlink/);
  });

  it('rejects a manifest that names a path instead of one snapshot file', () => {
    const f = fixture();
    fs.chmodSync(f.dir, 0o750);
    fs.chmodSync(f.manifest, 0o640);
    const raw = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    raw.snapshot_file = '../transcript.jsonl';
    fs.writeFileSync(f.manifest, JSON.stringify(raw));
    fs.chmodSync(f.manifest, 0o440);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/snapshot_file/);
  });

  it('accepts an immutable complete multi-file batch manifest and returns its validated root', () => {
    const f = batchFixture();
    const result = validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid });
    expect(result.kind).toBe('batch');
    expect(result.transcriptPath).toBe(f.dir);
    expect(resolveBackfillTranscriptInput({ snapshotManifest: f.manifest }, { expectedOwnerUid: f.uid })).toBe(f.dir);
  });

  it('rejects an incomplete batch manifest before backfill', () => {
    const f = batchFixture();
    fs.chmodSync(f.dir, 0o750);
    fs.chmodSync(f.manifest, 0o640);
    const raw = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    raw.complete = false;
    fs.writeFileSync(f.manifest, JSON.stringify(raw));
    fs.chmodSync(f.manifest, 0o440);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/batch manifest must be complete/);
  });

  it('rejects an unmanifested JSONL file so directory discovery cannot bypass batch hashes', () => {
    const f = batchFixture();
    fs.chmodSync(f.dir, 0o750);
    const extra = path.join(f.dir, 'extra.jsonl');
    fs.writeFileSync(extra, '{}\n', { mode: 0o440 });
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/unmanifested JSONL file/);
  });

  it('rejects a changed batch payload even when the file stays immutable at validation time', () => {
    const f = batchFixture();
    const file = f.files[1];
    const nested = path.dirname(file);
    fs.chmodSync(f.dir, 0o750);
    fs.chmodSync(nested, 0o750);
    fs.chmodSync(file, 0o640);
    fs.writeFileSync(file, '{"changed":true}\n');
    fs.chmodSync(file, 0o440);
    fs.chmodSync(nested, 0o550);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/size mismatch|SHA-256 mismatch/);
  });

  it('rejects writable nested directories in a sealed batch snapshot', () => {
    const f = batchFixture();
    fs.chmodSync(path.join(f.dir, 'nested'), 0o750);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/batch directory nested must not be writable/);
  });

  it('rejects batch relative-path traversal before touching payload files', () => {
    const f = batchFixture();
    fs.chmodSync(f.dir, 0o750);
    fs.chmodSync(f.manifest, 0o640);
    const raw = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    raw.entries[0].relative_path = '../escape.jsonl';
    fs.writeFileSync(f.manifest, JSON.stringify(raw));
    fs.chmodSync(f.manifest, 0o440);
    fs.chmodSync(f.dir, 0o550);
    expect(() => validateBackfillSnapshot(f.manifest, { expectedOwnerUid: f.uid })).toThrow(/invalid batch entry relative_path/);
  });
});
