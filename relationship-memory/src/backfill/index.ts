import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CanonicalMessage } from '../schema/index.js';
import { buildCanonicalMessages } from '../adapter/index.js';
import { stableId } from '../store/index.js';
import { formatMessagesForLetta, type TranscriptMessage } from '../../../scripts/transcript_utils.js';

export interface BackfillAnchor {
  offset: number;
  length: number;
  sha256: string;
}

export interface BackfillSourceState {
  generation: number;
  committed_offset: number;
  anchors: BackfillAnchor[];
  last_batch_id?: string;
  reset_reason?: 'truncated' | 'checkpoint_mismatch';
  blocked?: { kind: 'malformed_jsonl' | 'oversized_record' | 'runtime_failure' | 'retryable_batch'; offset: number };
}

export interface BackfillState {
  schema_version: 1;
  backfill_session_id: string;
  conversation_id?: string;
  agent_id?: string;
  sources: Record<string, BackfillSourceState>;
}

export interface HistoricalBatch {
  batchId: string;
  sourcePath: string;
  generation: number;
  startOffset: number;
  endOffset: number;
  canonicalMessages: CanonicalMessage[];
  observerMessage: string;
  sessionId: string;
}

export interface BackfillBatchResult {
  completion: 'completed' | 'retryable_failure';
}

export type BackfillBatchProcessor = (batch: HistoricalBatch) => Promise<BackfillBatchResult>;

export interface RunBackfillOptions {
  transcriptPath: string;
  statePath: string;
  maxBatches?: number;
  maxRecordsPerBatch?: number;
  maxBatchBytes?: number;
  processor: BackfillBatchProcessor;
}

export interface BackfillRunResult {
  status: 'completed' | 'no-op' | 'blocked-failure';
  batchesProcessed: number;
  sourcesVisited: number;
  detail?: string;
  sourcePath?: string;
  offset?: number;
}

interface ReadBatchResult {
  records: TranscriptMessage[];
  endOffset: number;
  partialTail: boolean;
  malformedOffset?: number;
  oversizedOffset?: number;
}

const DEFAULT_MAX_RECORDS = 40;
const DEFAULT_MAX_BATCH_BYTES = 2 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;
const ANCHOR_SIZE = 4096;

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function loadBackfillState(file: string): BackfillState {
  if (!fs.existsSync(file)) {
    return {
      schema_version: 1,
      backfill_session_id: `relationship-memory-backfill-${crypto.randomUUID()}`,
      sources: {},
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BackfillState;
  if (parsed.schema_version !== 1 || !parsed.backfill_session_id || !parsed.sources || typeof parsed.sources !== 'object') {
    throw new Error('Unsupported or malformed relationship-memory backfill state.');
  }
  return parsed;
}

export function saveBackfillState(file: string, state: BackfillState): void {
  atomicWriteJson(file, state);
}

export function discoverTranscriptSources(entry: string): string[] {
  const absolute = path.resolve(entry);
  if (!fs.existsSync(absolute)) throw new Error(`Transcript path does not exist: ${absolute}`);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (!absolute.endsWith('.jsonl')) throw new Error(`Transcript file must end in .jsonl: ${absolute}`);
    return [absolute];
  }
  if (!stat.isDirectory()) throw new Error(`Transcript path is not a file or directory: ${absolute}`);

  const found: string[] = [];
  const visit = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of entries) {
      if (child.isSymbolicLink()) continue;
      const candidate = path.join(dir, child.name);
      if (child.isDirectory()) visit(candidate);
      else if (child.isFile() && child.name.endsWith('.jsonl')) found.push(candidate);
    }
  };
  visit(absolute);
  return found.sort((a, b) => a.localeCompare(b));
}

