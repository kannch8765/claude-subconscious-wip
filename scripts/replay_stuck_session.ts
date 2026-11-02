#!/usr/bin/env npx tsx
/**
 * Stuck-session replay: push the cursor backlog of an ended Claude session through the normal async live lane in
 * bounded chunks. An ended session never gets another Stop hook, and its whole backlog as one batch would not fit a
 * turn, so its remember intents stay unresolved forever.
 *
 * Each chunk is exactly what the Stop hook would have sent if the transcript had ended there (same payload builder,
 * same worker, same batch outcome rules), so memories, intents and the cursor converge the same way. The cursor
 * advances once per completed chunk; the first chunk that does not complete stops the run, and a rerun resumes from
 * the cursor.
 *
 * Usage (as the Kohaku runtime user, with the Stop hook's environment):
 *   npx tsx scripts/replay_stuck_session.ts --session <id> --transcript <path> --cwd <cwd> [--plan]
 *     [--max-messages 40] [--max-chars 60000] [--max-chunks N]
 *
 * --plan reads the transcript and the sync state only: no Letta calls, no store or state writes.
 * Output is metadata only (indices, counts, sizes, durations, outcomes), one JSON object per line.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getTempStateDir, loadSyncState } from './conversation_utils.js';
import { buildLiveBatch } from './send_messages_to_letta.js';
import { runNativeWorkerPayloadFile } from './send_worker_native.js';
import { extractAllContent, formatMessagesForLetta, readTranscript, type TranscriptMessage } from './transcript_utils.js';
import { isAssistantRememberToolName } from '../relationship-memory/src/intent/index.js';

export interface ReplayLimits {
  maxMessages: number;
  maxChars: number;
}

export interface ReplayChunk {
  start: number;
  end: number;
  /** Formatted transcript characters this chunk sends (what the Stop hook would put in <transcript>). */
  chars: number;
  rememberCalls: number;
}

/** Formatted size of one transcript message on its own (tool-name lookup across messages does not change the size much). */
function formattedChars(message: TranscriptMessage): number {
  return formatMessagesForLetta([message], -1).reduce((sum, item) => sum + item.text.length, 0);
}

function isTurnStart(message: TranscriptMessage | undefined): boolean {
  return message?.type === 'user' && Boolean(extractAllContent(message).text?.trim());
}

function rememberCalls(message: TranscriptMessage): number {
  if (message.type !== 'assistant') return 0;
  const content = message.message?.content ?? message.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block: any) => block?.type === 'tool_use' && isAssistantRememberToolName(block.name)).length;
}

/**
 * Split everything after the cursor into chunks of at most `maxMessages` messages and `maxChars` formatted characters
 * (a single oversized message still gets its own chunk). A chunk that is not the last one ends just before a user
 * turn when one fits, so a batch carries whole exchanges. Messages that format to nothing ride along with the next
 * chunk, because the Stop hook sends nothing (and moves no cursor) for them.
 */
export function planReplayChunks(messages: TranscriptMessage[], lastProcessedIndex: number, limits: ReplayLimits): ReplayChunk[] {
  const sizes = messages.map(formattedChars);
  const chunks: ReplayChunk[] = [];
  let start = lastProcessedIndex + 1;
  while (start < messages.length) {
    let end = start;
    let chars = sizes[start];
    while (end + 1 < messages.length && end + 1 - start + 1 <= limits.maxMessages && chars + sizes[end + 1] <= limits.maxChars) {
      end += 1;
      chars += sizes[end];
    }
    if (end + 1 < messages.length) {
      let boundary = end;
      while (boundary > start && !isTurnStart(messages[boundary + 1])) boundary -= 1;
      if (isTurnStart(messages[boundary + 1])) end = boundary;
    }
    chars = sizes.slice(start, end + 1).reduce((sum, size) => sum + size, 0);
    const last = chunks[chunks.length - 1];
    if (last && last.chars === 0) {
      last.end = end;
      last.chars = chars;
      last.rememberCalls += messages.slice(start, end + 1).reduce((sum, m) => sum + rememberCalls(m), 0);
    } else {
      chunks.push({ start, end, chars, rememberCalls: messages.slice(start, end + 1).reduce((sum, m) => sum + rememberCalls(m), 0) });
    }
    start = end + 1;
  }
  return chunks;
}

