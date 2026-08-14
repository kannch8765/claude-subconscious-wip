import * as crypto from 'crypto';
import fs from 'fs';
import * as path from 'path';

export interface BackfillSnapshotManifestV1 {
  schema_version: 1;
  source_path: string;
  snapshot_file: string;
  sha256: string;
  size_bytes: number;
  exported_at: string;
}

export interface BackfillBatchSnapshotEntryV1 {
  relative_path: string;
  input_bytes: number;
  input_sha256: string;
  output_bytes: number;
  output_sha256: string;
  records: number;
  pairs_striped: number;
  records_striped: number;
  placeholders_seen_between_pairs: number;
}

export interface BackfillBatchSnapshotManifestV1 {
  schema_version: 1;
  input_root: string;
  output_root: string;
  complete: true;
  updated_at: string;
  entries: BackfillBatchSnapshotEntryV1[];
  summary: {
    files_total: number;
    files_processed: number;
    files_skipped: number;
    input_bytes: number;
    output_bytes: number;
    pairs_striped: number;
    records_striped: number;
  };
}

export type BackfillSnapshotManifest = BackfillSnapshotManifestV1 | BackfillBatchSnapshotManifestV1;

export interface ValidatedBackfillSnapshot {
  kind: 'file' | 'batch';
  manifestPath: string;
  snapshotDir: string;
  /** File snapshot payload, or the validated batch root for a batch snapshot. */
  transcriptPath: string;
  manifest: BackfillSnapshotManifest;
}

export interface BackfillSnapshotValidationOptions {
  expectedOwnerUid?: number;
}

function fail(message: string): never {
  throw new Error(`Invalid backfill snapshot: ${message}`);
}

function assertImmutableRegularFile(file: string, label: string, expectedOwnerUid: number | undefined): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!stat.isFile()) fail(`${label} must be a regular file`);
  if (expectedOwnerUid !== undefined && stat.uid !== expectedOwnerUid) {
    fail(`${label} must be owned by uid ${expectedOwnerUid}, got uid ${stat.uid}`);
  }
  if ((stat.mode & 0o222) !== 0) fail(`${label} must not be writable`);
  return stat;
}

function assertImmutableDirectory(
  dir: string,
  expectedOwnerUid: number | undefined,
  label = 'snapshot directory',
): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!stat.isDirectory()) fail(`${label} must be a directory`);
  if (expectedOwnerUid !== undefined && stat.uid !== expectedOwnerUid) {
    fail(`${label} must be owned by uid ${expectedOwnerUid}, got uid ${stat.uid}`);
  }
  if ((stat.mode & 0o222) !== 0) fail(`${label} must not be writable`);
}

function sha256File(file: string): string {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}

function parseFileManifest(value: Record<string, unknown>): BackfillSnapshotManifestV1 {
  if (typeof value.source_path !== 'string' || !path.isAbsolute(value.source_path)) fail('source_path must be absolute');
  if (typeof value.snapshot_file !== 'string' || !value.snapshot_file || path.basename(value.snapshot_file) !== value.snapshot_file || value.snapshot_file === '.' || value.snapshot_file === '..') {
    fail('snapshot_file must be one file name without path traversal');
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('sha256 must be a lowercase SHA-256 hex digest');
  if (!Number.isSafeInteger(value.size_bytes) || (value.size_bytes as number) < 0) fail('size_bytes must be a non-negative safe integer');
  if (typeof value.exported_at !== 'string' || !Number.isFinite(Date.parse(value.exported_at))) fail('exported_at must be an ISO-compatible timestamp');
  return value as unknown as BackfillSnapshotManifestV1;
}

function safeRelativeJsonlPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.includes('\\') || path.posix.isAbsolute(raw)) {
    fail('batch entry relative_path must be a relative POSIX path');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized === '.' || normalized === '..' || normalized.startsWith('../') || !normalized.endsWith('.jsonl')) {
    fail(`invalid batch entry relative_path: ${raw}`);
  }
  return normalized;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`);
  return value as number;
}

function nonNegativeCount(value: unknown, label: string): number {
  return nonNegativeSafeInteger(value, label);
}

function sha256Hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 hex digest`);
  return value;
}

