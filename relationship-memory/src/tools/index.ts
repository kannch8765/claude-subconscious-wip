import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  BatchCompletion,
  CanonicalMessage,
  CanonicalMemoryRecord,
  EffectiveMemoryRecord,
  EvidenceRecord,
  MemoryKind,
  ParticipantRole,
  RememberOutcome,
} from '../schema/index.js';
import { validateProposal } from '../schema/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';

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

function rawAssistantIntentId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).assistant_intent_id;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

export class RelationshipMemoryRuntime {
  private readonly retryableBatches = new Set<string>();

  constructor(
    readonly store: RelationshipMemoryStore,
    readonly messages: Map<string, CanonicalMessage>,
    readonly now: () => string = () => new Date().toISOString(),
    readonly trustedAssistantIntents: Map<string, AssistantRememberIntentRecord> = new Map(),
  ) {}

  private linkedAssistantIntents(memoryId: string): AssistantRememberIntentRecord[] {
    const latest = new Map<string, AssistantIntentOutcome>();
    for (const outcome of this.store.listAssistantIntentOutcomes()) latest.set(outcome.intent_id, outcome);
    const result: AssistantRememberIntentRecord[] = [];
    for (const [intentId, outcome] of latest) {
      if ((outcome.outcome !== 'accepted' && outcome.outcome !== 'duplicate') || outcome.memory_id !== memoryId) continue;
      const intent = this.store.getAssistantIntent(intentId);
      if (intent) result.push(intent);
    }
    return result;
  }

  memorySearch(query: SearchQuery): EffectiveMemoryRecord[] {
    const needle = query.query?.trim().toLowerCase();
    const trigger = query.trigger?.trim().toLowerCase();
    return new RelationshipMemoryOwnerControlPlane(this.store).search({ active: true }).filter((memory) => {
      if (query.kind && memory.kind !== query.kind) return false;
      if (query.participant && !memory.participants.includes(query.participant)) return false;
      if (query.linked_memory_id && !memory.linked_memory_ids?.includes(query.linked_memory_id)) return false;
      if (query.time_start && memory.observed_at < query.time_start) return false;
      if (query.time_end && memory.observed_at > query.time_end) return false;
      const linkedIntents = this.linkedAssistantIntents(memory.memory_id).map((intent) => ({
        memory: intent.memory.text,
        feel: intent.feel.text,
      }));
      const haystack = stableJson({ summary: memory.summary, payload: memory.payload, assistant_intents: linkedIntents }).toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
      if (trigger && !haystack.includes(trigger)) return false;
      return true;
    });
  }

  private trustedIntent(intentId: string | undefined): AssistantRememberIntentRecord | undefined {
    if (!intentId) return undefined;
    const catalog = this.trustedAssistantIntents.get(intentId);
    const durable = this.store.getAssistantIntent(intentId);
    if (!catalog || !durable || stableJson(catalog) !== stableJson(durable)) return undefined;
    return durable;
  }