interface ReplayArgs extends ReplayLimits {
  session: string;
  transcript: string;
  cwd: string;
  plan: boolean;
  maxChunks: number;
}

function positive(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export function parseReplayArgs(argv: string[]): ReplayArgs {
  const args: Partial<ReplayArgs> = { plan: false, maxMessages: 40, maxChars: 60_000, maxChunks: Number.MAX_SAFE_INTEGER };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--plan') args.plan = true;
    else if (flag === '--session') { args.session = value; i += 1; }
    else if (flag === '--transcript') { args.transcript = value; i += 1; }
    else if (flag === '--cwd') { args.cwd = value; i += 1; }
    else if (flag === '--max-messages') { args.maxMessages = positive(value, flag); i += 1; }
    else if (flag === '--max-chars') { args.maxChars = positive(value, flag); i += 1; }
    else if (flag === '--max-chunks') { args.maxChunks = positive(value, flag); i += 1; }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.session || !args.transcript || !args.cwd) throw new Error('--session, --transcript and --cwd are required');
  return args as ReplayArgs;
}

function emit(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

export async function replayStuckSession(args: ReplayArgs): Promise<boolean> {
  const messages = await readTranscript(args.transcript);
  const cursor = loadSyncState(args.cwd, args.session).lastProcessedIndex;
  const plan = planReplayChunks(messages, cursor, args);
  emit({
    event: 'plan', messages: messages.length, cursor, chunks: plan.length,
    chars: plan.reduce((sum, chunk) => sum + chunk.chars, 0),
    remember_calls: plan.reduce((sum, chunk) => sum + chunk.rememberCalls, 0),
    max_chunk_chars: Math.max(0, ...plan.map((chunk) => chunk.chars)),
  });
  if (args.plan) {
    for (const chunk of plan) emit({ event: 'chunk_plan', ...chunk });
    return true;
  }

  const hookInput = { session_id: args.session, transcript_path: args.transcript, cwd: args.cwd };
  for (let n = 0; n < args.maxChunks; n++) {
    const before = loadSyncState(args.cwd, args.session).lastProcessedIndex;
    const [chunk] = planReplayChunks(messages, before, args);
    if (!chunk) { emit({ event: 'done', cursor: before }); return true; }
    const batch = await buildLiveBatch(hookInput, messages.slice(0, chunk.end + 1));
    if (!batch) { emit({ event: 'done', cursor: before, reason: 'nothing_to_send' }); return true; }

    const payloadFile = path.join(getTempStateDir(), `replay-payload-${args.session}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(payloadFile), { recursive: true });
    fs.writeFileSync(payloadFile, JSON.stringify(batch.payload), 'utf-8');
    const startedAt = Date.now();
    await runNativeWorkerPayloadFile(payloadFile);
    const after = loadSyncState(args.cwd, args.session).lastProcessedIndex;
    const completed = after === chunk.end;
    emit({
      event: 'chunk', ...chunk, batch: batch.payload.batchId.slice(0, 16), seconds: Math.round((Date.now() - startedAt) / 1000),
      cursor_before: before, cursor_after: after, outcome: completed ? 'completed' : 'held',
    });
    if (!completed) return false;
  }
  emit({ event: 'stopped', reason: 'max_chunks', cursor: loadSyncState(args.cwd, args.session).lastProcessedIndex });
  return true;
}

const invokedAsMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  replayStuckSession(parseReplayArgs(process.argv.slice(2)))
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      console.error(`replay failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
