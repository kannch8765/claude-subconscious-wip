import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  BatchCompletion,
  CanonicalMessage,
  CanonicalMemoryRecord,
  EffectiveMemoryRecord,
  EvidenceRecord,
  EntityEvidenceRecord,
  EntityIdentityRecord,
  MemoryKind,
  ParticipantRole,
  RememberOutcome,
  ReinforcementRecord,
} from '../schema/index.js';
import { normalizeEntityAlias, validateEntityIdentityProposal, validateProposal } from '../schema/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';
import { hybridScore, lexicalTextScore, semanticText, type SemanticRetriever } from '../retrieval/index.js';

export interface SearchQuery {
  kind?: MemoryKind;
  participant?: ParticipantRole;
  trigger?: string;
  linked_memory_id?: string;
  time_start?: string;
  time_end?: string;
  query?: string;
  limit?: number;
}

export interface ReinforceInput { memory_id: string; evidence_ids?: string[]; evidence_message_ids?: string[] }
export interface EntitySearchQuery { query?: string; limit?: number }
export interface EntitySearchResult extends EntityIdentityRecord { evidence_ids: string[]; evidence_message_ids: string[] }

export interface RememberResult {
  outcome: RememberOutcome['outcome'];
  memory_id?: string;
  entity_id?: string;
  rejection_code?: string;
  reason?: string;
}

function boundedSearchLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 8, 20));
}

function rawAssistantIntentId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).assistant_intent_id;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function canonicalEvidenceId(message: CanonicalMessage): string {
  return message.evidence_id ?? message.message_id;
}

function memoryEvidenceId(memoryId: string, message: CanonicalMessage): string {
  return message.evidence_id
    ? stableId('ev', { memory_id: memoryId, source_evidence_id: message.evidence_id })
    : stableId('ev', { memory_id: memoryId, message_id: message.message_id });
}

function entityEvidenceId(entityId: string, message: CanonicalMessage): string {
  return message.evidence_id
    ? stableId('entity_ev', { entity_id: entityId, source_evidence_id: message.evidence_id })
    : stableId('entity_ev', { entity_id: entityId, message_id: message.message_id });
}

function evidenceProvenance(message: CanonicalMessage) {
  return {
    source_evidence_id: canonicalEvidenceId(message),
    ...(message.event_kind ? { event_kind: message.event_kind } : {}),
    ...(message.block_index === undefined ? {} : { block_index: message.block_index }),
    ...(message.tool_name ? { tool_name: message.tool_name } : {}),
    ...(message.tool_use_id ? { tool_use_id: message.tool_use_id } : {}),
  };
}

export class RelationshipMemoryRuntime {
  private readonly retryableBatches = new Set<string>();

  constructor(
    readonly store: RelationshipMemoryStore,
    readonly messages: Map<string, CanonicalMessage>,
    readonly now: () => string = () => new Date().toISOString(),
    readonly trustedAssistantIntents: Map<string, AssistantRememberIntentRecord> = new Map(),
    readonly requireChineseSemanticProse = false,
    readonly semanticRetriever?: SemanticRetriever,
  ) {}

  private trustedEvidence(id: string, allowLegacyMessageId = false): { message?: CanonicalMessage; ambiguous?: boolean } {
    const values = [...this.messages.values()];
    const exact = values.filter((message) => canonicalEvidenceId(message) === id);
    if (exact.length === 1) return { message: exact[0] };
    if (exact.length > 1) return { ambiguous: true };
    if (!allowLegacyMessageId) return {};
    const legacy = values.filter((message) => message.message_id === id);
    if (legacy.length === 1) return { message: legacy[0] };
    if (legacy.length > 1) return { ambiguous: true };
    return {};
  }