function readAt(file: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function anchorOffsets(committedOffset: number): number[] {
  if (committedOffset <= 0) return [];
  const maxStart = Math.max(0, committedOffset - ANCHOR_SIZE);
  const candidates = [
    0,
    Math.floor(committedOffset / 3),
    Math.floor((committedOffset * 2) / 3),
    maxStart,
  ].map((offset) => Math.max(0, Math.min(maxStart, offset)));
  return [...new Set(candidates)].sort((a, b) => a - b);
}

export function checkpointAnchors(file: string, committedOffset: number): BackfillAnchor[] {
  return anchorOffsets(committedOffset).map((offset) => {
    const length = Math.min(ANCHOR_SIZE, committedOffset - offset);
    const content = readAt(file, offset, length);
    return { offset, length: content.length, sha256: sha256(content) };
  });
}

function checkpointIsValid(file: string, source: BackfillSourceState): boolean {
  if (source.committed_offset === 0) return true;
  const stat = fs.statSync(file);
  if (stat.size < source.committed_offset) return false;
  return source.anchors.every((anchor) => {
    const content = readAt(file, anchor.offset, anchor.length);
    return content.length === anchor.length && sha256(content) === anchor.sha256;
  });
}

function normalizeSourceState(file: string, state: BackfillState): BackfillSourceState {
  const existing = state.sources[file] ?? { generation: 1, committed_offset: 0, anchors: [] };
  const stat = fs.statSync(file);
  let resetReason: BackfillSourceState['reset_reason'];
  if (stat.size < existing.committed_offset) resetReason = 'truncated';
  else if (!checkpointIsValid(file, existing)) resetReason = 'checkpoint_mismatch';
  if (!resetReason) {
    state.sources[file] = existing;
    return existing;
  }
  const reset: BackfillSourceState = {
    generation: existing.generation + 1,
    committed_offset: 0,
    anchors: [],
    reset_reason: resetReason,
  };
  state.sources[file] = reset;
  return reset;
}

function parseLine(line: Buffer, lineOffset: number): TranscriptMessage | { malformedOffset: number } {
  const text = line.toString('utf8').trim();
  if (!text) return {} as TranscriptMessage;
  try { return JSON.parse(text) as TranscriptMessage; }
  catch { return { malformedOffset: lineOffset }; }
}

function readRecordBatch(file: string, startOffset: number, maxRecords: number, maxBytes: number): ReadBatchResult {
  const fd = fs.openSync(file, 'r');
  try {
    const records: TranscriptMessage[] = [];
    let fileOffset = startOffset;
    let committedEnd = startOffset;
    let pending = Buffer.alloc(0);
    let pendingStart = startOffset;
    let consumed = 0;
    let eof = false;

    while (records.length < maxRecords && !eof) {
      const chunk = Buffer.alloc(READ_CHUNK);
      const read = fs.readSync(fd, chunk, 0, chunk.length, fileOffset);
      if (read === 0) { eof = true; break; }
      const data = chunk.subarray(0, read);
      fileOffset += read;
      consumed += read;
      pending = Buffer.concat([pending, data]);

      let newline: number;
      while (records.length < maxRecords && (newline = pending.indexOf(0x0a)) >= 0) {
        const raw = pending.subarray(0, newline);
        const lineEnd = pendingStart + newline + 1;
        if (lineEnd - startOffset > maxBytes && records.length === 0) {
          return { records: [], endOffset: startOffset, partialTail: false, oversizedOffset: pendingStart };
        }
        if (lineEnd - startOffset > maxBytes) return { records, endOffset: committedEnd, partialTail: false };
        const parsed = parseLine(raw, pendingStart);
        if ('malformedOffset' in parsed) {
          return { records: [], endOffset: startOffset, partialTail: false, malformedOffset: parsed.malformedOffset };
        }
        if (Object.keys(parsed).length > 0) records.push(parsed);
        committedEnd = lineEnd;
        pending = pending.subarray(newline + 1);
        pendingStart = lineEnd;
      }
      if (consumed > maxBytes + READ_CHUNK && records.length === 0 && pending.indexOf(0x0a) < 0) {
        return { records: [], endOffset: startOffset, partialTail: false, oversizedOffset: pendingStart };
      }
      if (records.length >= maxRecords || (committedEnd - startOffset) >= maxBytes) break;
    }

    return { records, endOffset: committedEnd, partialTail: eof && pending.length > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function historicalConversationId(file: string, generation: number): string {
  return stableId('historical_conversation', { source: file, generation });
}

function observerEnvelope(file: string, generation: number, records: TranscriptMessage[], canonical: CanonicalMessage[]): string {
  const entries = formatMessagesForLetta(records, -1).map((message) => {
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'claude_code' : 'system';
    const escaped = message.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<message role="${role}">\n${escaped}\n</message>`;
  }).join('\n');
  return `<relationship_memory_historical_backfill>\n<source>${path.basename(file)}</source>\n<generation>${generation}</generation>\n<processable_evidence_count>${canonical.length}</processable_evidence_count>\n<transcript>\n${entries}\n</transcript>\n<instructions>Process this bounded historical passage using the same relationship-memory observer semantics as live observation. Search before remembering. Only evidence IDs from the trusted relationship-memory evidence catalog may justify memory_remember proposals.</instructions>\n</relationship_memory_historical_backfill>`;
}

export function buildHistoricalBatch(file: string, source: BackfillSourceState, records: TranscriptMessage[], startOffset: number, endOffset: number, backfillSessionId: string): HistoricalBatch {
  const conversationId = historicalConversationId(file, source.generation);
  const canonical = buildCanonicalMessages(records, -1, conversationId);
  const batchId = stableId('historical_batch', {
    source: file,
    generation: source.generation,
    start_offset: startOffset,
    end_offset: endOffset,
  });
  return {
    batchId,
    sourcePath: file,
    generation: source.generation,
    startOffset,
    endOffset,
    canonicalMessages: canonical,
    observerMessage: observerEnvelope(file, source.generation, records, canonical),
    sessionId: `${backfillSessionId}:${stableId('source', { file, generation: source.generation })}`,
  };
}

export async function runHistoricalBackfill(options: RunBackfillOptions): Promise<BackfillRunResult> {
  const maxBatches = Math.max(1, options.maxBatches ?? 1);
  const maxRecords = Math.max(1, options.maxRecordsPerBatch ?? DEFAULT_MAX_RECORDS);
  const maxBytes = Math.max(1024, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
  const sources = discoverTranscriptSources(options.transcriptPath);
  const state = loadBackfillState(options.statePath);
  let batchesProcessed = 0;
  let sourcesVisited = 0;
  let sawPartialTail = false;

  for (const sourcePath of sources) {
    if (batchesProcessed >= maxBatches) break;
    sourcesVisited += 1;
    const before = state.sources[sourcePath];
    const source = normalizeSourceState(sourcePath, state);
    if (!before || source !== before) saveBackfillState(options.statePath, state);

    while (batchesProcessed < maxBatches) {
      const start = source.committed_offset;
      const next = readRecordBatch(sourcePath, start, maxRecords, maxBytes);
      if (next.malformedOffset !== undefined) {
        source.blocked = { kind: 'malformed_jsonl', offset: next.malformedOffset };
        saveBackfillState(options.statePath, state);
        return {
          status: 'blocked-failure', batchesProcessed, sourcesVisited,
          detail: 'malformed JSONL record', sourcePath, offset: next.malformedOffset,
        };
      }
      if (next.oversizedOffset !== undefined) {
        source.blocked = { kind: 'oversized_record', offset: next.oversizedOffset };
        saveBackfillState(options.statePath, state);
        return {
          status: 'blocked-failure', batchesProcessed, sourcesVisited,
          detail: 'JSONL record exceeds bounded batch byte limit', sourcePath, offset: next.oversizedOffset,
        };
      }
      if (next.records.length === 0 || next.endOffset === start) {
        sawPartialTail ||= next.partialTail;
        break;
      }

      const batch = buildHistoricalBatch(sourcePath, source, next.records, start, next.endOffset, state.backfill_session_id);
      let result: BackfillBatchResult;
      try { result = await options.processor(batch); }
      catch (error) {
        source.blocked = { kind: 'runtime_failure', offset: start };
        saveBackfillState(options.statePath, state);
        return {
          status: 'blocked-failure', batchesProcessed, sourcesVisited,
          detail: `backfill runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
          sourcePath, offset: start,
        };
      }
      if (result.completion !== 'completed') {
        source.blocked = { kind: 'retryable_batch', offset: start };
        saveBackfillState(options.statePath, state);
        return {
          status: 'blocked-failure', batchesProcessed, sourcesVisited,
          detail: 'relationship-memory batch is retryable/unfinalized', sourcePath, offset: start,
        };
      }

      source.committed_offset = next.endOffset;
      source.anchors = checkpointAnchors(sourcePath, source.committed_offset);
      source.last_batch_id = batch.batchId;
      delete source.reset_reason;
      delete source.blocked;
      saveBackfillState(options.statePath, state);
      batchesProcessed += 1;
      sawPartialTail ||= next.partialTail;
    }
  }

  if (batchesProcessed === 0) {
    return {
      status: 'no-op', batchesProcessed, sourcesVisited,
      ...(sawPartialTail ? { detail: 'no complete uncommitted JSONL records; partial tail held' } : {}),
    };
  }
  return { status: 'completed', batchesProcessed, sourcesVisited };
}
