import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

export class CanonicalMutationLockError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalMutationLockError';
  }
}

interface MutationLockOwner {
  pid: number;
  hostname: string;
  token: string;
  acquired_at: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
  private mutationLockDepth = 0;

  constructor(rootDir: string, subjectId: string, failureInjector?: FailureInjector, ensureRoot = true) {
    this.rootDir = rootDir;
    this.subjectId = subjectId;
    this.failureInjector = failureInjector;
    if (ensureRoot) ensureDir(rootDir);
  }

  private lockDir(): string { return path.join(this.rootDir, '.canonical-mutation.lock'); }
  private lockOwnerFile(): string { return path.join(this.lockDir(), 'owner.json'); }

  private lockOwnerIsAlive(owner: MutationLockOwner): boolean {
    if (owner.hostname !== os.hostname()) return true;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private recoverStaleLock(staleMs: number): boolean {
    const lockDir = this.lockDir();
    let stat: fs.Stats;
    try { stat = fs.statSync(lockDir); } catch { return true; }

    let owner: MutationLockOwner | undefined;
    try { owner = JSON.parse(fs.readFileSync(this.lockOwnerFile(), 'utf8')) as MutationLockOwner; }
    catch { owner = undefined; }

    const oldEnough = Date.now() - stat.mtimeMs >= staleMs;
    const deadOwner = owner
      ? Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string' && !this.lockOwnerIsAlive(owner)
      : oldEnough;
    if (!deadOwner) return false;

    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private acquireMutationLock(): string {
    ensureDir(this.rootDir);
    const timeoutMs = positiveEnvMs('RELATIONSHIP_MEMORY_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);
    const staleMs = positiveEnvMs('RELATIONSHIP_MEMORY_LOCK_STALE_MS', DEFAULT_LOCK_STALE_MS);
    const deadline = Date.now() + timeoutMs;
    const token = `${process.pid}-${crypto.randomUUID()}`;

    while (true) {
      try {
        fs.mkdirSync(this.lockDir());
        const owner: MutationLockOwner = {
          pid: process.pid,
          hostname: os.hostname(),
          token,
          acquired_at: new Date().toISOString(),
        };
        fs.writeFileSync(this.lockOwnerFile(), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
        return token;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          try { fs.rmSync(this.lockDir(), { recursive: true, force: true }); } catch { }
          throw new CanonicalMutationLockError(`canonical mutation lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.recoverStaleLock(staleMs);
        if (Date.now() >= deadline) {
          throw new CanonicalMutationLockError(`canonical mutation lock contention timed out after ${timeoutMs}ms`);
        }
        sleepSync(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private releaseMutationLock(token: string): void {
    try {
      const owner = JSON.parse(fs.readFileSync(this.lockOwnerFile(), 'utf8')) as MutationLockOwner;
      if (owner.token !== token) throw new Error('canonical mutation lock ownership changed before release');
      fs.rmSync(this.lockDir(), { recursive: true, force: false });
    } catch (error) {
      throw new CanonicalMutationLockError(`canonical mutation lock release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  withMutationBoundary<T>(operation: () => T): T {
    if (this.mutationLockDepth > 0) {
      this.mutationLockDepth += 1;
      try { return operation(); }
      finally { this.mutationLockDepth -= 1; }
    }

    const token = this.acquireMutationLock();
    this.mutationLockDepth = 1;
    try { return operation(); }
    finally {
      this.mutationLockDepth = 0;
      this.releaseMutationLock(token);
    }
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

  getEntity(entityId: string): EntityIdentityRecord | undefined { return this.listEntities().find((item) => item.entity_id === entityId); }
  getEntityBySourceKey(sourceKey: string): EntityIdentityRecord | undefined { return this.listEntities().find((item) => item.source_key === sourceKey); }
  getTerminalEntityOutcome(sourceKey: string): EntityOutcome | undefined {
    return [...this.listEntityOutcomes()].reverse().find((item) => item.source_key === sourceKey && item.outcome !== 'retryable_failed');
  }
  getMemory(memoryId: string): CanonicalMemoryRecord | undefined { return this.listMemories().find((item) => item.memory_id === memoryId); }
  getMemoryBySourceKey(sourceKey: string): CanonicalMemoryRecord | undefined { return this.listMemories().find((item) => item.source_key === sourceKey); }
  getMemoryByDedupeKey(dedupeKey: string): CanonicalMemoryRecord | undefined { return this.listMemories().find((item) => item.dedupe_key === dedupeKey); }
  getTerminalOutcome(sourceKey: string): RememberOutcome | undefined {
    return [...this.listOutcomes()].reverse().find((item) => item.source_key === sourceKey && item.outcome !== 'retryable_failed');
  }

  appendEntity(record: EntityIdentityRecord, evidence: EntityEvidenceRecord[]): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('memory_commit')) throw new Error('injected entity commit failure');
      if (!this.getEntity(record.entity_id)) appendJsonl(this.file('entities.jsonl'), record);
      const existingEvidence = new Set(this.listEntityEvidence().map((item) => item.evidence_id));
      for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('entity-evidence.jsonl'), item);
    });
  }

  appendEntityOutcome(outcome: EntityOutcome): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('outcome_commit')) throw new Error('injected entity outcome commit failure');
      appendJsonl(this.file('entity-outcomes.jsonl'), outcome);
    });
  }