function parseBatchEntry(raw: unknown, index: number): BackfillBatchSnapshotEntryV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`batch entry ${index} must be an object`);
  const value = raw as Record<string, unknown>;
  return {
    relative_path: safeRelativeJsonlPath(value.relative_path),
    input_bytes: nonNegativeSafeInteger(value.input_bytes, `batch entry ${index} input_bytes`),
    input_sha256: sha256Hex(value.input_sha256, `batch entry ${index} input_sha256`),
    output_bytes: nonNegativeSafeInteger(value.output_bytes, `batch entry ${index} output_bytes`),
    output_sha256: sha256Hex(value.output_sha256, `batch entry ${index} output_sha256`),
    records: nonNegativeCount(value.records, `batch entry ${index} records`),
    pairs_striped: nonNegativeCount(value.pairs_striped, `batch entry ${index} pairs_striped`),
    records_striped: nonNegativeCount(value.records_striped, `batch entry ${index} records_striped`),
    placeholders_seen_between_pairs: nonNegativeCount(value.placeholders_seen_between_pairs, `batch entry ${index} placeholders_seen_between_pairs`),
  };
}

function parseBatchManifest(value: Record<string, unknown>): BackfillBatchSnapshotManifestV1 {
  if (typeof value.input_root !== 'string' || !path.isAbsolute(value.input_root)) fail('batch input_root must be absolute');
  if (typeof value.output_root !== 'string' || !path.isAbsolute(value.output_root)) fail('batch output_root must be absolute');
  if (value.complete !== true) fail('batch manifest must be complete');
  if (typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) fail('batch updated_at must be an ISO-compatible timestamp');
  if (!Array.isArray(value.entries)) fail('batch entries must be an array');

  const entries = value.entries.map(parseBatchEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.relative_path)) fail(`duplicate batch entry relative_path: ${entry.relative_path}`);
    seen.add(entry.relative_path);
  }

  if (!value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary)) fail('batch summary must be an object');
  const rawSummary = value.summary as Record<string, unknown>;
  const summary = {
    files_total: nonNegativeCount(rawSummary.files_total, 'batch summary files_total'),
    files_processed: nonNegativeCount(rawSummary.files_processed, 'batch summary files_processed'),
    files_skipped: nonNegativeCount(rawSummary.files_skipped, 'batch summary files_skipped'),
    input_bytes: nonNegativeSafeInteger(rawSummary.input_bytes, 'batch summary input_bytes'),
    output_bytes: nonNegativeSafeInteger(rawSummary.output_bytes, 'batch summary output_bytes'),
    pairs_striped: nonNegativeCount(rawSummary.pairs_striped, 'batch summary pairs_striped'),
    records_striped: nonNegativeCount(rawSummary.records_striped, 'batch summary records_striped'),
  };

  if (summary.files_total !== entries.length) fail(`batch files_total mismatch: expected ${entries.length}, got ${summary.files_total}`);
  if (summary.files_processed + summary.files_skipped !== entries.length) fail('batch processed/skipped counts do not cover every entry');
  const inputBytes = entries.reduce((sum, entry) => sum + entry.input_bytes, 0);
  const outputBytes = entries.reduce((sum, entry) => sum + entry.output_bytes, 0);
  const pairsStriped = entries.reduce((sum, entry) => sum + entry.pairs_striped, 0);
  const recordsStriped = entries.reduce((sum, entry) => sum + entry.records_striped, 0);
  if (summary.input_bytes !== inputBytes) fail(`batch input_bytes mismatch: expected ${inputBytes}, got ${summary.input_bytes}`);
  if (summary.output_bytes !== outputBytes) fail(`batch output_bytes mismatch: expected ${outputBytes}, got ${summary.output_bytes}`);
  if (summary.pairs_striped !== pairsStriped) fail(`batch pairs_striped mismatch: expected ${pairsStriped}, got ${summary.pairs_striped}`);
  if (summary.records_striped !== recordsStriped) fail(`batch records_striped mismatch: expected ${recordsStriped}, got ${summary.records_striped}`);

  return {
    schema_version: 1,
    input_root: value.input_root,
    output_root: value.output_root,
    complete: true,
    updated_at: value.updated_at,
    entries,
    summary,
  };
}

function parseManifest(raw: unknown): BackfillSnapshotManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('manifest must be a JSON object');
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1) fail('unsupported manifest schema_version');
  if ('entries' in value || 'output_root' in value) return parseBatchManifest(value);
  return parseFileManifest(value);
}

function isBatchManifest(manifest: BackfillSnapshotManifest): manifest is BackfillBatchSnapshotManifestV1 {
  return 'entries' in manifest;
}

