import type {
  BatchCompletion,
  CanonicalMessage,
  CanonicalMemoryRecord,
  EvidenceRecord,
  MemoryKind,
  ParticipantRole,
  RememberOutcome,
} from '../schema/index.js';
import { validateProposal } from '../schema/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';

export interface SearchQuery {
  kind?: MemoryKind;
  participant?: ParticipantRole;
  trigger?: string;
  linked_memory_id?: string;
  time_start?: string;
  time_end?: string;
  query?: string;
}

export interface RememberResult {
  outcome: RememberOutcome['outcome'];
  memory_id?: string;
  rejection_code?: string;
  reason?: string;
}

export class RelationshipMemoryRuntime {
  private readonly retryableBatches = new Set<string>();

  constructor(
    readonly store: RelationshipMemoryStore,
    readonly messages: Map<string, CanonicalMessage>,
    readonly now: () => string = () => new Date().toISOString(),
  ) {}

  memorySearch(query: SearchQuery): CanonicalMemoryRecord[] {
    const needle = query.query?.trim().toLowerCase();
    const trigger = query.trigger?.trim().toLowerCase();
    return this.store.listMemories().filter((memory) => {
      if (query.kind && memory.kind !== query.kind) return false;
      if (query.participant && !memory.participants.includes(query.participant)) return false;
      if (query.linked_memory_id && !memory.linked_memory_ids?.includes(query.linked_memory_id)) return false;
      if (query.time_start && memory.observed_at < query.time_start) return false;
      if (query.time_end && memory.observed_at > query.time_end) return false;
      const haystack = stableJson({ summary: memory.summary, payload: memory.payload }).toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
      if (trigger && !haystack.includes(trigger)) return false;
      return true;
    });
  }