  appendMemory(record: CanonicalMemoryRecord, evidence: EvidenceRecord[]): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('memory_commit')) throw new Error('injected memory commit failure');
      if (!this.getMemory(record.memory_id)) appendJsonl(this.file('memories.jsonl'), record);
      const existingEvidence = new Set(this.listEvidence().map((item) => item.evidence_id));
      for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('evidence.jsonl'), item);
    });
  }

  appendReinforcement(record: ReinforcementRecord, evidence: EvidenceRecord[]): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('reinforcement_commit')) throw new Error('injected reinforcement commit failure');
      const existing = this.listReinforcements().find((item) => item.reinforcement_id === record.reinforcement_id);
      if (existing && (existing.memory_id !== record.memory_id || stableJson(existing.evidence_ids) !== stableJson(record.evidence_ids))) throw new Error(`reinforcement identity collision: ${record.reinforcement_id}`);
      const existingEvidence = new Set(this.listEvidence().map((item) => item.evidence_id));
      for (const item of evidence) if (!existingEvidence.has(item.evidence_id)) appendJsonl(this.file('evidence.jsonl'), item);
      if (!existing) appendJsonl(this.file('reinforcements.jsonl'), record);
    });
  }

  appendOwnerRevision(record: OwnerRevisionRecord): void {
    this.withMutationBoundary(() => appendJsonl(this.file('owner-revisions.jsonl'), record));
  }

  appendAssistantIntent(record: AssistantRememberIntentRecord): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('intent_commit')) throw new Error('injected intent commit failure');
      const existing = this.getAssistantIntent(record.intent_id);
      if (!existing) { appendJsonl(this.file('assistant-intents.jsonl'), record); return; }
      if (stableJson(existing) !== stableJson(record)) throw new Error(`assistant intent identity collision: ${record.intent_id}`);
    });
  }

  appendAssistantIntentOutcome(record: AssistantIntentOutcome): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('intent_outcome_commit')) throw new Error('injected intent outcome commit failure');
      const duplicate = this.listAssistantIntentOutcomes().some((item) => stableJson(item) === stableJson(record));
      if (!duplicate) appendJsonl(this.file('assistant-intent-outcomes.jsonl'), record);
    });
  }

  appendOutcome(outcome: RememberOutcome): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('outcome_commit')) throw new Error('injected outcome commit failure');
      appendJsonl(this.file('outcomes.jsonl'), outcome);
    });
  }

  beginBatch(batchId: string, now: string): BatchRecord {
    return this.withMutationBoundary(() => {
      const latest = [...this.listBatches()].reverse().find((item) => item.batch_id === batchId);
      if (latest?.status === 'pending') return latest;
      const pending: BatchRecord = { batch_id: batchId, status: 'pending', created_at: now };
      appendJsonl(this.file('batches.jsonl'), pending);
      return pending;
    });
  }

  finalizeBatch(record: BatchRecord): void {
    this.withMutationBoundary(() => appendJsonl(this.file('batches.jsonl'), record));
  }
}
