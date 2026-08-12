import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeTranscriptFile } from './sanitize_transcript.js';

const MANIFEST_SCHEMA_VERSION = 1;
const DEFAULT_EXCLUDED_SEGMENTS = new Set(['archive', 'subagents']);

export interface TranscriptBatchManifestEntry {
  relative_path: string;
  input_sha256: string;
  input_bytes: number;
  output_sha256: string;
  output_bytes: number;
  bytes_saved: number;
  saved_ratio: number;
  records: number;
  retained_records: number;
  placeholder_records: number;
  type_counts: Record<string, number>;
}

export interface TranscriptBatchSummary {
  files_total: number;
  files_processed: number;
  files_skipped: number;
  input_bytes: number;
  output_bytes: number;
  bytes_saved: number;
  saved_ratio: number;
}

export interface TranscriptBatchManifest {
  schema_version: number;
  complete: boolean;
  source_root: string;
  output_root: string;
  excluded_segments: string[];
  entries: TranscriptBatchManifestEntry[];
  summary: TranscriptBatchSummary;
  updated_at: string;
}

export interface TranscriptBatchResult {
  dry_run: boolean;
  manifest_path?: string;
  summary: TranscriptBatchSummary;
  entries: TranscriptBatchManifestEntry[];
}

function toPosixRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function rootsOverlap(a: string, b: string): boolean {
  const relAB = path.relative(a, b);
  const relBA = path.relative(b, a);
  const within = (rel: string) => rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return within(relAB) || within(relBA);
}

function listTranscriptFiles(root: string, excludedSegments: Set<string>): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedSegments.has(entry.name)) visit(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function summarize(entries: TranscriptBatchManifestEntry[], processed: number, skipped: number): TranscriptBatchSummary {
  const inputBytes = entries.reduce((sum, entry) => sum + entry.input_bytes, 0);
  const outputBytes = entries.reduce((sum, entry) => sum + entry.output_bytes, 0);
  const bytesSaved = inputBytes - outputBytes;
  return {
    files_total: entries.length,
    files_processed: processed,
    files_skipped: skipped,
    input_bytes: inputBytes,
    output_bytes: outputBytes,
    bytes_saved: bytesSaved,
    saved_ratio: inputBytes === 0 ? 0 : bytesSaved / inputBytes,
  };
}

function writeManifestAtomic(manifestPath: string, manifest: TranscriptBatchManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(tempPath, manifestPath);
}

function readExistingManifest(manifestPath: string, sourceRoot: string, outputRoot: string): TranscriptBatchManifest | undefined {
  if (!fs.existsSync(manifestPath)) return undefined;
  let parsed: TranscriptBatchManifest;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TranscriptBatchManifest;
  } catch (error) {
    throw new Error(`Cannot parse existing sanitizer manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.schema_version !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported sanitizer manifest schema_version: ${String(parsed.schema_version)}`);
  }
  if (path.resolve(parsed.source_root) !== sourceRoot || path.resolve(parsed.output_root) !== outputRoot) {
    throw new Error('Existing sanitizer manifest belongs to a different source/output root.');
  }
  if (!Array.isArray(parsed.entries)) throw new Error('Existing sanitizer manifest has invalid entries.');
  return parsed;
}

