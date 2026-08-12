import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CanonicalMemoryRecord, OwnerSemanticContent, ReinforcementRecord } from '../schema/index.js';
import { validateSemanticContent } from '../schema/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';
import {
  LegacyMemorySourceStore,
  type LegacyAssistantMemorySourceRecord,
  type LegacyMemoryProvenanceLink,
} from './index.js';

export const LEGACY_FEEL_TEMPORALITY = 'historical_at_source_time' as const;
export const OMBRE_LEGACY_FROZEN_MANIFEST_DIGEST = '5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31' as const;


export const LEGACY_MEMORY_PAYLOAD_GUIDE = [
  'legacy_memory_create payload fields are kind-specific; never probe the schema with test or placeholder memories.',
  'personal_experience requires: title, experience. Optional: time_text, places[], themes[], emotional_tone, why_memorable, recall_triggers[].',
  'shared_experience requires: title, event, shared_meaning. Optional: symbols[], recall_triggers[].',
  'relationship_event requires: event, meaning. Optional: prior_context, resulting_change.',
  'inside_joke requires: name, meaning, trigger_phrases[] (non-empty). Optional: origin, callbacks[], tone.',
  'user_preference requires: topic, preference. Optional: context, reason, recall_triggers[].',
  'Only send fields allowed for the selected kind, and every create call must be a source-faithful canonical proposal.',
].join('\n');

const LEGACY_CREDENTIAL_PATTERNS = [
  /(?:password|passwd|pwd|密码)\s*(?:[:=：]\s*)?["'`]?([^\s"'`,;，。]+)/giu,
  /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|secret|密钥|令牌)\s*[:=：]\s*["'`]?([A-Za-z0-9._~+/=-]{4,})/giu,
  /Bearer\s+([A-Za-z0-9._~+/=-]{4,})/giu,
] as const;

function sourceTextValues(source: LegacyAssistantMemorySourceRecord): string[] {
  return [source.original_markdown, source.body_text, JSON.stringify(source.frontmatter)];
}

export function extractLegacyCredentialValues(source: LegacyAssistantMemorySourceRecord): string[] {
  const values = new Set<string>();
  for (const text of sourceTextValues(source)) {
    for (const pattern of LEGACY_CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const value = match[1]?.trim();
        if (value && value.length >= 4) values.add(value);
      }
    }
  }
  return [...values];
}

function redactLegacyCredentialValues(value: unknown, credentials: readonly string[]): unknown {
  if (typeof value === 'string') {
    return credentials.reduce((text, credential) => text.split(credential).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactLegacyCredentialValues(item, credentials));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactLegacyCredentialValues(item, credentials)]));
  }
  return value;
}

export function sanitizeLegacySourceForObserver(source: LegacyAssistantMemorySourceRecord): LegacyAssistantMemorySourceRecord {
  const credentials = extractLegacyCredentialValues(source);
  if (credentials.length === 0) return source;
  return redactLegacyCredentialValues(source, credentials) as LegacyAssistantMemorySourceRecord;
}

export type LegacySemanticCompletion = 'completed' | 'no_memory_required' | 'retryable_failure';

export interface LegacySemanticMutationResult {
  outcome: 'created' | 'duplicate_link' | 'reinforced' | 'permanently_rejected' | 'retryable_failed';
  memory_id?: string;
  reason?: string;
}

export interface LegacySemanticState {
  schema_version: 1;
  manifest_digest: string;
  canonical_subject_id: string;
  processed_source_ids: string[];
}

export interface LegacySemanticReceipt {
  schema_version: 1;
  attempt?: number;
  receipt_id: string;
  manifest_digest: string;
  canonical_subject_id: string;
  legacy_source_id: string;
  batch_id: string;
  result: LegacySemanticCompletion;
  provenance_ids: string[];
  memory_ids: string[];
  recorded_at: string;
  reason?: string;
}

export interface LegacySemanticProcessorResult {
  completion: LegacySemanticCompletion;
  reason?: string;
}

export interface RunLegacySemanticMigrationOptions {
  rootDir: string;
  expectedManifestDigest: string;
  canonicalSubjectId: string;
  statePath?: string;
  maxRecords?: number;
  concurrency?: number;
  sourceIds?: string[];
  dryRun?: boolean;
  processor: (source: LegacyAssistantMemorySourceRecord, batchId: string) => Promise<LegacySemanticProcessorResult>;
}

