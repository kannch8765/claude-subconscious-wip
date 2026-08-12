import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { once } from 'events';
import { fileURLToPath } from 'url';

export interface TranscriptSanitizeStats {
  input_path: string;
  output_path?: string;
  dry_run: boolean;
  input_bytes: number;
  output_bytes: number;
  bytes_saved: number;
  saved_ratio: number;
  records: number;
  retained_records: number;
  placeholder_records: number;
  type_counts: Record<string, number>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Keep only fields consumed by the current relationship-memory historical lane.
 *
 * Non-consumed records become `{}` instead of disappearing. This preserves one
 * output record per input record, so record-index based batching remains stable.
 * message.content is kept byte-for-byte at the JSON value level: content blocks,
 * their order, tool ids, inputs/results, and thinking are intentionally untouched.
 */
export function sanitizeTranscriptRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Transcript JSONL record must be an object.');
  }

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === 'summary') {
    return {
      type: 'summary',
      ...(hasOwn(record, 'summary') ? { summary: record.summary } : {}),
    };
  }

  if (type !== 'user' && type !== 'assistant') return {};

  const sanitized: Record<string, unknown> = { type };
  if (hasOwn(record, 'uuid')) sanitized.uuid = record.uuid;
  if (hasOwn(record, 'timestamp')) sanitized.timestamp = record.timestamp;

  const message = record.message;
  if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    const messageRecord = message as Record<string, unknown>;
    if (hasOwn(messageRecord, 'content')) {
      sanitized.message = { content: messageRecord.content };
    }
  }
  // Current consumers use message.content ?? content. Preserve top-level content
  // whenever present so null/absent nested content keeps exactly the same fallback.
  if (hasOwn(record, 'content')) sanitized.content = record.content;

  return sanitized;
}

async function writeWithBackpressure(stream: fs.WriteStream, value: string): Promise<void> {
  if (stream.write(value)) return;
  await once(stream, 'drain');
}

export async function sanitizeTranscriptFile(options: {
  inputPath: string;
  outputPath?: string;
  dryRun?: boolean;
}): Promise<TranscriptSanitizeStats> {
  const inputPath = path.resolve(options.inputPath);
  const dryRun = options.dryRun === true;
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : undefined;

  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`Transcript input must be an existing file: ${inputPath}`);
  }
  if (!dryRun && !outputPath) throw new Error('An output path is required unless --dry-run is used.');
  if (outputPath && outputPath === inputPath) throw new Error('Refusing in-place transcript sanitization. Choose a distinct output path.');
  if (!dryRun && outputPath && fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
  }

  const inputBytes = fs.statSync(inputPath).size;
  const typeCounts = new Map<string, number>();
  let outputBytes = 0;
  let records = 0;
  let retainedRecords = 0;
  let placeholderRecords = 0;

  let tempPath: string | undefined;
  let output: fs.WriteStream | undefined;
  if (!dryRun && outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
    output = fs.createWriteStream(tempPath, { encoding: 'utf8', flags: 'wx' });
  }

  const input = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let completed = false;

  try {
    for await (const line of lines) {
      records += 1;
      let original: unknown;
      if (!line.trim()) {
        original = {};
      } else {
        try {
          original = JSON.parse(line);
        } catch (error) {
          throw new Error(`Malformed transcript JSONL at line ${records}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const originalType = typeof original === 'object' && original !== null && !Array.isArray(original)
        ? String((original as Record<string, unknown>).type ?? '<missing>')
        : '<invalid>';
      typeCounts.set(originalType, (typeCounts.get(originalType) ?? 0) + 1);

      const sanitized = sanitizeTranscriptRecord(original);
      if (Object.keys(sanitized).length === 0) placeholderRecords += 1;
      else retainedRecords += 1;

      const serialized = `${JSON.stringify(sanitized)}\n`;
      outputBytes += Buffer.byteLength(serialized, 'utf8');
      if (output) await writeWithBackpressure(output, serialized);
    }

    if (output) {
      output.end();
      await once(output, 'close');
      output = undefined;
      fs.renameSync(tempPath!, outputPath!);
      tempPath = undefined;
    }
    completed = true;
  } finally {
    lines.close();
    input.destroy();
    if (output) output.destroy();
    if (!completed && tempPath) fs.rmSync(tempPath, { force: true });
  }

  const bytesSaved = inputBytes - outputBytes;
  return {
    input_path: inputPath,
    ...(outputPath ? { output_path: outputPath } : {}),
    dry_run: dryRun,
    input_bytes: inputBytes,
    output_bytes: outputBytes,
    bytes_saved: bytesSaved,
    saved_ratio: inputBytes === 0 ? 0 : bytesSaved / inputBytes,
    records,
    retained_records: retainedRecords,
    placeholder_records: placeholderRecords,
    type_counts: Object.fromEntries([...typeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function usage(): never {
  throw new Error('Usage: tsx scripts/sanitize_transcript.ts --input <transcript.jsonl> [--output <sanitized.jsonl>] [--dry-run]');
}

function parseArgs(argv: string[]): { inputPath: string; outputPath?: string; dryRun: boolean } {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') inputPath = argv[++i];
    else if (arg === '--output') outputPath = argv[++i];
    else if (arg === '--dry-run') dryRun = true;
    else usage();
  }
  if (!inputPath) usage();
  return { inputPath, outputPath, dryRun };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  sanitizeTranscriptFile(parseArgs(process.argv.slice(2)))
    .then((stats) => process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