  private markRetryable(batchId: string, sourceKey: string, reason: string, now: string, intent?: AssistantRememberIntentRecord): RememberResult {
    this.retryableBatches.add(batchId);
    try {
      this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'retryable_failed', reason, recorded_at: now });
    } catch { /* the in-memory batch marker still prevents cursor advance */ }
    if (intent) {
      try {
        this.store.appendAssistantIntentOutcome({ intent_id: intent.intent_id, batch_id: batchId, outcome: 'retryable_failed', reason, recorded_at: now });
      } catch { /* the trusted intent remains unresolved and finalizeBatch will hold */ }
    }
    return { outcome: 'retryable_failed', reason };
  }

  private persistOutcomePair(
    batchId: string,
    sourceKey: string,
    outcome: 'accepted' | 'duplicate',
    memoryId: string,
    now: string,
    intent?: AssistantRememberIntentRecord,
  ): RememberResult {
    try {
      this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome, memory_id: memoryId, recorded_at: now });
      if (intent) {
        this.store.appendAssistantIntentOutcome({
          intent_id: intent.intent_id,
          batch_id: batchId,
          outcome,
          memory_id: memoryId,
          recorded_at: now,
        });
      }
      return { outcome, memory_id: memoryId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.markRetryable(batchId, sourceKey, reason, now, intent);
    }
  }

  private persistPermanent(
    batchId: string,
    sourceKey: string,
    code: string,
    reason: string,
    now: string,
    intent?: AssistantRememberIntentRecord,
  ): RememberResult {
    try {
      this.store.appendOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'permanently_rejected', rejection_code: code, reason, recorded_at: now });
      if (intent) {
        this.store.appendAssistantIntentOutcome({
          intent_id: intent.intent_id,
          batch_id: batchId,
          outcome: 'permanently_rejected',
          rejection_code: code,
          reason,
          recorded_at: now,
        });
      }
      return { outcome: 'permanently_rejected', rejection_code: code, reason };
    } catch {
      return this.markRetryable(batchId, sourceKey, 'Failed to durably record permanent rejection.', now, intent);
    }
  }

  remember(batchId: string, rawProposal: unknown): RememberResult {
    const now = this.now();
    const sourceKey = stableId('src', { batch_id: batchId, proposal: rawProposal });
    const rawIntentId = rawAssistantIntentId(rawProposal);
    const rawTrustedIntent = this.trustedIntent(rawIntentId);
    const previous = this.store.getTerminalOutcome(sourceKey);
    if (previous) {
      if (previous.outcome === 'accepted' || previous.outcome === 'duplicate') {
        if (!previous.memory_id) return this.markRetryable(batchId, sourceKey, 'Terminal memory outcome is missing memory_id.', now, rawTrustedIntent);
        const repaired = this.persistOutcomePair(batchId, sourceKey, previous.outcome, previous.memory_id, now, rawTrustedIntent);
        return repaired.outcome === 'retryable_failed' ? repaired : { outcome: 'duplicate', memory_id: previous.memory_id };
      }
      return this.persistPermanent(
        batchId,
        sourceKey,
        previous.rejection_code ?? 'invalid_schema',
        previous.reason ?? 'Previously rejected proposal.',
        now,
        rawTrustedIntent,
      );
    }

    const validation = validateProposal(rawProposal);
    if (!validation.ok || !validation.proposal) {
      return this.persistPermanent(
        batchId,
        sourceKey,
        validation.code ?? 'invalid_schema',
        validation.reason ?? 'Invalid schema.',
        now,
        rawTrustedIntent,
      );
    }

    const proposal = validation.proposal;
    let assistantIntent: AssistantRememberIntentRecord | undefined;
    if (proposal.assistant_intent_id) {
      assistantIntent = this.trustedIntent(proposal.assistant_intent_id);
      if (!assistantIntent) {
        return this.persistPermanent(
          batchId,
          sourceKey,
          'unknown_assistant_intent',
          `Assistant intent is not present in the trusted current-batch catalog: ${proposal.assistant_intent_id}`,
          now,
        );
      }
    }

    for (const linkedId of proposal.linked_memory_ids ?? []) {
      if (!this.store.getMemory(linkedId)) {
        return this.persistPermanent(batchId, sourceKey, 'unknown_linked_memory', `Unknown canonical memory ID: ${linkedId}`, now, assistantIntent);
      }
    }

    const evidenceMessages: CanonicalMessage[] = [];
    for (const messageId of proposal.evidence_message_ids) {
      const message = this.messages.get(messageId);
      if (!message) {
        return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence message is not available in the trusted batch: ${messageId}`, now, assistantIntent);
      }
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
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return this.markRetryable(batchId, sourceKey, reason, now, assistantIntent);
      }
      const repaired = this.persistOutcomePair(batchId, sourceKey, 'accepted', recoveredMemory.memory_id, now, assistantIntent);
      return repaired.outcome === 'retryable_failed' ? repaired : { outcome: 'duplicate', memory_id: recoveredMemory.memory_id };
    }

    const semanticShape = stableJson({
      subject_id: this.store.subjectId,
      kind: proposal.kind,
      summary: proposal.summary,
      participants: proposal.participants,
      payload: proposal.payload,
      linked_memory_ids: proposal.linked_memory_ids ?? [],
    });
    const semanticDuplicate = assistantIntent
      ? this.store.listMemories().find((candidate) => stableJson({
          subject_id: candidate.subject_id,
          kind: candidate.kind,
          summary: candidate.summary,
          participants: candidate.participants,
          payload: candidate.payload,
          linked_memory_ids: candidate.linked_memory_ids ?? [],
        }) === semanticShape)
      : this.store.getMemoryByDedupeKey(dedupeKey);
    if (semanticDuplicate) {
      return this.persistOutcomePair(batchId, sourceKey, 'duplicate', semanticDuplicate.memory_id, now, assistantIntent);
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.markRetryable(batchId, sourceKey, reason, now, assistantIntent);
    }
    return this.persistOutcomePair(batchId, sourceKey, 'accepted', memoryId, now, assistantIntent);
  }

  finalizeBatch(batchId: string, sessionSucceeded: boolean): BatchCompletion {
    const now = this.now();
    const outcomes = this.store.listOutcomes().filter((item) => item.batch_id === batchId);
    const latestBySource = new Map<string, RememberOutcome>();
    for (const outcome of outcomes) latestBySource.set(outcome.source_key, outcome);

    const intentOutcomes = this.store.listAssistantIntentOutcomes().filter((item) => item.batch_id === batchId);
    const latestByIntent = new Map<string, AssistantIntentOutcome>();
    for (const outcome of intentOutcomes) latestByIntent.set(outcome.intent_id, outcome);
    const unresolvedAssistantIntent = [...this.trustedAssistantIntents.keys()].some((intentId) => {
      const latest = latestByIntent.get(intentId);
      return !latest || latest.outcome === 'retryable_failed';
    });

    const retryable = !sessionSucceeded
      || this.retryableBatches.has(batchId)
      || [...latestBySource.values()].some((item) => item.outcome === 'retryable_failed')
      || unresolvedAssistantIntent;
    const status: BatchCompletion = retryable ? 'retryable_failure' : 'completed';
    this.store.finalizeBatch({
      batch_id: batchId,
      status,
      created_at: this.store.listBatches().find((item) => item.batch_id === batchId)?.created_at ?? now,
      finalized_at: now,
      ...(!retryable && outcomes.length === 0 && this.trustedAssistantIntents.size === 0 ? { detail: 'no_memory_required' as const } : {}),
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
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'kind', 'summary', 'participants', 'evidence_message_ids', 'payload'],
    properties: {
      schema_version: { type: 'integer', enum: [1], description: 'Relationship-memory proposal schema version; must be 1.' },
      kind: {
        type: 'string',
        enum: ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke'],
        description: 'Canonical relationship-memory kind. payload fields must match this kind exactly.',
      },
      summary: string,
      participants: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'assistant'] } },
      evidence_message_ids: {
        type: 'array', minItems: 1, uniqueItems: true, items: string,
        description: 'Exact message_id values copied from the current-batch relationship-memory evidence catalog.',
      },
      linked_memory_ids: strings,
      assistant_intent_id: {
        type: 'string', minLength: 1,
        description: 'Optional trusted assistant remember-intent ID copied exactly from the current-batch assistant intent catalog. Never supply feel text here.',
      },
      payload: {
        type: 'object',
        additionalProperties: false,
        description: [
          'Kind-specific payload. Trusted validation remains authoritative.',
          'personal_experience requires title, experience; optional time_text, places, themes, emotional_tone, why_memorable, recall_triggers.',
          'shared_experience requires title, event, shared_meaning; optional symbols, recall_triggers.',
          'relationship_event requires event, meaning; optional prior_context, resulting_change.',
          'inside_joke requires name, meaning, trigger_phrases; optional origin, callbacks, tone.',
        ].join(' '),
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
          trigger_phrases: { type: 'array', minItems: 1, uniqueItems: true, items: string },
          origin: string,
          callbacks: strings,
          tone: string,
        },
      },
    },
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