export async function sanitizeTranscriptBatch(options: {
  inputRoot: string;
  outputRoot: string;
  dryRun?: boolean;
}): Promise<TranscriptBatchResult> {
  const inputRoot = path.resolve(options.inputRoot);
  const outputRoot = path.resolve(options.outputRoot);
  const dryRun = options.dryRun === true;

  if (!fs.existsSync(inputRoot) || !fs.statSync(inputRoot).isDirectory()) {
    throw new Error(`Transcript input root must be an existing directory: ${inputRoot}`);
  }
  if (rootsOverlap(inputRoot, outputRoot)) {
    throw new Error('Transcript input and output roots must be disjoint directories.');
  }

  const excludedSegments = new Set(DEFAULT_EXCLUDED_SEGMENTS);
  const inputFiles = listTranscriptFiles(inputRoot, excludedSegments);
  const relativePaths = inputFiles.map((filePath) => toPosixRelative(path.relative(inputRoot, filePath)));
  const manifestPath = path.join(outputRoot, 'manifest.json');
  const existing = dryRun ? undefined : readExistingManifest(manifestPath, inputRoot, outputRoot);
  const priorEntries = new Map((existing?.entries ?? []).map((entry) => [entry.relative_path, entry]));
  const currentEntries = new Map<string, TranscriptBatchManifestEntry>();
  let processed = 0;
  let skipped = 0;

  const persist = (complete: boolean) => {
    if (dryRun) return;
    const entries = relativePaths.flatMap((relativePath) => {
      const entry = currentEntries.get(relativePath) ?? priorEntries.get(relativePath);
      return entry ? [entry] : [];
    });
    writeManifestAtomic(manifestPath, {
      schema_version: MANIFEST_SCHEMA_VERSION,
      complete,
      source_root: inputRoot,
      output_root: outputRoot,
      excluded_segments: [...excludedSegments].sort(),
      entries,
      summary: summarize(entries, processed, skipped),
      updated_at: new Date().toISOString(),
    });
  };

  for (let i = 0; i < inputFiles.length; i++) {
    const inputPath = inputFiles[i];
    const relativePath = relativePaths[i];
    const outputPath = path.join(outputRoot, ...relativePath.split('/'));
    const inputBytes = fs.statSync(inputPath).size;
    const inputSha256 = await sha256File(inputPath);
    const prior = priorEntries.get(relativePath);

    if (!dryRun && prior && prior.input_sha256 === inputSha256 && prior.input_bytes === inputBytes && fs.existsSync(outputPath)) {
      const outputBytes = fs.statSync(outputPath).size;
      const outputSha256 = await sha256File(outputPath);
      if (outputBytes === prior.output_bytes && outputSha256 === prior.output_sha256) {
        currentEntries.set(relativePath, prior);
        skipped += 1;
        persist(false);
        continue;
      }
    }

    if (!dryRun && fs.existsSync(outputPath)) {
      throw new Error(`Refusing ambiguous existing output without a matching manifest entry: ${outputPath}`);
    }

    const stats = await sanitizeTranscriptFile({ inputPath, outputPath, dryRun });
    let outputSha256 = '<dry-run>';
    if (!dryRun) outputSha256 = await sha256File(outputPath);
    const entry: TranscriptBatchManifestEntry = {
      relative_path: relativePath,
      input_sha256: inputSha256,
      input_bytes: inputBytes,
      output_sha256: outputSha256,
      output_bytes: stats.output_bytes,
      bytes_saved: stats.bytes_saved,
      saved_ratio: stats.saved_ratio,
      records: stats.records,
      retained_records: stats.retained_records,
      placeholder_records: stats.placeholder_records,
      type_counts: stats.type_counts,
    };
    currentEntries.set(relativePath, entry);
    processed += 1;
    persist(false);
  }

  const entries = relativePaths.map((relativePath) => currentEntries.get(relativePath)!).filter(Boolean);
  const summary = summarize(entries, processed, skipped);
  if (!dryRun) {
    writeManifestAtomic(manifestPath, {
      schema_version: MANIFEST_SCHEMA_VERSION,
      complete: true,
      source_root: inputRoot,
      output_root: outputRoot,
      excluded_segments: [...excludedSegments].sort(),
      entries,
      summary,
      updated_at: new Date().toISOString(),
    });
  }

  return {
    dry_run: dryRun,
    ...(dryRun ? {} : { manifest_path: manifestPath }),
    summary,
    entries,
  };
}

function usage(): never {
  throw new Error('Usage: tsx scripts/sanitize_transcript_batch.ts --input-root <raw-root> --output-root <sanitized-root> [--dry-run]');
}

function parseArgs(argv: string[]): { inputRoot: string; outputRoot: string; dryRun: boolean } {
  let inputRoot: string | undefined;
  let outputRoot: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input-root') inputRoot = argv[++i];
    else if (arg === '--output-root') outputRoot = argv[++i];
    else if (arg === '--dry-run') dryRun = true;
    else usage();
  }
  if (!inputRoot || !outputRoot) usage();
  return { inputRoot, outputRoot, dryRun };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  sanitizeTranscriptBatch(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify({
      dry_run: result.dry_run,
      ...(result.manifest_path ? { manifest_path: result.manifest_path } : {}),
      summary: result.summary,
    }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