export interface LegacySemanticRunResult {
  status: 'completed' | 'no-op' | 'blocked-failure' | 'dry-run';
  manifest_digest?: string;
  processed: number;
  remaining: number;
  source_id?: string;
  detail?: string;
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function semanticShape(content: OwnerSemanticContent): string {
  return stableJson({
    kind: content.kind,
    summary: content.summary,
    participants: content.participants,
    payload: content.payload,
    linked_memory_ids: content.linked_memory_ids ?? [],
  });
}

function memoryContent(memory: CanonicalMemoryRecord): OwnerSemanticContent {
  return {
    kind: memory.kind,
    summary: memory.summary,
    participants: memory.participants,
    payload: memory.payload,
    ...(memory.linked_memory_ids ? { linked_memory_ids: memory.linked_memory_ids } : {}),
  };
}

function memoriesForSubject(store: RelationshipMemoryStore, subjectId: string): CanonicalMemoryRecord[] {
  return store.listMemories().filter((memory) => memory.subject_id === subjectId);
}

function provenanceForSubject(
  legacyStore: LegacyMemorySourceStore,
  canonicalStore: RelationshipMemoryStore,
  subjectId: string,
  sourceId: string,
): LegacyMemoryProvenanceLink[] {
  const memoryIds = new Set(memoriesForSubject(canonicalStore, subjectId).map((memory) => memory.memory_id));
  return legacyStore.listProvenance().filter((item) => item.legacy_source_id === sourceId && memoryIds.has(item.canonical_memory_id));
}

export class LegacySemanticMutationRuntime {
  private completion?: 'completed' | 'no_memory_required';
  readonly canonicalStore: RelationshipMemoryStore;
  readonly legacyStore: LegacyMemorySourceStore;

  constructor(
    readonly rootDir: string,
    readonly subjectId: string,
    readonly source: LegacyAssistantMemorySourceRecord,
    readonly batchId: string,
    readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.canonicalStore = new RelationshipMemoryStore(rootDir, subjectId);
    this.legacyStore = new LegacyMemorySourceStore(rootDir);
  }

  provenance(): LegacyMemoryProvenanceLink[] {
    return provenanceForSubject(this.legacyStore, this.canonicalStore, this.subjectId, this.source.legacy_source_id);
  }

  private canonicalMemory(memoryId: string): CanonicalMemoryRecord | undefined {
    const memory = this.canonicalStore.getMemory(memoryId);
    return memory?.subject_id === this.subjectId ? memory : undefined;
  }

  completionState(): 'completed' | 'no_memory_required' | undefined { return this.completion; }

  private validateCreateInput(raw: unknown): { ok: true; content: OwnerSemanticContent } | { ok: false; reason: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'legacy memory proposal must be an object' };
    const input = raw as Record<string, unknown>;
    const allowed = new Set(['schema_version', 'kind', 'summary', 'participants', 'payload', 'linked_memory_ids', 'historical_temporality']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) return { ok: false, reason: `unknown legacy proposal field: ${key}` };
    if (this.source.bucket_type === 'feel' && input.historical_temporality !== LEGACY_FEEL_TEMPORALITY) {
      return { ok: false, reason: `feel/ sources require historical_temporality=${LEGACY_FEEL_TEMPORALITY}` };
    }
    const semantic = validateSemanticContent({
      schema_version: input.schema_version,
      kind: input.kind,
      summary: input.summary,
      participants: input.participants,
      payload: input.payload,
      ...('linked_memory_ids' in input ? { linked_memory_ids: input.linked_memory_ids } : {}),
    }, { requireChineseSemanticProse: true });
    if (!semantic.ok || !semantic.content) return { ok: false, reason: `${semantic.code ?? 'invalid_schema'}: ${semantic.reason ?? 'invalid semantic content'}` };
    const sourceCredentials = extractLegacyCredentialValues(this.source);
    const proposalText = stableJson(semantic.content);
    if (sourceCredentials.some((credential) => proposalText.includes(credential))) {
      return { ok: false, reason: 'legacy proposal contains source credential material' };
    }
    for (const memoryId of semantic.content.linked_memory_ids ?? []) {
      if (!this.canonicalMemory(memoryId)) return { ok: false, reason: `unknown linked memory: ${memoryId}` };
    }
    return { ok: true, content: semantic.content };
  }