function validateBatchSnapshot(
  manifestPath: string,
  snapshotDir: string,
  manifest: BackfillBatchSnapshotManifestV1,
  expectedOwnerUid: number | undefined,
): ValidatedBackfillSnapshot {
  if (path.resolve(manifest.output_root) !== snapshotDir) {
    fail(`batch output_root mismatch: expected ${snapshotDir}, got ${manifest.output_root}`);
  }
  const expected = new Map(manifest.entries.map((entry) => [entry.relative_path, entry]));
  const seen = new Set<string>();

  const visit = (dir: string): void => {
    const relDir = path.relative(snapshotDir, dir).split(path.sep).join('/');
    assertImmutableDirectory(dir, expectedOwnerUid, relDir ? `batch directory ${relDir}` : 'snapshot directory');
    for (const child of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(dir, child.name);
      const relative = path.relative(snapshotDir, candidate).split(path.sep).join('/');
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) fail(`batch payload must not contain symlink: ${relative}`);
      if (stat.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!stat.isFile()) fail(`batch payload must contain only regular files/directories: ${relative}`);
      if (candidate === manifestPath) continue;
      if (!relative.endsWith('.jsonl')) fail(`unexpected file in batch snapshot: ${relative}`);
      const entry = expected.get(relative);
      if (!entry) fail(`unmanifested JSONL file in batch snapshot: ${relative}`);
      const fileStat = assertImmutableRegularFile(candidate, `batch transcript ${relative}`, expectedOwnerUid);
      if (fileStat.size !== entry.output_bytes) {
        fail(`batch transcript size mismatch for ${relative}: expected ${entry.output_bytes}, got ${fileStat.size}`);
      }
      const digest = sha256File(candidate);
      if (digest !== entry.output_sha256) {
        fail(`batch transcript SHA-256 mismatch for ${relative}: expected ${entry.output_sha256}, got ${digest}`);
      }
      seen.add(relative);
    }
  };

  visit(snapshotDir);
  for (const relative of expected.keys()) {
    if (!seen.has(relative)) fail(`manifested batch transcript is missing: ${relative}`);
  }

  return { kind: 'batch', manifestPath, snapshotDir, transcriptPath: snapshotDir, manifest };
}

export function validateBackfillSnapshot(
  manifestFile: string,
  options: BackfillSnapshotValidationOptions = {},
): ValidatedBackfillSnapshot {
  const expectedOwnerUid = options.expectedOwnerUid ?? 0;
  const manifestPath = path.resolve(manifestFile);
  const snapshotDir = path.dirname(manifestPath);

  assertImmutableDirectory(snapshotDir, expectedOwnerUid);
  assertImmutableRegularFile(manifestPath, 'manifest', expectedOwnerUid);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const manifest = parseManifest(parsed);
  if (isBatchManifest(manifest)) return validateBatchSnapshot(manifestPath, snapshotDir, manifest, expectedOwnerUid);

  const transcriptPath = path.resolve(snapshotDir, manifest.snapshot_file);
  if (path.dirname(transcriptPath) !== snapshotDir) fail('snapshot_file escapes snapshot directory');

  const transcriptStat = assertImmutableRegularFile(transcriptPath, 'transcript', expectedOwnerUid);
  if (transcriptStat.size !== manifest.size_bytes) {
    fail(`transcript size mismatch: expected ${manifest.size_bytes}, got ${transcriptStat.size}`);
  }
  const actualSha256 = sha256File(transcriptPath);
  if (actualSha256 !== manifest.sha256) {
    fail(`transcript SHA-256 mismatch: expected ${manifest.sha256}, got ${actualSha256}`);
  }

  return { kind: 'file', manifestPath, snapshotDir, transcriptPath, manifest };
}

export interface BackfillTranscriptInput {
  transcript?: string;
  snapshotManifest?: string;
}

function assertNonPrivilegedDirectTranscript(transcriptPath: string): void {
  if (transcriptPath === '/root' || transcriptPath.startsWith('/root/')) {
    fail('direct /root transcript access is disabled; export an immutable owner snapshot and use --snapshot-manifest');
  }
  const privilegedSnapshotRoot = '/var/lib/subconscious-backfill-input';
  if (transcriptPath === privilegedSnapshotRoot || transcriptPath.startsWith(`${privilegedSnapshotRoot}/`)) {
    fail('direct privileged snapshot access is disabled; use the corresponding --snapshot-manifest');
  }
}

export function resolveBackfillTranscriptInput(
  input: BackfillTranscriptInput,
  options: BackfillSnapshotValidationOptions = {},
): string {
  if ((!input.transcript && !input.snapshotManifest) || (input.transcript && input.snapshotManifest)) {
    fail('exactly one transcript source must be supplied');
  }
  if (input.snapshotManifest) return validateBackfillSnapshot(path.resolve(input.snapshotManifest), options).transcriptPath;
  const transcriptPath = path.resolve(input.transcript!);
  assertNonPrivilegedDirectTranscript(transcriptPath);

  let filesystemTarget: string;
  try {
    filesystemTarget = fs.realpathSync(transcriptPath);
  } catch (error) {
    fail(`direct transcript source cannot be resolved (${error instanceof Error ? error.message : String(error)})`);
  }
  assertNonPrivilegedDirectTranscript(filesystemTarget);
  return filesystemTarget;
}