  remember(batchId: string, rawProposal: unknown): RememberResult {
    const now = this.now();
    const sourceKey = stableId('src', { batch_id: batchId, proposal: rawProposal });
    const previous = this.store.getTerminalOutcome(sourceKey);
    if (previous) {
      if (previous.outcome === 'accepted' || previous.outcome === 'duplicate') {
        return { outcome: 'duplicate', ...(previous.memory_id ? { memory_id: previous.memory_id } : {}) };
      }
      return { outcome: 'permanently_rejected', rejection_code: previous.rejection_code, reason: previous.reason };
    }

    const validation = validateProposal(rawProposal);
    if (!validation.ok || !validation.proposal) {
      const outcome: RememberOutcome = {
        batch_id: batchId,
        source_key: sourceKey,
        outcome: 'permanently_rejected',
        rejection_code: validation.code ?? 'invalid_schema',
        reason: validation.reason ?? 'Invalid schema.',
        recorded_at: now,
      };
      try { this.store.appendOutcome(outcome); }
      catch { return this.retryableFailure(batchId, 'Failed to durably record permanent rejection.'); }
      return { outcome: outcome.outcome, rejection_code: outcome.rejection_code, reason: outcome.reason };
    }

    const proposal = validation.proposal;
    for (const linkedId of proposal.linked_memory_ids ?? []) {
      if (!this.store.getMemory(linkedId)) return this.persistPermanent(batchId, sourceKey, 'unknown_linked_memory', `Unknown canonical memory ID: ${linkedId}`, now);
    }

    const evidenceMessages: CanonicalMessage[] = [];
    for (const messageId of proposal.evidence_message_ids) {
      const message = this.messages.get(messageId);
      if (!message) return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence message is not available in the trusted batch: ${messageId}`, now);
      evidenceMessages.push(message);
    }

    const dedupeKey = stableId('dedupe', {
      subject_id: this.store.subjectId,
      kind: proposal.kind,
      summary: proposal.summary,
      participants: proposal.participants,
      evidence_message_ids: proposal.evidence_message_ids,
      payload: proposal.payload,
      linked_memory_ids: proposal.linked_memory_ids ?? [],
    });

    const recoveredMemory = this.store.getMemoryBySourceKey(sourceKey);
    if (recoveredMemory) {
      const recoveredEvidence: EvidenceRecord[] = evidenceMessages.map((message) => ({
        evidence_id: stableId('ev', { memory_id: recoveredMemory.memory_id, message_id: message.message_id }),
        memory_id: recoveredMemory.memory_id,
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        role: message.role,
        quote: message.quote,
        captured_at: message.captured_at,
      }));
      try {
        this.store.appendMemory(recoveredMemory, recoveredEvidence);
        this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'accepted', memory_id: recoveredMemory.memory_id, recorded_at: now });
        return { outcome: 'duplicate', memory_id: recoveredMemory.memory_id };
      } catch {
        return this.retryableFailure(batchId, 'Canonical memory exists but terminal recovery is not durable yet.');
      }
    }

    const semanticDuplicate = this.store.getMemoryByDedupeKey(dedupeKey);
    if (semanticDuplicate) {
      try {
        this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'duplicate', memory_id: semanticDuplicate.memory_id, recorded_at: now });
        return { outcome: 'duplicate', memory_id: semanticDuplicate.memory_id };
      } catch {
        return this.retryableFailure(batchId, 'Failed to durably record duplicate outcome.');
      }
    }

    const memoryId = stableId('mem', { subject_id: this.store.subjectId, source_key: sourceKey });
    const memory: CanonicalMemoryRecord = {
      schema_version: 1,
      memory_id: memoryId,
      subject_id: this.store.subjectId,
      kind: proposal.kind,
      summary: proposal.summary,
      participants: proposal.participants,
      payload: proposal.payload,
      ...(proposal.linked_memory_ids ? { linked_memory_ids: proposal.linked_memory_ids } : {}),
      status: 'active',
      observed_at: evidenceMessages.map((m) => m.captured_at).sort()[0] ?? now,
      created_at: now,
      source_key: sourceKey,
      dedupe_key: dedupeKey,
    };
    const evidence: EvidenceRecord[] = evidenceMessages.map((message) => ({
      evidence_id: stableId('ev', { memory_id: memoryId, message_id: message.message_id }),
      memory_id: memoryId,
      conversation_id: message.conversation_id,
      message_id: message.message_id,
      role: message.role,
      quote: message.quote,
      captured_at: message.captured_at,
    }));

    try {
      this.store.appendMemory(memory, evidence);
      this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'accepted', memory_id: memoryId, recorded_at: now });
      return { outcome: 'accepted', memory_id: memoryId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'retryable_failed', reason, recorded_at: now }); }
      catch { /* caller still receives the only non-terminal business result */ }
      return this.retryableFailure(batchId, reason);
    }
  }

  private retryableFailure(batchId: string, reason: string): RememberResult {
    this.retryableBatches.add(batchId);
    return { outcome: 'retryable_failed', reason };
  }

  private persistPermanent(batchId: string, sourceKey: string, code: string, reason: string, now: string): RememberResult {
    try {
      this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'permanently_rejected', rejection_code: code, reason, recorded_at: now });
      return { outcome: 'permanently_rejected', rejection_code: code, reason };
    } catch {
      return this.retryableFailure(batchId, 'Failed to durably record permanent rejection.');
    }
  }

  finalizeBatch(batchId: string, sessionSucceeded: boolean): BatchCompletion {
    const now = this.now();
    const outcomes = this.store.listOutcomes().filter((item) => item.batch_id === batchId);
    const latestBySource = new Map<string, RememberOutcome>();
    for (const outcome of outcomes) latestBySource.set(outcome.source_key, outcome);
    const retryable = !sessionSucceeded || this.retryableBatches.has(batchId) || [...latestBySource.values()].some((item) => item.outcome === 'retryable_failed');
    const status: BatchCompletion = retryable ? 'retryable_failure' : 'completed';
    this.store.finalizeBatch({
      batch_id: batchId,
      status,
      created_at: this.store.listBatches().find((item) => item.batch_id === batchId)?.created_at ?? now,
      finalized_at: now,
      ...(!retryable && outcomes.length === 0 ? { detail: 'no_memory_required' as const } : {}),
    });
    return status;
  }
}

export function cursorShouldAdvance(completion: BatchCompletion): boolean {
  return completion === 'completed';
}

export function memoryRememberToolSchema(): Record<string, unknown> {
  const string = { type: 'string', minLength: 1 };
  const strings = { type: 'array', uniqueItems: true, items: string };
  const common = {
    schema_version: { type: 'integer', enum: [1] },
    summary: string,
    participants: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'assistant'] } },
    evidence_message_ids: { type: 'array', minItems: 1, uniqueItems: true, items: string },
    linked_memory_ids: strings,
  };
  const variant = (kind: MemoryKind, requiredPayload: string[], optionalPayload: string[], payloadProperties: Record<string, unknown>) => ({
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'kind', 'summary', 'participants', 'evidence_message_ids', 'payload'],
    properties: {
      ...common,
      kind: { type: 'string', enum: [kind] },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: requiredPayload,
        properties: Object.fromEntries([...requiredPayload, ...optionalPayload].map((key) => [key, payloadProperties[key]])),
      },
    },
  });
  return {
    oneOf: [
      variant('personal_experience', ['title', 'experience'], ['time_text', 'places', 'themes', 'emotional_tone', 'why_memorable', 'recall_triggers'], {
        title: string, experience: string, time_text: string, places: strings, themes: strings,
        emotional_tone: string, why_memorable: string, recall_triggers: strings,
      }),
      variant('shared_experience', ['title', 'event', 'shared_meaning'], ['symbols', 'recall_triggers'], {
        title: string, event: string, shared_meaning: string, symbols: strings, recall_triggers: strings,
      }),
      variant('relationship_event', ['event', 'meaning'], ['prior_context', 'resulting_change'], {
        event: string, meaning: string, prior_context: string, resulting_change: string,
      }),
      variant('inside_joke', ['name', 'meaning', 'trigger_phrases'], ['origin', 'callbacks', 'tone'], {
        name: string, meaning: string,
        trigger_phrases: { type: 'array', minItems: 1, uniqueItems: true, items: string },
        origin: string, callbacks: strings, tone: string,
      }),
    ],
  };
}

export function memorySearchToolSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke'] },
      participant: { type: 'string', enum: ['user', 'assistant'] },
      trigger: { type: 'string' }, linked_memory_id: { type: 'string' }, time_start: { type: 'string' }, time_end: { type: 'string' }, query: { type: 'string' },
    },
  };
}