  createMemory(raw: unknown): LegacySemanticMutationResult {
    if (this.completion) return { outcome: 'permanently_rejected', reason: 'source already completed in this observer session' };
    const validated = this.validateCreateInput(raw);
    if ('reason' in validated) return { outcome: 'permanently_rejected', reason: validated.reason };
    const content = validated.content;
    const sourceKey = stableId('legacy_memory_src', { legacy_source_id: this.source.legacy_source_id, semantic: content });

    try {
      const committed = this.canonicalStore.withMutationBoundary(() => {
        const recovered = this.canonicalStore.getMemoryBySourceKey(sourceKey);
        if (recovered?.subject_id === this.subjectId) {
          return { outcome: 'duplicate_link' as const, memoryId: recovered.memory_id, disposition: 'created' as const };
        }

        const targetShape = semanticShape(content);
        const effective = new RelationshipMemoryOwnerControlPlane(this.canonicalStore).listEffective()
          .filter((candidate) => candidate.subject_id === this.subjectId);
        const duplicate = effective.find((candidate) => semanticShape(candidate) === targetShape);
        if (duplicate) {
          return { outcome: 'duplicate_link' as const, memoryId: duplicate.memory_id, disposition: 'duplicate_link' as const };
        }

        const memoryId = stableId('mem', { subject_id: this.subjectId, source_key: sourceKey });
        const memory: CanonicalMemoryRecord = {
          schema_version: 1,
          memory_id: memoryId,
          subject_id: this.subjectId,
          ...content,
          status: 'active',
          observed_at: this.source.created_at_utc,
          created_at: this.now(),
          source_key: sourceKey,
          dedupe_key: stableId('dedupe', { subject_id: this.subjectId, semantic: content }),
        };
        this.canonicalStore.appendMemory(memory, []);
        return { outcome: 'created' as const, memoryId, disposition: 'created' as const };
      });

      this.legacyStore.appendProvenance({
        legacy_source_id: this.source.legacy_source_id,
        canonical_memory_id: committed.memoryId,
        disposition: committed.disposition,
        recorded_at: this.now(),
      });
      return { outcome: committed.outcome, memory_id: committed.memoryId };
    } catch (error) {
      return { outcome: 'retryable_failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  duplicateLink(memoryId: string): LegacySemanticMutationResult {
    if (this.completion) return { outcome: 'permanently_rejected', reason: 'source already completed in this observer session' };
    const memory = this.canonicalMemory(memoryId);
    if (!memory) return { outcome: 'permanently_rejected', reason: `unknown canonical memory: ${memoryId}` };
    try {
      this.legacyStore.appendProvenance({
        legacy_source_id: this.source.legacy_source_id,
        canonical_memory_id: memoryId,
        disposition: 'duplicate_link',
        recorded_at: this.now(),
      });
      return { outcome: 'duplicate_link', memory_id: memoryId };
    } catch (error) {
      return { outcome: 'retryable_failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  reinforce(memoryId: string): LegacySemanticMutationResult {
    if (this.completion) return { outcome: 'permanently_rejected', reason: 'source already completed in this observer session' };
    const memory = this.canonicalMemory(memoryId);
    if (!memory) return { outcome: 'permanently_rejected', reason: `unknown canonical memory: ${memoryId}` };
    const reinforcement: ReinforcementRecord = {
      schema_version: 1,
      reinforcement_id: stableId('legacy_reinforce', { legacy_source_id: this.source.legacy_source_id, memory_id: memoryId }),
      memory_id: memoryId,
      batch_id: this.batchId,
      evidence_ids: [],
      latest_evidence_at: this.source.last_active_at_utc,
      recorded_at: this.now(),
    };
    try {
      this.canonicalStore.appendReinforcement(reinforcement, []);
      this.legacyStore.appendProvenance({
        legacy_source_id: this.source.legacy_source_id,
        canonical_memory_id: memoryId,
        disposition: 'reinforced',
        recorded_at: this.now(),
      });
      return { outcome: 'reinforced', memory_id: memoryId };
    } catch (error) {
      return { outcome: 'retryable_failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  complete(kind: 'completed' | 'no_memory_required'): { completion: 'completed' | 'no_memory_required' } | { error: string } {
    if (this.completion) return { completion: this.completion };
    const provenance = this.provenance();
    if (kind === 'no_memory_required' && provenance.length > 0) return { error: 'no_memory_required is invalid after canonical provenance was written' };
    if (kind === 'completed' && provenance.length === 0) return { error: 'completed requires at least one canonical provenance outcome' };
    this.completion = kind;
    return { completion: kind };
  }
}

export function legacyMemoryCreateToolSchema(source: LegacyAssistantMemorySourceRecord): Record<string, unknown> {
  const string = { type: 'string', minLength: 1 };
  const strings = { type: 'array', uniqueItems: true, items: string };
  return {
    type: 'object', additionalProperties: false,
    required: ['schema_version', 'kind', 'summary', 'participants', 'payload', ...(source.bucket_type === 'feel' ? ['historical_temporality'] : [])],
    properties: {
      schema_version: { type: 'integer', enum: [1] },
      kind: { type: 'string', enum: ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference'] },
      summary: string,
      participants: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'assistant'] } },
      linked_memory_ids: strings,
      historical_temporality: { type: 'string', enum: [LEGACY_FEEL_TEMPORALITY], description: 'Required for feel/ sources: this prose describes the historical source-time feeling, never a current-state assertion.' },
      payload: {
        type: 'object',
        additionalProperties: false,
        description: `${LEGACY_MEMORY_PAYLOAD_GUIDE} DS-authored semantic prose must be Chinese; source-faithful names/triggers may remain literal.`,
        properties: {
          title: string,
          experience: string,
          time_text: string,
          places: strings,
          themes: strings,
          emotional_tone: string,
          why_memorable: string,
          recall_triggers: strings,
          event: string,
          shared_meaning: string,
          symbols: strings,
          meaning: string,
          prior_context: string,
          resulting_change: string,
          name: string,
          trigger_phrases: strings,
          origin: string,
          callbacks: strings,
          tone: string,
          topic: string,
          preference: string,
          context: string,
          reason: string,
        },
      },
    },
  };
}

export function legacyMemoryExistingToolSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['memory_id'], properties: { memory_id: { type: 'string', minLength: 1 } } };
}

export function legacySourceCompleteToolSchema(): Record<string, unknown> {
  return { title: 'LegacySourceCompleteArgs', type: 'object', additionalProperties: false, required: ['result'], properties: { result: { type: 'string', enum: ['completed', 'no_memory_required'] } } };
}

export function legacySemanticBatchId(manifestDigest: string, sourceId: string, canonicalSubjectId: string): string {
  return stableId('legacy_semantic_batch', { manifest_digest: manifestDigest, legacy_source_id: sourceId, canonical_subject_id: canonicalSubjectId });
}

export function loadLegacySemanticState(file: string, manifestDigest: string, canonicalSubjectId: string): LegacySemanticState {
  if (!fs.existsSync(file)) return { schema_version: 1, manifest_digest: manifestDigest, canonical_subject_id: canonicalSubjectId, processed_source_ids: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacySemanticState;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.processed_source_ids) || typeof parsed.canonical_subject_id !== 'string' || !parsed.canonical_subject_id.trim()) {
    throw new Error('malformed legacy semantic migration state');
  }
  if (parsed.manifest_digest !== manifestDigest) throw new Error('legacy semantic migration state is bound to a different manifest');
  if (parsed.canonical_subject_id !== canonicalSubjectId) throw new Error('legacy semantic migration state is bound to a different canonical subject');
  return {
    schema_version: 1,
    manifest_digest: parsed.manifest_digest,
    canonical_subject_id: parsed.canonical_subject_id,
    processed_source_ids: [...parsed.processed_source_ids],
  };
}

export function saveLegacySemanticState(file: string, state: LegacySemanticState): void { atomicWriteJson(file, state); }

export function listLegacySemanticReceipts(rootDir: string): LegacySemanticReceipt[] {
  return readJsonl<LegacySemanticReceipt>(path.join(rootDir, 'legacy-semantic-receipts.jsonl'));
}

function receiptId(receipt: Omit<LegacySemanticReceipt, 'schema_version' | 'receipt_id' | 'recorded_at'>): string {
  return stableId('legacy_semantic_receipt', receipt);
}

function appendSemanticReceipt(rootDir: string, receipt: LegacySemanticReceipt): LegacySemanticReceipt {
  const file = path.join(rootDir, 'legacy-semantic-receipts.jsonl');
  const existing = listLegacySemanticReceipts(rootDir).find((item) => item.receipt_id === receipt.receipt_id);
  if (existing) return existing;
  appendJsonl(file, receipt);
  return receipt;
}

function terminalReceipt(rootDir: string, sourceId: string, manifestDigest: string, canonicalSubjectId: string): LegacySemanticReceipt | undefined {
  return [...listLegacySemanticReceipts(rootDir)].reverse().find((item) =>
    item.legacy_source_id === sourceId && item.manifest_digest === manifestDigest && item.canonical_subject_id === canonicalSubjectId && item.result !== 'retryable_failure'
  );
}

function remainingCount(sources: LegacyAssistantMemorySourceRecord[], processed: Set<string>, selected?: Set<string>): number {
  return sources.filter((source) => (!selected || selected.has(source.legacy_source_id)) && !processed.has(source.legacy_source_id)).length;
}

function nextReceiptAttempt(rootDir: string, sourceId: string, manifestDigest: string, canonicalSubjectId: string): number {
  return listLegacySemanticReceipts(rootDir).filter((item) =>
    item.legacy_source_id === sourceId && item.manifest_digest === manifestDigest && item.canonical_subject_id === canonicalSubjectId
  ).length + 1;
}

export async function runLegacySemanticMigration(options: RunLegacySemanticMigrationOptions): Promise<LegacySemanticRunResult> {
  const rootDir = path.resolve(options.rootDir);
  const statePath = path.resolve(options.statePath ?? path.join(rootDir, 'legacy-semantic-migration-state.json'));
  const canonicalSubjectId = options.canonicalSubjectId.trim();
  if (!canonicalSubjectId) throw new Error('canonicalSubjectId must be a non-empty string');
  const legacyStore = new LegacyMemorySourceStore(rootDir);
  const canonicalStore = new RelationshipMemoryStore(rootDir, canonicalSubjectId);
  const sources = legacyStore.listSources();
  if (sources.length === 0) return { status: 'no-op', processed: 0, remaining: 0, detail: 'no legacy assistant sources found' };
  const expectedManifestDigest = options.expectedManifestDigest.trim();
  if (!/^[0-9a-f]{64}$/i.test(expectedManifestDigest)) throw new Error('expected legacy semantic manifest digest must be a SHA-256 hex digest');
  const manifestDigests = [...new Set(sources.map((source) => source.manifest_digest))];
  if (manifestDigests.length !== 1) throw new Error('legacy semantic sources span multiple manifest digests');
  const manifestDigest = manifestDigests[0];
  if (manifestDigest !== expectedManifestDigest) {
    throw new Error(`legacy semantic source manifest ${manifestDigest} does not match expected frozen manifest ${expectedManifestDigest}`);
  }
  const state = loadLegacySemanticState(statePath, manifestDigest, canonicalSubjectId);
  const processed = new Set(state.processed_source_ids);
  const selected = options.sourceIds?.length ? new Set(options.sourceIds) : undefined;
  if (selected) {
    const known = new Set(sources.map((source) => source.legacy_source_id));
    const missing = [...selected].filter((id) => !known.has(id));
    if (missing.length) throw new Error(`unknown legacy source id(s): ${missing.join(', ')}`);
  }
  for (const sourceId of processed) {
    if (!terminalReceipt(rootDir, sourceId, manifestDigest, canonicalSubjectId)) throw new Error(`semantic state marks source processed without terminal receipt: ${sourceId}`);
  }

  const candidates = sources.filter((source) => (!selected || selected.has(source.legacy_source_id)) && !processed.has(source.legacy_source_id));
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
  const planned = candidates.slice(0, maxRecords);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('legacy semantic concurrency must be a positive integer');
  if (options.dryRun) return { status: 'dry-run', manifest_digest: manifestDigest, processed: 0, remaining: candidates.length };
  if (planned.length === 0) return { status: 'no-op', manifest_digest: manifestDigest, processed: 0, remaining: 0 };

  let completedCount = 0;

  const processSource = async (source: LegacyAssistantMemorySourceRecord): Promise<LegacySemanticRunResult | undefined> => {
    const recovered = terminalReceipt(rootDir, source.legacy_source_id, manifestDigest, canonicalSubjectId);
    if (recovered) {
      legacyStore.withMutationBoundary(() => {
        const latestState = loadLegacySemanticState(statePath, manifestDigest, canonicalSubjectId);
        if (!latestState.processed_source_ids.includes(source.legacy_source_id)) {
          latestState.processed_source_ids.push(source.legacy_source_id);
          saveLegacySemanticState(statePath, latestState);
        }
        state.processed_source_ids = latestState.processed_source_ids;
        processed.add(source.legacy_source_id);
      });
      completedCount += 1;
      return undefined;
    }

    const batchId = legacySemanticBatchId(manifestDigest, source.legacy_source_id, canonicalSubjectId);
    const result = await options.processor(source, batchId);
    const provenance = provenanceForSubject(legacyStore, canonicalStore, canonicalSubjectId, source.legacy_source_id);
    let failure: string | undefined;
    if (result.completion === 'completed' && provenance.length === 0) failure = 'observer completed without canonical provenance';
    if (result.completion === 'no_memory_required' && provenance.length > 0) failure = 'observer returned no_memory_required after canonical provenance was written';
    const effectiveCompletion: LegacySemanticCompletion = failure ? 'retryable_failure' : result.completion;
    const memoryIds = [...new Set(provenance.map((item) => item.canonical_memory_id))].sort();
    const provenanceIds = provenance.map((item) => item.provenance_id).sort();
    const receiptCore = {
      attempt: nextReceiptAttempt(rootDir, source.legacy_source_id, manifestDigest, canonicalSubjectId),
      manifest_digest: manifestDigest,
      canonical_subject_id: canonicalSubjectId,
      legacy_source_id: source.legacy_source_id,
      batch_id: batchId,
      result: effectiveCompletion,
      provenance_ids: provenanceIds,
      memory_ids: memoryIds,
      ...((failure ?? result.reason) ? { reason: failure ?? result.reason } : {}),
    } as const;
    const receipt: LegacySemanticReceipt = {
      schema_version: 1,
      receipt_id: receiptId(receiptCore),
      ...receiptCore,
      recorded_at: new Date().toISOString(),
    };

    if (effectiveCompletion === 'retryable_failure') {
      legacyStore.withMutationBoundary(() => appendSemanticReceipt(rootDir, receipt));
      return {
        status: 'blocked-failure', manifest_digest: manifestDigest, processed: completedCount,
        remaining: remainingCount(sources, processed, selected), source_id: source.legacy_source_id,
        detail: receipt.reason ?? 'legacy semantic observer retryable failure',
      };
    }

    legacyStore.withMutationBoundary(() => {
      appendSemanticReceipt(rootDir, receipt);
      const latestState = loadLegacySemanticState(statePath, manifestDigest, canonicalSubjectId);
      if (!latestState.processed_source_ids.includes(source.legacy_source_id)) {
        latestState.processed_source_ids.push(source.legacy_source_id);
        saveLegacySemanticState(statePath, latestState);
      }
      state.processed_source_ids = latestState.processed_source_ids;
      processed.add(source.legacy_source_id);
    });
    completedCount += 1;
    return undefined;
  };

  if (concurrency === 1) {
    for (const source of planned) {
      const blocked = await processSource(source);
      if (blocked) return blocked;
    }
  } else {
    let cursor = 0;
    let blocked: LegacySemanticRunResult | undefined;
    const workers = Array.from({ length: Math.min(concurrency, planned.length) }, async () => {
      while (true) {
        if (blocked) return;
        const index = cursor;
        cursor += 1;
        if (index >= planned.length) return;
        const failure = await processSource(planned[index]);
        if (failure && !blocked) blocked = failure;
      }
    });
    await Promise.all(workers);
    if (blocked) {
      return {
        ...blocked,
        processed: completedCount,
        remaining: remainingCount(sources, processed, selected),
      };
    }
  }

  return {
    status: 'completed', manifest_digest: manifestDigest, processed: completedCount,
    remaining: remainingCount(sources, processed, selected),
  };
}
