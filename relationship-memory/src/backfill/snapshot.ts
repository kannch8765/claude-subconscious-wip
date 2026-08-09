import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface BackfillSnapshotManifestV1 {
  schema_version: 1;
  source_path: string;
  snapshot_file: string;
  sha256: string;
  size_bytes: number;
  exported_at: string;
}

export interface ValidatedBackfillSnapshot {
  manifestPath: string;
  snapshotDir: string;
  transcriptPath: string;
  manifest: BackfillSnapshotManifestV1;
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

function assertImmutableDirectory(dir: string, expectedOwnerUid: number | undefined): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) fail('snapshot directory must not be a symlink');
  if (!stat.isDirectory()) fail('snapshot directory must be a directory');
  if (expectedOwnerUid !== undefined && stat.uid !== expectedOwnerUid) {
    fail(`snapshot directory must be owned by uid ${expectedOwnerUid}, got uid ${stat.uid}`);
  }
  if ((stat.mode & 0o222) !== 0) fail('snapshot directory must not be writable');
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

function parseManifest(raw: unknown): BackfillSnapshotManifestV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('manifest must be a JSON object');
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== 1) fail('unsupported manifest schema_version');
  if (typeof value.source_path !== 'string' || !path.isAbsolute(value.source_path)) fail('source_path must be absolute');
  if (typeof value.snapshot_file !== 'string' || !value.snapshot_file || path.basename(value.snapshot_file) !== value.snapshot_file || value.snapshot_file === '.' || value.snapshot_file === '..') {
    fail('snapshot_file must be one file name without path traversal');
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('sha256 must be a lowercase SHA-256 hex digest');
  if (!Number.isSafeInteger(value.size_bytes) || (value.size_bytes as number) < 0) fail('size_bytes must be a non-negative safe integer');
  if (typeof value.exported_at !== 'string' || !Number.isFinite(Date.parse(value.exported_at))) fail('exported_at must be an ISO-compatible timestamp');
  return value as unknown as BackfillSnapshotManifestV1;
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

  return { manifestPath, snapshotDir, transcriptPath, manifest };
}

export interface BackfillTranscriptInput {
  transcript?: string;
  snapshotManifest?: string;
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
  if (transcriptPath === '/root' || transcriptPath.startsWith('/root/')) {
    fail('direct /root transcript access is disabled; export an immutable owner snapshot and use --snapshot-manifest');
  }
  const privilegedSnapshotRoot = '/var/lib/subconscious-backfill-input';
  if (transcriptPath === privilegedSnapshotRoot || transcriptPath.startsWith(`${privilegedSnapshotRoot}/`)) {
    fail('direct privileged snapshot access is disabled; use the corresponding --snapshot-manifest');
  }
  return transcriptPath;
}
