import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  BatchRecord,
  CanonicalMemoryRecord,
  EvidenceRecord,
  EntityEvidenceRecord,
  EntityIdentityRecord,
  EntityOutcome,
  ReinforcementRecord,
  RememberOutcome,
  OwnerRevisionRecord,
} from '../schema/index.js';

export type StorePhase = 'memory_commit' | 'reinforcement_commit' | 'outcome_commit' | 'intent_commit' | 'intent_outcome_commit';
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

  constructor(rootDir: string, subjectId: string, failureInjector?: FailureInjector, ensureRoot = true) {
    this.rootDir = rootDir;
    this.subjectId = subjectId;
    this.failureInjector = failureInjector;
    if (ensureRoot) ensureDir(rootDir);
  }

  private file(name: string): string { return path.join(this.rootDir, name); }

  listMemories(): CanonicalMemoryRecord[] { return readJsonl<CanonicalMemoryRecord>(this.file('memories.jsonl')); }
  listEvidence(): EvidenceRecord[] { return readJsonl<EvidenceRecord>(this.file('evidence.jsonl')); }
  listEntities(): EntityIdentityRecord[] { return readJsonl<EntityIdentityRecord>(this.file('entities.jsonl')); }
  listEntityEvidence(): EntityEvidenceRecord[] { return readJsonl<EntityEvidenceRecord>(this.file('entity-evidence.jsonl')); }
  listEntityOutcomes(): EntityOutcome[] { return readJsonl<EntityOutcome>(this.file('entity-outcomes.jsonl')); }
  listReinforcements(): ReinforcementRecord[] { return readJsonl<ReinforcementRecord>(this.file('reinforcements.jsonl')); }
  listOutcomes(): RememberOutcome[] { return readJsonl<RememberOutcome>(this.file('outcomes.jsonl')); }
  listBatches(): BatchRecord[] { return readJsonl<BatchRecord>(this.file('batches.jsonl')); }
  listOwnerRevisions(): OwnerRevisionRecord[] { return readJsonl<OwnerRevisionRecord>(this.file('owner-revisions.jsonl')); }
  listAssistantIntents(): AssistantRememberIntentRecord[] { return readJsonl<AssistantRememberIntentRecord>(this.file('assistant-intents.jsonl')); }
  listAssistantIntentOutcomes(): AssistantIntentOutcome[] { return readJsonl<AssistantIntentOutcome>(this.file('assistant-intent-outcomes.jsonl')); }

  getAssistantIntent(intentId: string): AssistantRememberIntentRecord | undefined {
    return this.listAssistantIntents().find((item) => item.intent_id === intentId);
  }

  getTerminalAssistantIntentOutcome(intentId: string, batchId?: string): AssistantIntentOutcome | undefined {
    return [...this.listAssistantIntentOutcomes()].reverse().find((item) =>
      item.intent_id === intentId && (!batchId || item.batch_id === batchId) && item.outcome !== 'retryable_failed');
  }

  getEntity(entityId: string): EntityIdentityRecord | undefined {
    return this.listEntities().find((item) => item.entity_id === entityId);
  }

  getEntityBySourceKey(sourceKey: string): EntityIdentityRecord | undefined {
    return this.listEntities().find((item) => item.source_key === sourceKey);
  }

  getTerminalEntityOutcome(sourceKey: string): EntityOutcome | undefined {
    return [...this.listEntityOutcomes()].reverse().find((item) => item.source_key === sourceKey && item.outcome !== 'retryable_failed');
  }

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

  appendEntity(record: EntityIdentityRecord, evidence: EntityEvidenceRecord[]): void {
    if (this.failureInjector?.('memory_commit')) throw new Error('injected entity commit failure');
    if (!this.getEntity(record.entity_id)) appendJsonl(this.file('entities.jsonl'), record);
    const existingEvidence = new Set(this.listEntityEvidence().map((item) => item.evidence_id));
    for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('entity-evidence.jsonl'), item);
  }

  appendEntityOutcome(outcome: EntityOutcome): void {
    if (this.failureInjector?.('outcome_commit')) throw new Error('injected entity outcome commit failure');
    appendJsonl(this.file('entity-outcomes.jsonl'), outcome);
  }

  appendMemory(record: CanonicalMemoryRecord, evidence: EvidenceRecord[]): void {
    if (this.failureInjector?.('memory_commit')) throw new Error('injected memory commit failure');
    if (!this.getMemory(record.memory_id)) appendJsonl(this.file('memories.jsonl'), record);
    const existingEvidence = new Set(this.listEvidence().map((item) => item.evidence_id));
    for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('evidence.jsonl'), item);
  }

  appendReinforcement(record: ReinforcementRecord, evidence: EvidenceRecord[]): void {
    if (this.failureInjector?.('reinforcement_commit')) throw new Error('injected reinforcement commit failure');
    const existing = this.listReinforcements().find((item) => item.reinforcement_id === record.reinforcement_id);
    if (existing && (existing.memory_id !== record.memory_id || stableJson(existing.evidence_ids) !== stableJson(record.evidence_ids))) throw new Error(`reinforcement identity collision: ${record.reinforcement_id}`);
    const existingEvidence = new Set(this.listEvidence().map((item) => item.evidence_id));
    for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('evidence.jsonl'), item);
    if (!existing) appendJsonl(this.file('reinforcements.jsonl'), record);
  }

  appendOwnerRevision(record: OwnerRevisionRecord): void { appendJsonl(this.file('owner-revisions.jsonl'), record); }

  appendAssistantIntent(record: AssistantRememberIntentRecord): void {
    if (this.failureInjector?.('intent_commit')) throw new Error('injected intent commit failure');
    const existing = this.getAssistantIntent(record.intent_id);
    if (!existing) { appendJsonl(this.file('assistant-intents.jsonl'), record); return; }
    if (stableJson(existing) !== stableJson(record)) throw new Error(`assistant intent identity collision: ${record.intent_id}`);
  }

  appendAssistantIntentOutcome(record: AssistantIntentOutcome): void {
    if (this.failureInjector?.('intent_outcome_commit')) throw new Error('injected intent outcome commit failure');
    const duplicate = this.listAssistantIntentOutcomes().some((item) => stableJson(item) === stableJson(record));
    if (!duplicate) appendJsonl(this.file('assistant-intent-outcomes.jsonl'), record);
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
