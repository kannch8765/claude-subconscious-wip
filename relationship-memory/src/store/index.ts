import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  BatchRecord,
  CanonicalMemoryRecord,
  EvidenceRecord,
  RememberOutcome,
} from '../schema/index.js';

export type StorePhase = 'memory_commit' | 'outcome_commit';
export type FailureInjector = (phase: StorePhase) => boolean;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

function appendJsonl(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24)}`;
}

export class RelationshipMemoryStore {
  readonly rootDir: string;
  readonly subjectId: string;
  readonly failureInjector?: FailureInjector;

  constructor(rootDir: string, subjectId: string, failureInjector?: FailureInjector) {
    this.rootDir = rootDir;
    this.subjectId = subjectId;
    this.failureInjector = failureInjector;
    ensureDir(rootDir);
  }

  private file(name: string): string { return path.join(this.rootDir, name); }

  listMemories(): CanonicalMemoryRecord[] { return readJsonl<CanonicalMemoryRecord>(this.file('memories.jsonl')); }
  listEvidence(): EvidenceRecord[] { return readJsonl<EvidenceRecord>(this.file('evidence.jsonl')); }
  listOutcomes(): RememberOutcome[] { return readJsonl<RememberOutcome>(this.file('outcomes.jsonl')); }
  listBatches(): BatchRecord[] { return readJsonl<BatchRecord>(this.file('batches.jsonl')); }

  getMemory(memoryId: string): CanonicalMemoryRecord | undefined {
    return this.listMemories().find((item) => item.memory_id === memoryId);
  }

  getMemoryBySourceKey(sourceKey: string): CanonicalMemoryRecord | undefined {
    return this.listMemories().find((item) => item.source_key === sourceKey);
  }

  getMemoryByDedupeKey(dedupeKey: string): CanonicalMemoryRecord | undefined {
    return this.listMemories().find((item) => item.dedupe_key === dedupeKey);
  }

  getTerminalOutcome(sourceKey: string): RememberOutcome | undefined {
    return [...this.listOutcomes()].reverse().find((item) => item.source_key === sourceKey && item.outcome !== 'retryable_failed');
  }

  appendMemory(record: CanonicalMemoryRecord, evidence: EvidenceRecord[]): void {
    if (this.failureInjector?.('memory_commit')) throw new Error('injected memory commit failure');
    if (!this.getMemory(record.memory_id)) appendJsonl(this.file('memories.jsonl'), record);
    const existingEvidence = new Set(this.listEvidence().map((item) => item.evidence_id));
    for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('evidence.jsonl'), item);
  }

  appendOutcome(outcome: RememberOutcome): void {
    if (this.failureInjector?.('outcome_commit')) throw new Error('injected outcome commit failure');
    appendJsonl(this.file('outcomes.jsonl'), outcome);
  }

  beginBatch(batchId: string, now: string): BatchRecord {
    const latest = [...this.listBatches()].reverse().find((item) => item.batch_id === batchId);
    if (latest?.status === 'pending') return latest;
    const pending: BatchRecord = { batch_id: batchId, status: 'pending', created_at: now };
    appendJsonl(this.file('batches.jsonl'), pending);
    return pending;
  }

  finalizeBatch(record: BatchRecord): void {
    appendJsonl(this.file('batches.jsonl'), record);
  }
}
