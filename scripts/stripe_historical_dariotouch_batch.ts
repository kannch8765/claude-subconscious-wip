import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { stripeHistoricalDarioTouchFile } from './stripe_historical_dariotouch.js';

const MANIFEST_SCHEMA_VERSION = 1;

interface ManifestEntry {
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

interface Manifest {
  schema_version: number;
  input_root: string;
  output_root: string;
  complete: boolean;
  updated_at: string;
  entries: ManifestEntry[];
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

function rootsOverlap(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(relative(root, path));
    }
  }
  await walk(root);
  return found;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function summarize(entries: ManifestEntry[], total: number, processed: number, skipped: number): Manifest['summary'] {
  return {
    files_total: total,
    files_processed: processed,
    files_skipped: skipped,
    input_bytes: entries.reduce((sum, entry) => sum + entry.input_bytes, 0),
    output_bytes: entries.reduce((sum, entry) => sum + entry.output_bytes, 0),
    pairs_striped: entries.reduce((sum, entry) => sum + entry.pairs_striped, 0),
    records_striped: entries.reduce((sum, entry) => sum + entry.records_striped, 0),
  };
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

async function readManifest(path: string, inputRoot: string, outputRoot: string): Promise<Manifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Manifest;
    if (parsed.schema_version !== MANIFEST_SCHEMA_VERSION || parsed.input_root !== inputRoot || parsed.output_root !== outputRoot) {
      throw new Error('Existing manifest does not match this DarioTouch stripe run');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function stripeHistoricalDarioTouchBatch(inputRootArg: string, outputRootArg: string): Promise<Manifest> {
  const inputRoot = resolve(inputRootArg);
  const outputRoot = resolve(outputRootArg);
  if (rootsOverlap(inputRoot, outputRoot)) throw new Error('Input and output roots must be disjoint');

  const inputStat = await stat(inputRoot);
  if (!inputStat.isDirectory()) throw new Error(`Input root is not a directory: ${inputRoot}`);

  const relativePaths = await listJsonlFiles(inputRoot);
  const manifestPath = join(outputRoot, 'manifest.json');
  const prior = await readManifest(manifestPath, inputRoot, outputRoot);
  const byPath = new Map((prior?.entries ?? []).map((entry) => [entry.relative_path, entry]));
  const entries: ManifestEntry[] = [];
  let processed = 0;
  let skipped = 0;

  for (const relativePath of relativePaths) {
    const inputPath = join(inputRoot, relativePath);
    const outputPath = join(outputRoot, relativePath);
    const inputBytes = (await stat(inputPath)).size;
    const inputSha = await sha256(inputPath);
    const old = byPath.get(relativePath);

    if (old && old.input_bytes === inputBytes && old.input_sha256 === inputSha) {
      try {
        const outputBytes = (await stat(outputPath)).size;
        const outputSha = await sha256(outputPath);
        if (outputBytes === old.output_bytes && outputSha === old.output_sha256) {
          entries.push(old);
          skipped += 1;
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    try {
      await stat(outputPath);
      throw new Error(`Refusing ambiguous existing output without matching manifest entry: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const stats = await stripeHistoricalDarioTouchFile(inputPath, outputPath);
    const outputBytes = (await stat(outputPath)).size;
    const outputSha = await sha256(outputPath);
    const entry: ManifestEntry = {
      relative_path: relativePath,
      input_bytes: inputBytes,
      input_sha256: inputSha,
      output_bytes: outputBytes,
      output_sha256: outputSha,
      ...stats,
    };
    entries.push(entry);
    processed += 1;

    await writeManifest(manifestPath, {
      schema_version: MANIFEST_SCHEMA_VERSION,
      input_root: inputRoot,
      output_root: outputRoot,
      complete: false,
      updated_at: new Date().toISOString(),
      entries,
      summary: summarize(entries, relativePaths.length, processed, skipped),
    });
  }

  const manifest: Manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    input_root: inputRoot,
    output_root: outputRoot,
    complete: true,
    updated_at: new Date().toISOString(),
    entries,
    summary: summarize(entries, relativePaths.length, processed, skipped),
  };
  await writeManifest(manifestPath, manifest);
  return manifest;
}

function parseArgs(argv: string[]): { inputRoot: string; outputRoot: string } {
  let inputRoot: string | undefined;
  let outputRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input-root') inputRoot = argv[++index];
    else if (arg === '--output-root') outputRoot = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!inputRoot || !outputRoot) throw new Error('Usage: stripe_historical_dariotouch_batch.ts --input-root <093an-root> --output-root <striped-root>');
  return { inputRoot, outputRoot };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { inputRoot, outputRoot } = parseArgs(process.argv.slice(2));
  stripeHistoricalDarioTouchBatch(inputRoot, outputRoot)
    .then((manifest) => process.stdout.write(`${JSON.stringify(manifest.summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