  private legacyEvidenceField(raw: unknown): boolean {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw)
      && !('evidence_ids' in raw) && 'evidence_message_ids' in raw;
  }

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
    return new RelationshipMemoryOwnerControlPlane(this.store).search({ active: true }).map((memory) => {
      const reinforcements = this.store.listReinforcements().filter((item) => item.memory_id === memory.memory_id);
      const evidenceIds = [...new Set(reinforcements.flatMap((item) => item.evidence_ids))];
      const latest = reinforcements.map((item) => item.latest_evidence_at).sort().at(-1);
      return { ...memory, ...(reinforcements.length ? { reinforcement_count: reinforcements.length, reinforcement_evidence_count: evidenceIds.length, reinforcement_evidence_ids: evidenceIds.slice(-20), latest_reinforcement_at: latest } : {}) };
    }).filter((memory) => {
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

  async memorySearchHybrid(query: SearchQuery): Promise<EffectiveMemoryRecord[]> {
    const semanticQuery = query.query?.trim();
    const limit = boundedSearchLimit(query.limit);
    if (!this.semanticRetriever || !semanticQuery) return this.memorySearch(query).slice(0, limit);
    const candidates = this.memorySearch({ ...query, query: undefined });
    const documents = candidates.map((memory) => {
      const linkedIntents = this.linkedAssistantIntents(memory.memory_id).map((intent) => ({ memory: intent.memory.text, feel: intent.feel.text }));
      return {
        id: `memory:${memory.memory_id}`,
        text: semanticText(memory.kind, memory.summary, memory.participants, memory.payload, linkedIntents),
      };
    });
    try {
      const semantic = await this.semanticRetriever.rank(documents, semanticQuery);
      return candidates.map((memory, index) => ({
        memory,
        score: hybridScore(lexicalTextScore(documents[index].text, semanticQuery), semantic.get(documents[index].id)),
      })).sort((a, b) => b.score - a.score || b.memory.observed_at.localeCompare(a.memory.observed_at))
        .slice(0, limit)
        .map((item) => item.memory);
    } catch {
      return this.memorySearch(query).slice(0, limit);
    }
  }

  entitySearch(query: EntitySearchQuery = {}): EntitySearchResult[] {
    const needle = query.query?.trim();
    const normalized = needle ? normalizeEntityAlias(needle) : undefined;
    return this.store.listEntities().filter((entity) => {
      if (!needle || !normalized) return true;
      if (entity.aliases.some((alias) => normalizeEntityAlias(alias) === normalized)) return true;
      return stableJson({ canonical_name: entity.canonical_name, aliases: entity.aliases, description: entity.description }).toLowerCase().includes(needle.toLowerCase());
    }).map((entity) => {
      const evidence = this.store.listEntityEvidence().filter((item) => item.entity_id === entity.entity_id);
      return {
        ...entity,
        evidence_ids: evidence.map((item) => item.evidence_id),
        evidence_message_ids: evidence.map((item) => item.message_id),
      };
    });
  }

  async entitySearchHybrid(query: EntitySearchQuery = {}): Promise<EntitySearchResult[]> {
    const semanticQuery = query.query?.trim();
    const limit = boundedSearchLimit(query.limit);
    if (!this.semanticRetriever || !semanticQuery) return this.entitySearch(query).slice(0, limit);
    const candidates = this.entitySearch({});
    const documents = candidates.map((entity) => ({
      id: `entity:${entity.entity_id}`,
      text: semanticText(entity.canonical_name, entity.aliases, entity.entity_type, entity.description),
    }));
    try {
      const semantic = await this.semanticRetriever.rank(documents, semanticQuery);
      return candidates.map((entity, index) => ({
        entity,
        score: hybridScore(lexicalTextScore(documents[index].text, semanticQuery), semantic.get(documents[index].id)),
      })).sort((a, b) => b.score - a.score || b.entity.observed_at.localeCompare(a.entity.observed_at))
        .slice(0, limit)
        .map((item) => item.entity);
    } catch {
      return this.entitySearch(query).slice(0, limit);
    }
  }

  private entityRetryable(batchId: string, sourceKey: string, reason: string, now: string): RememberResult {
    this.retryableBatches.add(batchId);
    try { this.store.appendEntityOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'retryable_failed', reason, recorded_at: now }); } catch { }
    return { outcome: 'retryable_failed', reason };
  }

  private entityPermanent(batchId: string, sourceKey: string, code: string, reason: string, now: string): RememberResult {
    try {
      this.store.appendEntityOutcome({ batch_id: batchId, source_key: sourceKey, outcome: 'permanently_rejected', rejection_code: code, reason, recorded_at: now });
      return { outcome: 'permanently_rejected', rejection_code: code, reason };
    } catch {
      return this.entityRetryable(batchId, sourceKey, 'Failed to durably record entity rejection.', now);
    }
  }

  private entityOutcome(batchId: string, sourceKey: string, outcome: 'accepted' | 'duplicate', entityId: string, now: string): RememberResult {
    try {
      this.store.appendEntityOutcome({ batch_id: batchId, source_key: sourceKey, outcome, entity_id: entityId, recorded_at: now });
      return { outcome, entity_id: entityId };
    } catch (error) {
      return this.entityRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now);
    }
  }

  rememberEntity(batchId: string, rawProposal: unknown): RememberResult {
    const now = this.now();
    const sourceKey = stableId('entity_src', { batch_id: batchId, proposal: rawProposal });
    const previous = this.store.getTerminalEntityOutcome(sourceKey);
    if (previous) {
      if ((previous.outcome === 'accepted' || previous.outcome === 'duplicate') && previous.entity_id) return { outcome: 'duplicate', entity_id: previous.entity_id };
      return { outcome: previous.outcome, rejection_code: previous.rejection_code, reason: previous.reason };
    }
    const validation = validateEntityIdentityProposal(rawProposal, { requireChineseSemanticProse: this.requireChineseSemanticProse });
    if (!validation.ok || !validation.proposal) return this.entityPermanent(batchId, sourceKey, validation.code ?? 'invalid_schema', validation.reason ?? 'Invalid entity proposal.', now);
    const proposal = validation.proposal;
    const legacyEvidenceField = this.legacyEvidenceField(rawProposal);
    const evidenceMessages: CanonicalMessage[] = [];
    for (const evidenceId of proposal.evidence_message_ids) {
      const resolved = this.trustedEvidence(evidenceId, legacyEvidenceField);
      if (resolved.ambiguous) return this.entityPermanent(batchId, sourceKey, 'ambiguous_evidence', `Legacy message_id identifies multiple trusted transcript events; use an exact evidence_id: ${evidenceId}`, now);
      if (!resolved.message) return this.entityPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${evidenceId}`, now);
      evidenceMessages.push(resolved.message);
    }
    const recovered = this.store.getEntityBySourceKey(sourceKey);
    if (recovered) {
      const recoveredEvidence: EntityEvidenceRecord[] = evidenceMessages.map((message) => ({
        evidence_id: entityEvidenceId(recovered.entity_id, message),
        entity_id: recovered.entity_id,
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        role: message.role,
        quote: message.quote,
        captured_at: message.captured_at,
        ...evidenceProvenance(message),
      }));
      try {
        this.store.appendEntity(recovered, recoveredEvidence);
      } catch (error) {
        return this.entityRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now);
      }
      return this.entityOutcome(batchId, sourceKey, 'duplicate', recovered.entity_id, now);
    }

    const aliases = proposal.aliases.map(normalizeEntityAlias);
    const collisions = this.store.listEntities().filter((entity) => entity.aliases.some((alias) => aliases.includes(normalizeEntityAlias(alias))));
    if (collisions.length > 0) {
      const existing = collisions[0];
      if (collisions.some((entity) => entity.entity_id !== existing.entity_id)) return this.entityPermanent(batchId, sourceKey, 'alias_collision', 'Alias set maps to multiple existing entity identities.', now);
      const existingAliases = new Set(existing.aliases.map(normalizeEntityAlias));
      const proposalNames = new Set([normalizeEntityAlias(proposal.canonical_name), ...aliases]);
      const sameIdentity = existing.entity_type === proposal.entity_type
        && existing.description === proposal.description
        && [...proposalNames].every((alias) => existingAliases.has(alias));
      if (!sameIdentity) return this.entityPermanent(batchId, sourceKey, 'alias_collision', `Alias already belongs to canonical entity ${existing.canonical_name}.`, now);
      return this.entityOutcome(batchId, sourceKey, 'duplicate', existing.entity_id, now);
    }
    const entityId = stableId('entity', { subject_id: this.store.subjectId, canonical_name: normalizeEntityAlias(proposal.canonical_name) });
    const entity: EntityIdentityRecord = {
      schema_version: 1, entity_id: entityId, subject_id: this.store.subjectId, canonical_name: proposal.canonical_name, aliases: proposal.aliases,
      entity_type: proposal.entity_type, description: proposal.description, observed_at: evidenceMessages.map((m) => m.captured_at).sort()[0] ?? now, created_at: now, source_key: sourceKey,
    };
    const evidence: EntityEvidenceRecord[] = evidenceMessages.map((message) => ({
      evidence_id: entityEvidenceId(entityId, message), entity_id: entityId, conversation_id: message.conversation_id,
      message_id: message.message_id, role: message.role, quote: message.quote, captured_at: message.captured_at,
      ...evidenceProvenance(message),
    }));
    try { this.store.appendEntity(entity, evidence); } catch (error) { return this.entityRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now); }
    return this.entityOutcome(batchId, sourceKey, 'accepted', entityId, now);
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

  private originalMemoryEvidenceIds(memory: CanonicalMemoryRecord): Set<string> | undefined {
    const evidence = this.store.listEvidence().filter((item) => item.memory_id === memory.memory_id);
    for (let length = 1; length <= evidence.length; length += 1) {
      const prefix = evidence.slice(0, length);
      const dedupeKey = stableId('dedupe', {
        subject_id: memory.subject_id,
        kind: memory.kind,
        summary: memory.summary,
        participants: memory.participants,
        evidence_message_ids: prefix.map((item) => item.source_evidence_id ?? item.message_id),
        payload: memory.payload,
        linked_memory_ids: memory.linked_memory_ids ?? [],
      });
      if (dedupeKey === memory.dedupe_key) return new Set(prefix.map((item) => item.evidence_id));
    }
    return undefined;
  }

  reinforce(batchId: string, input: ReinforceInput): RememberResult {
    const now = this.now();
    const memoryId = typeof input?.memory_id === 'string' ? input.memory_id.trim() : '';
    const rawIds = input?.evidence_ids ?? input?.evidence_message_ids;
    const ids = Array.isArray(rawIds) ? rawIds.map((id) => typeof id === 'string' ? id.trim() : '') : [];
    const normalizedIds = [...ids].sort();
    const legacyEvidenceField = input?.evidence_ids === undefined && input?.evidence_message_ids !== undefined;
    const sourceKey = legacyEvidenceField
      ? stableId('reinforce_src', { batch_id: batchId, memory_id: memoryId, evidence_message_ids: normalizedIds })
      : stableId('reinforce_src', { batch_id: batchId, memory_id: memoryId, evidence_ids: normalizedIds });
    const previous = this.store.getTerminalOutcome(sourceKey);
    if (previous) {
      if (previous.outcome === 'accepted' || previous.outcome === 'duplicate') return { outcome: 'duplicate', memory_id: previous.memory_id ?? memoryId };
      return { outcome: previous.outcome, rejection_code: previous.rejection_code, reason: previous.reason };
    }
    if (!memoryId || ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return this.persistPermanent(batchId, sourceKey, 'invalid_reinforcement', 'memory_id and unique non-empty evidence_ids are required.', now);
    }
    const memory = this.store.getMemory(memoryId);
    if (!memory) return this.persistPermanent(batchId, sourceKey, 'unknown_memory', `Unknown canonical memory ID: ${memoryId}`, now);
    const messages: CanonicalMessage[] = [];
    for (const id of normalizedIds) {
      const resolved = this.trustedEvidence(id, legacyEvidenceField);
      if (resolved.ambiguous) return this.persistPermanent(batchId, sourceKey, 'ambiguous_evidence', `Legacy message_id identifies multiple trusted transcript events; use an exact evidence_id: ${id}`, now);
      if (!resolved.message) return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${id}`, now);
      messages.push(resolved.message);
    }
    const originalEvidenceIds = this.originalMemoryEvidenceIds(memory);
    if (!originalEvidenceIds) return this.markRetryable(batchId, sourceKey, `Unable to reconstruct canonical evidence provenance for memory: ${memoryId}`, now);
    const completedEvidenceIds = new Set(originalEvidenceIds);
    for (const reinforcement of this.store.listReinforcements()) {
      if (reinforcement.memory_id !== memoryId) continue;
      for (const evidenceId of reinforcement.evidence_ids) completedEvidenceIds.add(evidenceId);
    }
    const newMessages = messages.filter((message) => !completedEvidenceIds.has(memoryEvidenceId(memoryId, message)));
    if (newMessages.length === 0) return this.persistOutcomePair(batchId, sourceKey, 'duplicate', memoryId, now);
    const newMessageIds = newMessages.map(canonicalEvidenceId).sort();
    const evidence: EvidenceRecord[] = newMessages.map((message) => ({
      evidence_id: memoryEvidenceId(memoryId, message), memory_id: memoryId,
      conversation_id: message.conversation_id, message_id: message.message_id, role: message.role, quote: message.quote, captured_at: message.captured_at,
      ...evidenceProvenance(message),
    }));
    const reinforcement: ReinforcementRecord = {
      schema_version: 1, reinforcement_id: legacyEvidenceField
        ? stableId('reinforce', { memory_id: memoryId, evidence_message_ids: newMessageIds })
        : stableId('reinforce', { memory_id: memoryId, evidence_ids: newMessageIds }),
      memory_id: memoryId, batch_id: batchId, evidence_ids: evidence.map((item) => item.evidence_id),
      latest_evidence_at: newMessages.map((message) => message.captured_at).sort().at(-1)!, recorded_at: now,
    };
    const existed = this.store.listReinforcements().some((item) => item.reinforcement_id === reinforcement.reinforcement_id);
    try { this.store.appendReinforcement(reinforcement, evidence); }
    catch (error) { return this.markRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now); }
    return this.persistOutcomePair(batchId, sourceKey, existed ? 'duplicate' : 'accepted', memoryId, now);
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

    const validation = validateProposal(rawProposal, { requireChineseSemanticProse: this.requireChineseSemanticProse });
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
    const legacyEvidenceField = this.legacyEvidenceField(rawProposal);
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
    for (const evidenceId of proposal.evidence_message_ids) {
      const resolved = this.trustedEvidence(evidenceId, legacyEvidenceField);
      if (resolved.ambiguous) {
        return this.persistPermanent(batchId, sourceKey, 'ambiguous_evidence', `Legacy message_id identifies multiple trusted transcript events; use an exact evidence_id: ${evidenceId}`, now, assistantIntent);
      }
      if (!resolved.message) {
        return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${evidenceId}`, now, assistantIntent);
      }
      evidenceMessages.push(resolved.message);
    }

    const canonicalEvidenceIds = evidenceMessages.map(canonicalEvidenceId);
    const dedupeKey = stableId('dedupe', {
      subject_id: this.store.subjectId,
      kind: proposal.kind,
      summary: proposal.summary,
      participants: proposal.participants,
      evidence_message_ids: canonicalEvidenceIds,
      payload: proposal.payload,
      linked_memory_ids: proposal.linked_memory_ids ?? [],
    });

    const recoveredMemory = this.store.getMemoryBySourceKey(sourceKey);
    if (recoveredMemory) {
      const recoveredEvidence: EvidenceRecord[] = evidenceMessages.map((message) => ({
        evidence_id: memoryEvidenceId(recoveredMemory.memory_id, message),
        memory_id: recoveredMemory.memory_id,
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        role: message.role,
        quote: message.quote,
        captured_at: message.captured_at,
        ...evidenceProvenance(message),
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
      evidence_id: memoryEvidenceId(memoryId, message),
      memory_id: memoryId,
      conversation_id: message.conversation_id,
      message_id: message.message_id,
      role: message.role,
      quote: message.quote,
      captured_at: message.captured_at,
      ...evidenceProvenance(message),
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
    const entityOutcomes = this.store.listEntityOutcomes().filter((item) => item.batch_id === batchId);
    const latestBySource = new Map<string, RememberOutcome>();
    for (const outcome of outcomes) latestBySource.set(outcome.source_key, outcome);
    const latestEntityBySource = new Map<string, (typeof entityOutcomes)[number]>();
    for (const outcome of entityOutcomes) latestEntityBySource.set(outcome.source_key, outcome);

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
      || [...latestEntityBySource.values()].some((item) => item.outcome === 'retryable_failed')
      || unresolvedAssistantIntent;
    const status: BatchCompletion = retryable ? 'retryable_failure' : 'completed';
    this.store.finalizeBatch({
      batch_id: batchId,
      status,
      created_at: this.store.listBatches().find((item) => item.batch_id === batchId)?.created_at ?? now,
      finalized_at: now,
      ...(!retryable && outcomes.length === 0 && entityOutcomes.length === 0 && this.trustedAssistantIntents.size === 0 ? { detail: 'no_memory_required' as const } : {}),
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
    required: ['schema_version', 'kind', 'summary', 'participants', 'payload'],
    oneOf: [{ required: ['evidence_ids'] }, { required: ['evidence_message_ids'] }],
    properties: {
      schema_version: { type: 'integer', enum: [1], description: 'Relationship-memory proposal schema version; must be 1.' },
      kind: {
        type: 'string',
        enum: ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference'],
        description: 'Canonical relationship-memory kind. payload fields must match this kind exactly.',
      },
      summary: string,
      participants: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'assistant'] } },
      evidence_ids: { type: 'array', minItems: 1, uniqueItems: true, items: string, description: 'Exact evidence_id values copied from the trusted current-batch transcript-event evidence catalog.' },
      evidence_message_ids: { type: 'array', minItems: 1, uniqueItems: true, items: string, description: 'Legacy message_id compatibility alias. A message_id is accepted only when it uniquely identifies one trusted event in the current batch; ambiguous multi-event messages are rejected and require an exact evidence_id. Do not send both fields.' },
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
          'user_preference requires topic, preference; optional context, reason, recall_triggers.',
          'For DS-authored new writes, summary and narrative semantic prose must be Chinese; literal names, aliases, trigger tokens, code, provider names, paths, URLs, and trusted evidence stay source-faithful.',
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
          topic: string,
          preference: string,
          context: string,
          reason: string,
        },
      },
    },
  };
}

export function entitySearchToolSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } };
}

export function entityRememberToolSchema(): Record<string, unknown> {
  const string = { type: 'string', minLength: 1 };
  return {
    type: 'object', additionalProperties: false,
    required: ['schema_version', 'canonical_name', 'aliases', 'entity_type', 'description'], oneOf: [{ required: ['evidence_ids'] }, { required: ['evidence_message_ids'] }],
    properties: {
      schema_version: { type: 'integer', enum: [1] },
      canonical_name: string,
      aliases: { type: 'array', minItems: 1, uniqueItems: true, items: string, description: 'Literal names/aliases; preserve source spelling such as GPT, ChatGPT, Claude, Claude Code.' },
      entity_type: { type: 'string', enum: ['user', 'assistant', 'other'] },
      description: { type: 'string', minLength: 1, description: 'Perspective-neutral Chinese semantic description. Do not write fragile second-person identity such as 琥珀 = 你.' },
      evidence_ids: { type: 'array', minItems: 1, uniqueItems: true, items: string },
      evidence_message_ids: { type: 'array', minItems: 1, uniqueItems: true, items: string, description: 'Legacy message_id compatibility alias. A message_id is accepted only when it uniquely identifies one trusted event in the current batch; ambiguous multi-event messages are rejected and require an exact evidence_id. Do not send both fields.' },
    },
  };
}

export function memoryReinforceToolSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['memory_id'], oneOf: [{ required: ['evidence_ids'] }, { required: ['evidence_message_ids'] }], properties: {
    memory_id: { type: 'string', minLength: 1, description: 'Existing canonical memory_id selected after memory_search.' },
    evidence_ids: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Exact transcript-event evidence_id values from the trusted current-batch catalog that support the same underlying memory.' },
    evidence_message_ids: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Legacy message_id compatibility alias. A message_id is accepted only when it uniquely identifies one trusted event in the current batch; ambiguous multi-event messages are rejected and require an exact evidence_id. Do not send both fields.' },
  } };
}

export function memorySearchToolSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference'] },
      participant: { type: 'string', enum: ['user', 'assistant'] },
      trigger: { type: 'string' }, linked_memory_id: { type: 'string' }, time_start: { type: 'string' }, time_end: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  };
}
