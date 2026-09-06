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
const WRITE_INDEX_VERSION = 1;

interface WriteIndexManifest {
  version: 1;
  source_size: number;
}

interface WriteIndexMarkerEntry {
  key: string;
  value?: string;
}

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

function readEvidenceJsonlForMemoryIds(file: string, memoryIds: readonly string[]): EvidenceRecord[] {
  if (!fs.existsSync(file) || memoryIds.length === 0) return [];
  // Keep the 30MB+ append-only evidence file as bytes. Decoding the whole file
  // to one JS UTF-16 string costs hundreds of milliseconds on production-scale
  // stores; Buffer search lets foreground recall decode only the matching lines.
  const raw = fs.readFileSync(file);
  const result: EvidenceRecord[] = [];
  for (const memoryId of new Set(memoryIds)) {
    const needle = Buffer.from(`"memory_id":${JSON.stringify(memoryId)}`, 'utf8');
    let cursor = 0;
    while (cursor < raw.length) {
      const match = raw.indexOf(needle, cursor);
      if (match < 0) break;
      const previousNewline = raw.lastIndexOf(0x0a, match - 1);
      const lineStart = previousNewline < 0 ? 0 : previousNewline + 1;
      const newline = raw.indexOf(0x0a, match);
      const lineEnd = newline < 0 ? raw.length : newline;
      if (lineEnd > lineStart) result.push(JSON.parse(raw.subarray(lineStart, lineEnd).toString('utf8')) as EvidenceRecord);
      cursor = lineEnd + 1;
    }
  }
  return result;
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
  private mutationWriteIndexReady?: Set<string>;

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
    this.mutationWriteIndexReady = new Set();
    try { return operation(); }
    finally {
      // Boundary-local readiness is never allowed to survive lock release.
      this.mutationWriteIndexReady = undefined;
      this.mutationLockDepth = 0;
      this.releaseMutationLock(token);
    }
  }

  private file(name: string): string { return path.join(this.rootDir, name); }

  private writeIndexDatasetDir(dataset: string): string { return path.join(this.rootDir, '.write-index-v1', dataset); }
  private writeIndexMarkersDir(dataset: string): string { return path.join(this.writeIndexDatasetDir(dataset), 'markers'); }
  private writeIndexManifestFile(dataset: string): string { return path.join(this.writeIndexDatasetDir(dataset), 'manifest.json'); }
  private writeIndexMarkerFile(dataset: string, key: string): string {
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.writeIndexMarkersDir(dataset), digest.slice(0, 2), `${digest}.json`);
  }

  private sourceSize(fileName: string): number {
    try { return fs.statSync(this.file(fileName)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private invalidateWriteIndex(dataset: string): void {
    this.mutationWriteIndexReady?.delete(dataset);
    try { fs.rmSync(this.writeIndexManifestFile(dataset), { force: true }); } catch { }
  }

  private readMarkerEntries(dataset: string, key: string): WriteIndexMarkerEntry[] {
    const markerFile = this.writeIndexMarkerFile(dataset, key);
    if (!fs.existsSync(markerFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as WriteIndexMarkerEntry[];
    if (!Array.isArray(parsed)) throw new Error(`invalid write index marker for ${dataset}`);
    return parsed;
  }

  private writeMarkerEntry(dataset: string, entry: WriteIndexMarkerEntry): void {
    const markerFile = this.writeIndexMarkerFile(dataset, entry.key);
    const entries = this.readMarkerEntries(dataset, entry.key);
    const existingIndex = entries.findIndex((item) => item.key === entry.key);
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else entries.push(entry);
    ensureDir(path.dirname(markerFile));
    fs.writeFileSync(markerFile, `${JSON.stringify(entries)}\n`, 'utf8');
  }

  private publishWriteIndexManifest(dataset: string, fileName: string): void {
    const manifest: WriteIndexManifest = { version: WRITE_INDEX_VERSION, source_size: this.sourceSize(fileName) };
    ensureDir(this.writeIndexDatasetDir(dataset));
    fs.writeFileSync(this.writeIndexManifestFile(dataset), `${JSON.stringify(manifest)}\n`, 'utf8');
  }

  private rebuildWriteIndex<T>(dataset: string, fileName: string, records: T[], entryFor: (record: T) => WriteIndexMarkerEntry): void {
    const datasetDir = this.writeIndexDatasetDir(dataset);
    fs.rmSync(datasetDir, { recursive: true, force: true });
    ensureDir(this.writeIndexMarkersDir(dataset));
    for (const record of records) this.writeMarkerEntry(dataset, entryFor(record));
    this.publishWriteIndexManifest(dataset, fileName);
  }

  private ensureWriteIndex<T>(dataset: string, fileName: string, readRecords: () => T[], entryFor: (record: T) => WriteIndexMarkerEntry): boolean {
    if (this.mutationWriteIndexReady?.has(dataset)) return true;
    try {
      const manifestFile = this.writeIndexManifestFile(dataset);
      let valid = false;
      if (fs.existsSync(manifestFile)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as WriteIndexManifest;
          valid = manifest.version === WRITE_INDEX_VERSION && manifest.source_size === this.sourceSize(fileName);
        } catch { valid = false; }
      }
      if (!valid) this.rebuildWriteIndex(dataset, fileName, readRecords(), entryFor);
      this.mutationWriteIndexReady?.add(dataset);
      return true;
    } catch {
      this.invalidateWriteIndex(dataset);
      return false;
    }
  }

  private indexedEntry<T>(
    dataset: string,
    fileName: string,
    key: string,
    readRecords: () => T[],
    entryFor: (record: T) => WriteIndexMarkerEntry,
  ): { ready: boolean; entry?: WriteIndexMarkerEntry } {
    const ready = this.ensureWriteIndex(dataset, fileName, readRecords, entryFor);
    if (!ready) return { ready: false };
    try {
      return { ready: true, entry: this.readMarkerEntries(dataset, key).find((item) => item.key === key) };
    } catch {
      this.invalidateWriteIndex(dataset);
      return { ready: false };
    }
  }

  private recordIndexedAppend(dataset: string, fileName: string, entry: WriteIndexMarkerEntry, ready: boolean): void {
    if (!ready || !this.mutationWriteIndexReady?.has(dataset)) return;
    try {
      this.writeMarkerEntry(dataset, entry);
      this.publishWriteIndexManifest(dataset, fileName);
    } catch {
      // Canonical JSONL is authoritative. If accelerator maintenance fails after
      // a successful append, leave the canonical write intact and force rebuild.
      this.invalidateWriteIndex(dataset);
    }
  }

  listMemories(): CanonicalMemoryRecord[] { return readJsonl<CanonicalMemoryRecord>(this.file('memories.jsonl')); }
  listEvidence(): EvidenceRecord[] { return readJsonl<EvidenceRecord>(this.file('evidence.jsonl')); }
  listEvidenceForMemoryIds(memoryIds: readonly string[]): EvidenceRecord[] {
    return readEvidenceJsonlForMemoryIds(this.file('evidence.jsonl'), memoryIds);
  }
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
      const entityLookup = this.indexedEntry('entities', 'entities.jsonl', record.entity_id, () => this.listEntities(), (item) => ({ key: item.entity_id }));
      const existingEntity = entityLookup.ready ? entityLookup.entry !== undefined : this.getEntity(record.entity_id) !== undefined;
      if (!existingEntity) {
        appendJsonl(this.file('entities.jsonl'), record);
        this.recordIndexedAppend('entities', 'entities.jsonl', { key: record.entity_id }, entityLookup.ready);
      }

      const entityEvidenceReady = this.ensureWriteIndex('entity-evidence', 'entity-evidence.jsonl', () => this.listEntityEvidence(), (item) => ({ key: item.evidence_id }));
      const existingEvidence = new Set<string>();
      if (entityEvidenceReady) {
        for (const item of evidence) {
          try {
            if (this.readMarkerEntries('entity-evidence', item.evidence_id).some((entry) => entry.key === item.evidence_id)) existingEvidence.add(item.evidence_id);
          } catch {
            this.invalidateWriteIndex('entity-evidence');
            existingEvidence.clear();
            for (const existing of this.listEntityEvidence()) existingEvidence.add(existing.evidence_id);
            break;
          }
        }
      } else {
        for (const existing of this.listEntityEvidence()) existingEvidence.add(existing.evidence_id);
      }
      for (const item of evidence) {
        if (!existingEvidence.has(item.evidence_id)) {
          appendJsonl(this.file('entity-evidence.jsonl'), item);
          this.recordIndexedAppend('entity-evidence', 'entity-evidence.jsonl', { key: item.evidence_id }, entityEvidenceReady);
        }
      }
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
      const memoryLookup = this.indexedEntry('memories', 'memories.jsonl', record.memory_id, () => this.listMemories(), (item) => ({ key: item.memory_id }));
      const existingMemory = memoryLookup.ready ? memoryLookup.entry !== undefined : this.getMemory(record.memory_id) !== undefined;
      if (!existingMemory) {
        appendJsonl(this.file('memories.jsonl'), record);
        this.recordIndexedAppend('memories', 'memories.jsonl', { key: record.memory_id }, memoryLookup.ready);
      }

      const evidenceReady = this.ensureWriteIndex('evidence', 'evidence.jsonl', () => this.listEvidence(), (item) => ({ key: item.evidence_id }));
      const existingEvidence = new Set<string>();
      if (evidenceReady) {
        for (const item of evidence) {
          try {
            if (this.readMarkerEntries('evidence', item.evidence_id).some((entry) => entry.key === item.evidence_id)) existingEvidence.add(item.evidence_id);
          } catch {
            this.invalidateWriteIndex('evidence');
            existingEvidence.clear();
            for (const existing of this.listEvidence()) existingEvidence.add(existing.evidence_id);
            break;
          }
        }
      } else {
        for (const existing of this.listEvidence()) existingEvidence.add(existing.evidence_id);
      }
      for (const item of evidence) {
        if (!existingEvidence.has(item.evidence_id)) {
          appendJsonl(this.file('evidence.jsonl'), item);
          this.recordIndexedAppend('evidence', 'evidence.jsonl', { key: item.evidence_id }, evidenceReady);
        }
      }
    });
  }

  appendReinforcement(record: ReinforcementRecord, evidence: EvidenceRecord[]): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('reinforcement_commit')) throw new Error('injected reinforcement commit failure');
      const reinforcementLookup = this.indexedEntry(
        'reinforcements',
        'reinforcements.jsonl',
        record.reinforcement_id,
        () => this.listReinforcements(),
        (item) => ({ key: item.reinforcement_id, value: stableJson({ memory_id: item.memory_id, evidence_ids: item.evidence_ids }) }),
      );
      const existing = reinforcementLookup.ready
        ? reinforcementLookup.entry
        : this.listReinforcements().find((item) => item.reinforcement_id === record.reinforcement_id);
      if (existing) {
        const existingIdentity = 'value' in existing
          ? existing.value
          : stableJson({ memory_id: existing.memory_id, evidence_ids: existing.evidence_ids });
        const incomingIdentity = stableJson({ memory_id: record.memory_id, evidence_ids: record.evidence_ids });
        if (existingIdentity !== incomingIdentity) throw new Error(`reinforcement identity collision: ${record.reinforcement_id}`);
      }

      const evidenceReady = this.ensureWriteIndex('evidence', 'evidence.jsonl', () => this.listEvidence(), (item) => ({ key: item.evidence_id }));
      const existingEvidence = new Set<string>();
      if (evidenceReady) {
        for (const item of evidence) {
          try {
            if (this.readMarkerEntries('evidence', item.evidence_id).some((entry) => entry.key === item.evidence_id)) existingEvidence.add(item.evidence_id);
          } catch {
            this.invalidateWriteIndex('evidence');
            existingEvidence.clear();
            for (const existingEvidenceRecord of this.listEvidence()) existingEvidence.add(existingEvidenceRecord.evidence_id);
            break;
          }
        }
      } else {
        for (const existingEvidenceRecord of this.listEvidence()) existingEvidence.add(existingEvidenceRecord.evidence_id);
      }
      for (const item of evidence) {
        if (!existingEvidence.has(item.evidence_id)) {
          appendJsonl(this.file('evidence.jsonl'), item);
          this.recordIndexedAppend('evidence', 'evidence.jsonl', { key: item.evidence_id }, evidenceReady);
        }
      }
      if (!existing) {
        appendJsonl(this.file('reinforcements.jsonl'), record);
        this.recordIndexedAppend('reinforcements', 'reinforcements.jsonl', {
          key: record.reinforcement_id,
          value: stableJson({ memory_id: record.memory_id, evidence_ids: record.evidence_ids }),
        }, reinforcementLookup.ready);
      }
    });
  }

  appendOwnerRevision(record: OwnerRevisionRecord): void {
    this.withMutationBoundary(() => appendJsonl(this.file('owner-revisions.jsonl'), record));
  }

  appendAssistantIntent(record: AssistantRememberIntentRecord): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('intent_commit')) throw new Error('injected intent commit failure');
      const lookup = this.indexedEntry(
        'assistant-intents',
        'assistant-intents.jsonl',
        record.intent_id,
        () => this.listAssistantIntents(),
        (item) => ({ key: item.intent_id, value: stableJson(item) }),
      );
      const existing = lookup.ready ? lookup.entry : this.getAssistantIntent(record.intent_id);
      if (!existing) {
        appendJsonl(this.file('assistant-intents.jsonl'), record);
        this.recordIndexedAppend('assistant-intents', 'assistant-intents.jsonl', { key: record.intent_id, value: stableJson(record) }, lookup.ready);
        return;
      }
      const existingStable = 'value' in existing ? existing.value : stableJson(existing);
      if (existingStable !== stableJson(record)) throw new Error(`assistant intent identity collision: ${record.intent_id}`);
    });
  }

  appendAssistantIntentOutcome(record: AssistantIntentOutcome): void {
    this.withMutationBoundary(() => {
      if (this.failureInjector?.('intent_outcome_commit')) throw new Error('injected intent outcome commit failure');
      const stable = stableJson(record);
      const key = crypto.createHash('sha256').update(stable).digest('hex');
      const lookup = this.indexedEntry(
        'assistant-intent-outcomes',
        'assistant-intent-outcomes.jsonl',
        key,
        () => this.listAssistantIntentOutcomes(),
        (item) => ({ key: crypto.createHash('sha256').update(stableJson(item)).digest('hex'), value: stableJson(item) }),
      );
      const duplicate = lookup.ready
        ? lookup.entry?.value === stable
        : this.listAssistantIntentOutcomes().some((item) => stableJson(item) === stable);
      if (!duplicate) {
        appendJsonl(this.file('assistant-intent-outcomes.jsonl'), record);
        this.recordIndexedAppend('assistant-intent-outcomes', 'assistant-intent-outcomes.jsonl', { key, value: stable }, lookup.ready);
      }
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
      const batches = this.listBatches().filter((item) => item.batch_id === batchId);
      const latest = batches.at(-1);
      if (latest?.status === 'pending') return latest;
      const attemptIndex = batches.filter((item) => item.status === 'pending').length + 1;
      const pending: BatchRecord = {
        batch_id: batchId,
        attempt_id: stableId('batch_attempt', { batch_id: batchId, attempt_index: attemptIndex }),
        status: 'pending',
        created_at: now,
      };
      appendJsonl(this.file('batches.jsonl'), pending);
      return pending;
    });
  }

  finalizeBatch(record: BatchRecord): void {
    this.withMutationBoundary(() => appendJsonl(this.file('batches.jsonl'), record));
  }
}
