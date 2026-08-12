import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

export const DARIO_TOUCH_TEXT = '🫳';

export interface DarioTouchStripeStats {
  records: number;
  pairs_striped: number;
  records_striped: number;
  placeholders_seen_between_pairs: number;
}

function isPlainEmptyObject(value: unknown): value is Record<string, never> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0;
}

function semanticTextBlocks(record: unknown): string[] | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const row = record as Record<string, unknown>;
  const message = row.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;

  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
    const typed = block as Record<string, unknown>;
    if (typed.type !== 'text' || typeof typed.text !== 'string') return null;
    texts.push(typed.text);
  }
  return texts;
}

export function isExactDarioTouchRecord(record: unknown, role: 'user' | 'assistant'): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const row = record as Record<string, unknown>;
  if (row.type !== role) return false;
  const texts = semanticTextBlocks(record);
  return texts !== null && texts.length === 1 && texts[0] === DARIO_TOUCH_TEXT;
}

export function stripeDarioTouchRecords(records: unknown[]): { records: unknown[]; stats: DarioTouchStripeStats } {
  const output = [...records];
  let pairs = 0;
  let placeholdersBetweenPairs = 0;

  for (let index = 0; index < records.length; index += 1) {
    if (!isExactDarioTouchRecord(records[index], 'user')) continue;

    let next = index + 1;
    while (next < records.length && isPlainEmptyObject(records[next])) next += 1;
    if (next >= records.length || !isExactDarioTouchRecord(records[next], 'assistant')) continue;

    output[index] = {};
    output[next] = {};
    pairs += 1;
    placeholdersBetweenPairs += next - index - 1;
    index = next;
  }

  return {
    records: output,
    stats: {
      records: records.length,
      pairs_striped: pairs,
      records_striped: pairs * 2,
      placeholders_seen_between_pairs: placeholdersBetweenPairs,
    },
  };
}

async function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, 'drain');
}

export async function stripeHistoricalDarioTouchFile(inputPath: string, outputPath: string): Promise<DarioTouchStripeStats> {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error('Refusing in-place DarioTouch stripe');

  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error(`Input is not a file: ${input}`);

  try {
    await stat(output);
    throw new Error(`Refusing to overwrite existing output: ${output}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(output), { recursive: true });
  const temp = `${output}.tmp-${process.pid}-${Date.now()}`;
  const writer = createWriteStream(temp, { encoding: 'utf8', flags: 'wx' });
  const reader = createInterface({ input: createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity });

  let records = 0;
  let pairs = 0;
  let placeholdersBetweenPairs = 0;
  let pendingUserLine: string | null = null;
  let pendingPlaceholderLines: string[] = [];

  try {
    for await (const line of reader) {
      if (line.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`Malformed JSON at record ${records + 1}: ${(error as Error).message}`);
      }
      records += 1;

      if (pendingUserLine !== null) {
        if (isPlainEmptyObject(record)) {
          pendingPlaceholderLines.push(line);
          continue;
        }
        if (isExactDarioTouchRecord(record, 'assistant')) {
          await writeLine(writer, '{}');
          for (const placeholder of pendingPlaceholderLines) await writeLine(writer, placeholder);
          await writeLine(writer, '{}');
          pairs += 1;
          placeholdersBetweenPairs += pendingPlaceholderLines.length;
          pendingUserLine = null;
          pendingPlaceholderLines = [];
          continue;
        }

        await writeLine(writer, pendingUserLine);
        for (const placeholder of pendingPlaceholderLines) await writeLine(writer, placeholder);
        pendingUserLine = null;
        pendingPlaceholderLines = [];
      }

      if (isExactDarioTouchRecord(record, 'user')) {
        pendingUserLine = line;
      } else {
        await writeLine(writer, line);
      }
    }

    if (pendingUserLine !== null) {
      await writeLine(writer, pendingUserLine);
      for (const placeholder of pendingPlaceholderLines) await writeLine(writer, placeholder);
    }

    writer.end();
    await once(writer, 'close');
    await rename(temp, output);
  } catch (error) {
    reader.close();
    writer.destroy();
    await rm(temp, { force: true });
    throw error;
  }

  return {
    records,
    pairs_striped: pairs,
    records_striped: pairs * 2,
    placeholders_seen_between_pairs: placeholdersBetweenPairs,
  };
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') input = argv[++index];
    else if (arg === '--output') output = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input || !output) throw new Error('Usage: stripe_historical_dariotouch.ts --input <sanitized.jsonl> --output <striped.jsonl>');
  return { input, output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { input, output } = parseArgs(process.argv.slice(2));
  stripeHistoricalDarioTouchFile(input, output)
    .then((stats) => process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
