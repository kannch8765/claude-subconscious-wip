import type {
  AssistantIntentOutcome,
  AssistantRememberIntentRecord,
  BatchCompletion,
  BatchRetryReason,
  CanonicalMessage,
  CanonicalMemoryRecord,
  EffectiveMemoryRecord,
  EvidenceRecord,
  EntityEvidenceRecord,
  EntityIdentityRecord,
  MaintenanceReviewKind,
  CanonicalMemoryKind,
  MaintenanceReviewRecord,
  MemoryRelationKind,
  MemoryKind,
  OwnerRevisionRecord,
  ParticipantRole,
  RememberOutcome,
  ReinforcementRecord,
  WorldRevisionRecord,
} from '../schema/index.js';
import {
  MEMORY_KINDS, MEMORY_KIND_DEFINITIONS, MEMORY_RELATION_KINDS, WORLD_UPDATE_KIND, cleanWorldAsOf, containsChineseSemanticProse,
  isCitableEvidenceKind, isWorldSourceEvidenceKind, normalizeEntityAlias, validateEntityIdentityProposal, validateProposal, type MemoryPayloadFieldDefinition,
} from '../schema/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';
import { materializeEffectiveMemory } from '../owner/index.js';
import { applyMemoryResolutions, currentReviewableMemoryIds, materializeCurrentMemoryView, serveWorldMemoriesForSearch } from '../resolution/index.js';
import { projectRelationReviewInbox } from '../review_inbox.js';
import { LegacyMemorySourceStore, type LegacyAssistantMemorySourceRecord } from '../legacy/index.js';
import { hybridScore, lexicalTextScore, semanticText, type SemanticRetriever } from '../retrieval/index.js';
import { linkedAssistantIntentIndex } from '../intent/provenance.js';
import { deferredIntentCounts } from '../intent/index.js';
import {
  INVALID_WORLD_RELATION, OVERLAPPING_WORLD_EVIDENCE, attachWorldUpdateViews, evidenceSourceKey, normalizeWorldFact, withoutWorldRevisions, worldAsOf, worldFamilyBlocks, worldMergeOverlap, worldRelationViolation, worldRevisionId,
  worldUpdateIndexText, worldUpdateSource,
} from '../world/index.js';

export interface SearchQuery {
  kind?: CanonicalMemoryKind;
  participant?: ParticipantRole;
  trigger?: string;
  linked_memory_id?: string;
  time_start?: string;
  time_end?: string;
  query?: string;
  limit?: number;
  excludeMemoryIds?: readonly string[];  // Runtime-only foreground context mask; never exposed in the tool schema.
}

export interface ReinforceInput {
  memory_id: string; evidence_ids?: string[]; evidence_message_ids?: string[]; assistant_intent_id?: string;
  /** world_update anchors only, and required there: the head revision (from search) this evidence confirms. */
  world_revision_id?: string;
}
export interface WorldUpdateInput { memory_id: string; fact: string; as_of?: string; evidence_ids: string[] }
export interface MaintenanceReviewInput { memory_ids: string[]; relation: MemoryRelationKind; reason: string }
export interface MaintenanceReviewResult { outcome: 'accepted' | 'duplicate' | 'rejected'; review_id?: string; reason?: string; rejection_code?: string }
export interface EntitySearchQuery { query?: string; limit?: number }
export interface EntitySearchResult extends EntityIdentityRecord { evidence_ids: string[]; evidence_message_ids: string[] }

export interface RecallQuoteSnippet {
  snippet_id: string;
  source_kind: 'transcript' | 'legacy_memory';
  evidence_id?: string;
  legacy_source_id?: string;
  role?: ParticipantRole;
  quote: string;
  captured_at: string;
}

export interface MemoryRecallResult extends EffectiveMemoryRecord {
  quote_snippets: RecallQuoteSnippet[];
}

export interface RememberResult {
  outcome: RememberOutcome['outcome'];
  memory_id?: string;
  entity_id?: string;
  rejection_code?: string;
  reason?: string;
}

/**
 * A call citing any self_note / meta_text id is rejected whole, before any write: dropping just those ids could keep a
 * claim they alone supported. The rejection leaves a linked remember intent open, so a corrected call can still use it.
 */
const NOT_CITABLE_EVIDENCE = 'not_citable_evidence';

function notCitableRejection(ids: readonly string[]): string {
  return `Cited evidence includes self_note (the agent's own scheduled prompt firing) or meta_text (runtime or system text). Neither is the user's words, so neither can be cited, and nothing was saved. Resubmit citing only user_text, assistant_text, assistant_tool_use or tool_result evidence that itself supports every claim; drop any claim only these ids supported. Not citable: ${ids.join(', ')}`;
}

/**
 * A world_update (remember, reinforce or world update) may cite only user_text and tool_result events: the agent's own
 * beliefs are never a source of world facts. Any other cited kind rejects the whole call before any write, the same way
 * as not_citable_evidence, and leaves a linked remember intent open.
 */
const UNTRUSTED_WORLD_SOURCE = 'untrusted_world_source';

function untrustedWorldRejection(ids: readonly string[]): string {
  return `A world_update can cite only user_text (the user's words) or tool_result evidence, and nothing was saved. Resubmit citing only evidence of those kinds that itself supports the fact. Not allowed here: ${ids.join(', ')}`;
}

const NOT_WORLD_UPDATE = 'not_world_update';
const WORLD_FACT_DUPLICATE_REASON = 'The fact equals the current head of this world_update; nothing was written. Use memory_reinforce to confirm a fact that still holds.';

function worldReplayDuplicate(ids: readonly string[]): string {
  return `These cited transcript blocks already back a revision or a confirmation of this world_update, so nothing was written: ${ids.join(', ')}. Cite only evidence that newly states the change.`;
}

/** A world_update reinforcement confirmed a revision that is no longer the head (another write landed after the search). */
const STALE_WORLD_REVISION = 'stale_world_revision';

/** A world_update call cited blocks already behind a write of the family together with blocks that are new. */
const REUSED_WORLD_EVIDENCE = 'reused_world_evidence';

function reusedWorldEvidenceRejection(ids: readonly string[]): string {
  return `Some cited transcript blocks already back a revision or a confirmation of this world_update, so nothing was saved: ${ids.join(', ')}. Resubmit citing only evidence that newly supports the fact.`;
}

/** The transcript-block identity reinforce dedupe uses; message-level evidence falls back to its evidence id. */
function messageBlockKey(message: CanonicalMessage): string {
  return evidenceSourceKey(message) ?? canonicalEvidenceId(message);
}

/** A world_update card reports only the confirmations of its head, from every merged anchor. */
function headConfirmations(memory: EffectiveMemoryRecord, byMemory: ReadonlyMap<string, ReinforcementRecord[]>): ReinforcementRecord[] {
  const head = memory.world_update?.head.revision_id;
  if (!head) return [];
  return (memory.resolution_source_memory_ids ?? [memory.memory_id])
    .flatMap((memoryId) => byMemory.get(memoryId) ?? [])
    .filter((item) => item.world_revision_id === head);
}

/** Rejections that refuse the cited evidence itself; their replay never resolves a linked remember intent. */
const EVIDENCE_REFUSAL_CODES: ReadonlySet<string> = new Set([NOT_CITABLE_EVIDENCE, UNTRUSTED_WORLD_SOURCE]);

export type MemoryRememberToolName = `memory_remember_${CanonicalMemoryKind}`;

export function memoryRememberToolName(kind: CanonicalMemoryKind): MemoryRememberToolName {
  return `memory_remember_${kind}`;
}

export const MEMORY_REMEMBER_TOOL_NAMES = MEMORY_KINDS.map(memoryRememberToolName) as readonly MemoryRememberToolName[];

export const MEMORY_MAINTENANCE_REVIEW_TOOL_NAMES = ['suggest_memory_relation'] as const;

/**
 * A trusted assistant intent holds its batch (and the transcript cursor) open for at most this many
 * completed observer turns. After that it is released as `deferred`, so one ignored intent cannot
 * freeze a whole session; the durable intent stays queryable for a later replay.
 */
export const MAX_UNRESOLVED_INTENT_TURNS = 3;
export type MemoryMaintenanceReviewToolName = (typeof MEMORY_MAINTENANCE_REVIEW_TOOL_NAMES)[number];

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
  private readonly retryableAttempts = new Set<string>();

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

  private currentAttempt(batchId: string) {
    const latest = [...this.store.listBatches()].reverse().find((item) => item.batch_id === batchId);
    return latest?.status === 'pending' ? latest : undefined;
  }

  private attemptFields(batchId: string): { attempt_id?: string } {
    const attemptId = this.currentAttempt(batchId)?.attempt_id;
    return attemptId ? { attempt_id: attemptId } : {};
  }

  private attemptKey(batchId: string): string {
    return this.currentAttempt(batchId)?.attempt_id ?? `legacy:${batchId}`;
  }

  /**
   * Holds the current attempt for an owned-work failure that produced no
   * outcome record (e.g. an exception escaping a mutation tool).
   */
  markAttemptRetryable(batchId: string): void {
    this.retryableAttempts.add(this.attemptKey(batchId));
  }

  private ensureRetryAttempt(batchId: string, now: string): void {
    const latest = [...this.store.listBatches()].reverse().find((item) => item.batch_id === batchId);
    if (latest?.status === 'retryable_failure') this.store.beginBatch(batchId, now);
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

  private splitSourceText(text: string): string[] {
    const pieces: string[] = [];
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sentences = trimmed.match(/[^。！？!?]+[。！？!?]+[」』”’]?|[^。！？!?]+$/gu) ?? [trimmed];
      for (const sentence of sentences) {
        const source = sentence.trim();
        if (!source) continue;
        // Preserve exact source text while bounding one candidate. Long prose/code
        // becomes several exact excerpts rather than one multi-kilobyte whisper.
        const codePoints = [...source];
        for (let offset = 0; offset < codePoints.length; offset += 600) {
          pieces.push(codePoints.slice(offset, offset + 600).join(''));
        }
      }
    }
    return pieces;
  }

  private quoteSnippetsForEvidence(item: EvidenceRecord): RecallQuoteSnippet[] {
    if (item.event_kind && item.event_kind !== 'user_text' && item.event_kind !== 'assistant_text') return [];
    return this.splitSourceText(item.quote).map((quote, index) => ({
      snippet_id: stableId('quote_snippet', { evidence_id: item.evidence_id, index, quote }),
      source_kind: 'transcript' as const,
      evidence_id: item.evidence_id,
      role: item.role,
      quote,
      captured_at: item.captured_at,
    }));
  }

  private quoteSnippetsForLegacySource(source: LegacyAssistantMemorySourceRecord): RecallQuoteSnippet[] {
    const text = source.body_text.trim() || source.frontmatter.name;
    return this.splitSourceText(text).map((quote, index) => ({
      snippet_id: stableId('legacy_quote_snippet', { legacy_source_id: source.legacy_source_id, index, quote }),
      source_kind: 'legacy_memory' as const,
      legacy_source_id: source.legacy_source_id,
      quote,
      captured_at: source.created_at_utc,
    }));
  }

  private boundRecallSnippets(items: readonly RecallQuoteSnippet[], limit = 8): RecallQuoteSnippet[] {
    const unique = [...new Map(items.map((item) => [item.snippet_id, item])).values()];
    const bounded = Math.max(1, Math.min(limit, 12));
    return unique.length <= bounded
      ? unique
      : [...unique.slice(0, Math.ceil(bounded / 2)), ...unique.slice(-Math.floor(bounded / 2))];
  }

  private recallQuoteSnippets(memoryId: string, evidence: readonly EvidenceRecord[], limit = 8): RecallQuoteSnippet[] {
    const eligible = evidence
      .filter((item) => item.memory_id === memoryId)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.evidence_id.localeCompare(b.evidence_id))
      .flatMap((item) => this.quoteSnippetsForEvidence(item));
    return this.boundRecallSnippets(eligible, limit);
  }

  private legacyQuoteSnippetsForMemories(memoryIds: readonly string[], limit = 8): Map<string, RecallQuoteSnippet[]> {
    if (memoryIds.length === 0) return new Map();
    const wanted = new Set(memoryIds);
    const legacyStore = new LegacyMemorySourceStore(this.store.rootDir);
    const provenance = legacyStore.listProvenance().filter((item) => wanted.has(item.canonical_memory_id));
    if (provenance.length === 0) return new Map();
    const sourceIds = new Set(provenance.map((item) => item.legacy_source_id));
    const sources = new Map(legacyStore.listSources()
      .filter((source) => sourceIds.has(source.legacy_source_id))
      .map((source) => [source.legacy_source_id, source]));
    const byMemory = new Map<string, RecallQuoteSnippet[]>();
    for (const memoryId of memoryIds) {
      const snippets = provenance
        .filter((item) => item.canonical_memory_id === memoryId)
        .map((item) => sources.get(item.legacy_source_id))
        .filter((source): source is LegacyAssistantMemorySourceRecord => Boolean(source))
        .sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc) || a.legacy_source_id.localeCompare(b.legacy_source_id))
        .flatMap((source) => this.quoteSnippetsForLegacySource(source));
      if (snippets.length > 0) byMemory.set(memoryId, this.boundRecallSnippets(snippets, limit));
    }
    return byMemory;
  }

  private attachRecallEvidence(memories: EffectiveMemoryRecord[]): MemoryRecallResult[] {
    const evidenceMemoryIds = [...new Set(memories.flatMap((memory) => memory.resolution_source_memory_ids ?? [memory.memory_id]))];
    const evidence = this.store.listEvidenceForMemoryIds(evidenceMemoryIds);
    const transcript = new Map(memories.map((memory) => {
      const sourceIds = memory.resolution_source_memory_ids ?? [memory.memory_id];
      // A world_update quotes only what supports its head, so an older fact never comes back through a quote.
      const headEvidence = memory.world_update ? new Set(memory.world_update.head_evidence_ids) : undefined;
      const scoped = headEvidence ? evidence.filter((item) => headEvidence.has(item.evidence_id)) : evidence;
      const snippets = sourceIds.flatMap((memoryId) => this.recallQuoteSnippets(memoryId, scoped, 12));
      return [memory.memory_id, this.boundRecallSnippets(snippets, 8)] as const;
    }));
    const missingSources = [...new Set(memories
      .filter((memory) => (transcript.get(memory.memory_id)?.length ?? 0) === 0)
      .flatMap((memory) => memory.resolution_source_memory_ids ?? [memory.memory_id]))];
    const legacy = this.legacyQuoteSnippetsForMemories(missingSources, 12);
    return memories.map((memory) => {
      const sourceIds = memory.resolution_source_memory_ids ?? [memory.memory_id];
      const legacySnippets = this.boundRecallSnippets(sourceIds.flatMap((memoryId) => legacy.get(memoryId) ?? []), 8);
      return {
        ...memory,
        quote_snippets: transcript.get(memory.memory_id)?.length ? transcript.get(memory.memory_id)! : legacySnippets,
      };
    });
  }

  async memorySearchRecallHybridWithEvidence(query: SearchQuery, signal?: AbortSignal): Promise<MemoryRecallResult[]> {
    return this.attachRecallEvidence(await this.memorySearchRecallHybrid(query, signal));
  }

  async memorySearchMaintenanceCurrentWithEvidence(query: SearchQuery): Promise<MemoryRecallResult[]> {
    // Async maintenance shares the reviewed current view with foreground recall,
    // but still refreshes vectors for new writes, as the old maintenance search did.
    return this.attachRecallEvidence(await this.memorySearchRecallHybrid(query, undefined, true));
  }

  async memorySearchHybridWithEvidence(query: SearchQuery): Promise<MemoryRecallResult[]> {
    return this.attachRecallEvidence(await this.memorySearchHybrid(query));
  }


  private effectiveMemories(): EffectiveMemoryRecord[] {
    // Materialize genesis + owner revisions once. Maintenance search uses this
    // raw effective view so owner review can still inspect every canonical memory.
    const revisionsByMemory = new Map<string, OwnerRevisionRecord[]>();
    for (const revision of this.store.listOwnerRevisions()) {
      const bucket = revisionsByMemory.get(revision.memory_id) ?? [];
      bucket.push(revision);
      revisionsByMemory.set(revision.memory_id, bucket);
    }
    return this.store.listMemories().map((genesis) =>
      materializeEffectiveMemory(genesis, revisionsByMemory.get(genesis.memory_id) ?? []),
    );
  }

  private linkedIntentSemanticByMemory(): Map<string, Array<{ memory: string; feel: string }>> {
    return new Map([...linkedAssistantIntentIndex(this.store)].map(([memoryId, intents]) => [
      memoryId, intents.map((intent) => ({ memory: intent.memory.text, feel: intent.feel.text })),
    ]));
  }

  private resolvedRecallMemories(reinforcements?: readonly ReinforcementRecord[]): EffectiveMemoryRecord[] {
    return serveWorldMemoriesForSearch(this.store, applyMemoryResolutions(this.effectiveMemories(), this.store.listActiveMemoryResolutions()), {
      resolved: true, ...(reinforcements ? { reinforcements } : {}),
    });
  }

  /** Index text: topic + head fact for a world_update, unchanged for the other kinds. */
  private memoryDocumentText(memory: EffectiveMemoryRecord, linkedIntents: Array<{ memory: string; feel: string }>): string {
    if (memory.kind === WORLD_UPDATE_KIND) return worldUpdateIndexText(memory);
    return semanticText(memory.kind, memory.summary, memory.participants, memory.payload, memory.resolution_context ?? '', linkedIntents);
  }

  /**
   * The current effective view of the world_update containing this anchor (after any owner same_meaning merge), with its
   * whole revision chain, for the timeline renderer. Search and recall results carry the head only.
   */
  currentWorldUpdate(memoryId: string): EffectiveMemoryRecord | undefined {
    const current = this.resolvedRecallMemories().find((memory) =>
      memory.kind === WORLD_UPDATE_KIND && (memory.resolution_source_memory_ids ?? [memory.memory_id]).includes(memoryId));
    if (current) return current;
    const genesis = this.store.getMemory(memoryId);
    if (genesis?.kind !== WORLD_UPDATE_KIND) return undefined;
    const effective = this.effectiveMemories().find((memory) => memory.memory_id === memoryId);
    return effective ? attachWorldUpdateViews(this.store, [effective])[0] : undefined;
  }

  /**
   * The transcript blocks behind every write of a world_update family: each revision and each confirmation, on every
   * merged anchor. Only written rows count, so a half-committed revision or reinforcement is still repaired.
   */
  private worldFamilyUsedBlocks(memoryId: string, family: EffectiveMemoryRecord | undefined): Set<string> {
    const anchorIds = new Set([memoryId, ...(family?.resolution_source_memory_ids ?? (family ? [family.memory_id] : []))]);
    return new Set(worldFamilyBlocks(this.store, [...anchorIds]).keys());
  }

  /** Embeds missing document vectors. `onlyMemoryIds` limits it to those memories (an offline run embeds just the
   * memories it created); other index entries are never removed. */
  async prepareCurrentMemorySemanticIndex(onlyMemoryIds?: ReadonlySet<string>): Promise<void> {
    if (!this.semanticRetriever?.prepare) return;
    const intentsByMemory = this.linkedIntentSemanticByMemory();
    const documents = this.resolvedRecallMemories()
      .filter((memory) => memory.status === 'active')
      .filter((memory) => !onlyMemoryIds || onlyMemoryIds.has(memory.memory_id))
      .map((memory) => {
        const sourceIds = memory.resolution_source_memory_ids ?? [memory.memory_id];
        const linkedIntents = sourceIds.flatMap((memoryId) => intentsByMemory.get(memoryId) ?? []);
        return {
          id: `memory:${memory.memory_id}`,
          text: this.memoryDocumentText(memory, linkedIntents),
        };
      });
    await this.semanticRetriever.prepare(documents);
  }

  // Six ranking points is intentionally small compared with a complete lexical match.
  // This never introduces a candidate excluded by the topical lexical/semantic filter.
  readonly ownerRememberRecallBoost = 6;

  async memorySearchRecallHybrid(query: SearchQuery, signal?: AbortSignal, refreshIndex = false): Promise<EffectiveMemoryRecord[]> {
    const semanticQuery = query.query?.trim();
    const trigger = query.trigger?.trim().toLowerCase();
    const limit = boundedSearchLimit(query.limit);
    const excluded = new Set(query.excludeMemoryIds ?? []);

    // Preserve the existing memory_search result/search semantics without the
    // hot path's old per-memory JSONL rescans. Materialize each supporting file
    // once, then join by memory id in memory.
    const allReinforcements = this.store.listReinforcements();
    const reinforcementsByMemory = new Map<string, ReinforcementRecord[]>();
    for (const reinforcement of allReinforcements) {
      const bucket = reinforcementsByMemory.get(reinforcement.memory_id) ?? [];
      bucket.push(reinforcement);
      reinforcementsByMemory.set(reinforcement.memory_id, bucket);
    }
    const linkedIntentsByMemory = this.linkedIntentSemanticByMemory();

    const candidates = this.resolvedRecallMemories(allReinforcements).map((memory) => {
      const sourceIds = memory.resolution_source_memory_ids ?? [memory.memory_id];
      const reinforcements = memory.kind === WORLD_UPDATE_KIND
        ? headConfirmations(memory, reinforcementsByMemory)
        : sourceIds.flatMap((memoryId) => reinforcementsByMemory.get(memoryId) ?? []);
      const evidenceIds = [...new Set(reinforcements.flatMap((item) => item.evidence_ids))];
      const latest = reinforcements.map((item) => item.latest_evidence_at).sort().at(-1);
      const enriched: EffectiveMemoryRecord = {
        ...memory,
        ...(reinforcements.length ? {
          reinforcement_count: reinforcements.length,
          reinforcement_evidence_count: evidenceIds.length,
          reinforcement_evidence_ids: evidenceIds.slice(-20),
          latest_reinforcement_at: latest,
        } : {}),
      };
      const linkedIntents = sourceIds.flatMap((memoryId) => linkedIntentsByMemory.get(memoryId) ?? []);
      return { memory: enriched, linkedIntents };
    }).filter(({ memory, linkedIntents }) => {
      const foregroundIds = memory.resolution_source_memory_ids ?? [memory.memory_id];
      if (memory.status !== 'active' || foregroundIds.some((memoryId) => excluded.has(memoryId))) return false;
      if (query.kind && memory.kind !== query.kind) return false;
      if (query.participant && !memory.participants.includes(query.participant)) return false;
      if (query.linked_memory_id && !memory.linked_memory_ids?.includes(query.linked_memory_id)) return false;
      if (query.time_start && memory.observed_at < query.time_start) return false;
      if (query.time_end && memory.observed_at > query.time_end) return false;
      const haystack = stableJson({ summary: memory.summary, payload: memory.payload, context: memory.resolution_context, assistant_intents: linkedIntents }).toLowerCase();
      if (trigger && !haystack.includes(trigger)) return false;
      return true;
    });
    if (!semanticQuery) return candidates.slice(0, limit).map((item) => withoutWorldRevisions(item.memory));

    const documents = candidates.map(({ memory, linkedIntents }) => ({
      id: `memory:${memory.memory_id}`,
      text: this.memoryDocumentText(memory, linkedIntents),
    }));
    let semantic = new Map<string, number>();
    if (refreshIndex && this.semanticRetriever?.rank) {
      try { semantic = await this.semanticRetriever.rank(documents, semanticQuery); }
      catch { semantic = new Map(); }
    } else if (this.semanticRetriever?.rankExisting) {
      try { semantic = await this.semanticRetriever.rankExisting(documents, semanticQuery, signal); }
      catch { semantic = new Map(); }
    }
    const scored = candidates.map(({ memory }, index) => {
      const lexical = lexicalTextScore(documents[index].text, semanticQuery);
      const semanticScore = semantic.get(documents[index].id);
      const ownerRemembered = candidates[index].linkedIntents.length > 0;
      return { memory, lexical, semantic: semanticScore,
        score: hybridScore(lexical, semanticScore) + (ownerRemembered ? this.ownerRememberRecallBoost : 0) };
    }).filter((item) => item.semantic !== undefined || item.lexical > 0);
    return scored
      .sort((a, b) => b.score - a.score || b.memory.observed_at.localeCompare(a.memory.observed_at))
      .slice(0, limit)
      .map((item) => withoutWorldRevisions(item.memory));
  }

  private materializedMemorySearchRows(): Array<{
    memory: EffectiveMemoryRecord;
    linkedIntents: Array<{ memory: string; feel: string }>;
  }> {
    const allReinforcements = this.store.listReinforcements();
    const reinforcementsByMemory = new Map<string, ReinforcementRecord[]>();
    for (const reinforcement of allReinforcements) {
      const bucket = reinforcementsByMemory.get(reinforcement.memory_id) ?? [];
      bucket.push(reinforcement);
      reinforcementsByMemory.set(reinforcement.memory_id, bucket);
    }

    // getAssistantIntent() historically returns the first durable record for an
    // intent id. Preserve that exact behavior while avoiding one JSONL scan per
    // memory during search.
    const intentsById = new Map<string, AssistantRememberIntentRecord>();
    for (const intent of this.store.listAssistantIntents()) {
      if (!intentsById.has(intent.intent_id)) intentsById.set(intent.intent_id, intent);
    }
    const latestOutcomeByIntent = new Map<string, AssistantIntentOutcome>();
    for (const outcome of this.store.listAssistantIntentOutcomes()) latestOutcomeByIntent.set(outcome.intent_id, outcome);
    const linkedIntentsByMemory = new Map<string, AssistantRememberIntentRecord[]>();
    for (const [intentId, outcome] of latestOutcomeByIntent) {
      if ((outcome.outcome !== 'accepted' && outcome.outcome !== 'duplicate') || !outcome.memory_id) continue;
      const intent = intentsById.get(intentId);
      if (!intent) continue;
      const bucket = linkedIntentsByMemory.get(outcome.memory_id) ?? [];
      bucket.push(intent);
      linkedIntentsByMemory.set(outcome.memory_id, bucket);
    }

    // Raw for the five relationship kinds (owner review inspects every canonical memory); world_update is served resolved.
    const effective = this.effectiveMemories();
    return serveWorldMemoriesForSearch(this.store, effective, { allEffective: effective, reinforcements: allReinforcements }).map((memory) => {
      const reinforcements = memory.kind === WORLD_UPDATE_KIND
        ? headConfirmations(memory, reinforcementsByMemory)
        : reinforcementsByMemory.get(memory.memory_id) ?? [];
      const evidenceIds = [...new Set(reinforcements.flatMap((item) => item.evidence_ids))];
      const latest = reinforcements.map((item) => item.latest_evidence_at).sort().at(-1);
      const enriched: EffectiveMemoryRecord = {
        ...memory,
        ...(reinforcements.length ? {
          reinforcement_count: reinforcements.length,
          reinforcement_evidence_count: evidenceIds.length,
          reinforcement_evidence_ids: evidenceIds.slice(-20),
          latest_reinforcement_at: latest,
        } : {}),
      };
      return {
        memory: enriched,
        linkedIntents: (linkedIntentsByMemory.get(memory.memory_id) ?? []).map((intent) => ({
          memory: intent.memory.text,
          feel: intent.feel.text,
        })),
      };
    });
  }

  private filterMemorySearchRows(
    rows: Array<{ memory: EffectiveMemoryRecord; linkedIntents: Array<{ memory: string; feel: string }> }>,
    query: SearchQuery,
    includeQuery = true,
  ) {
    const needle = includeQuery ? query.query?.trim().toLowerCase() : undefined;
    const trigger = query.trigger?.trim().toLowerCase();
    const excluded = new Set(query.excludeMemoryIds ?? []);
    return rows.filter(({ memory, linkedIntents }) => {
      if (memory.status !== 'active' || excluded.has(memory.memory_id)) return false;
      if (query.kind && memory.kind !== query.kind) return false;
      if (query.participant && !memory.participants.includes(query.participant)) return false;
      if (query.linked_memory_id && !memory.linked_memory_ids?.includes(query.linked_memory_id)) return false;
      if (query.time_start && memory.observed_at < query.time_start) return false;
      if (query.time_end && memory.observed_at > query.time_end) return false;
      const haystack = stableJson({ summary: memory.summary, payload: memory.payload, assistant_intents: linkedIntents }).toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
      if (trigger && !haystack.includes(trigger)) return false;
      return true;
    });
  }

  memorySearch(query: SearchQuery): EffectiveMemoryRecord[] {
    return this.filterMemorySearchRows(this.materializedMemorySearchRows(), query).map(({ memory }) => withoutWorldRevisions(memory));
  }

  async memorySearchHybrid(query: SearchQuery): Promise<EffectiveMemoryRecord[]> {
    const semanticQuery = query.query?.trim();
    const limit = boundedSearchLimit(query.limit);
    const rows = this.materializedMemorySearchRows();
    if (!this.semanticRetriever || !semanticQuery) {
      return this.filterMemorySearchRows(rows, query).slice(0, limit).map(({ memory }) => withoutWorldRevisions(memory));
    }
    const candidates = this.filterMemorySearchRows(rows, query, false);
    const documents = candidates.map(({ memory, linkedIntents }) => ({
      id: `memory:${memory.memory_id}`,
      text: memory.kind === WORLD_UPDATE_KIND
        ? worldUpdateIndexText(memory)
        : semanticText(memory.kind, memory.summary, memory.participants, memory.payload, linkedIntents),
    }));
    try {
      const semantic = await this.semanticRetriever.rank(documents, semanticQuery);
      return candidates.map(({ memory }, index) => ({
        memory,
        score: hybridScore(lexicalTextScore(documents[index].text, semanticQuery), semantic.get(documents[index].id)),
      })).sort((a, b) => b.score - a.score || b.memory.observed_at.localeCompare(a.memory.observed_at))
        .slice(0, limit)
        .map((item) => withoutWorldRevisions(item.memory));
    } catch {
      return this.filterMemorySearchRows(rows, query).slice(0, limit).map(({ memory }) => withoutWorldRevisions(memory));
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

  async entitySearchRecallHybrid(query: EntitySearchQuery = {}): Promise<EntitySearchResult[]> {
    const semanticQuery = query.query?.trim();
    const limit = boundedSearchLimit(query.limit);
    if (!semanticQuery) return this.entitySearch(query).slice(0, limit);
    const candidates = this.entitySearch({});
    const documents = candidates.map((entity) => ({
      id: `entity:${entity.entity_id}`,
      text: semanticText(entity.canonical_name, entity.aliases, entity.entity_type, entity.description),
    }));
    let semantic = new Map<string, number>();
    if (this.semanticRetriever?.rankExisting) {
      try { semantic = await this.semanticRetriever.rankExisting(documents, semanticQuery); }
      catch { semantic = new Map(); }
    }
    const scored = candidates.map((entity, index) => {
      const lexical = lexicalTextScore(documents[index].text, semanticQuery);
      const semanticScore = semantic.get(documents[index].id);
      return { entity, lexical, semantic: semanticScore, score: hybridScore(lexical, semanticScore) };
    }).filter((item) => item.semantic !== undefined || item.lexical > 0);
    if (scored.length === 0) return this.entitySearch(query).slice(0, limit);
    return scored
      .sort((a, b) => b.score - a.score || b.entity.observed_at.localeCompare(a.entity.observed_at))
      .slice(0, limit)
      .map((item) => item.entity);
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
    this.retryableAttempts.add(this.attemptKey(batchId));
    try { this.store.appendEntityOutcome({ batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome: 'retryable_failed', reason, recorded_at: now }); } catch { }
    return { outcome: 'retryable_failed', reason };
  }

  private entityPermanent(batchId: string, sourceKey: string, code: string, reason: string, now: string): RememberResult {
    try {
      this.store.appendEntityOutcome({ batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome: 'permanently_rejected', rejection_code: code, reason, recorded_at: now });
      return { outcome: 'permanently_rejected', rejection_code: code, reason };
    } catch {
      return this.entityRetryable(batchId, sourceKey, 'Failed to durably record entity rejection.', now);
    }
  }

  private entityOutcome(batchId: string, sourceKey: string, outcome: 'accepted' | 'duplicate', entityId: string, now: string): RememberResult {
    try {
      this.store.appendEntityOutcome({ batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome, entity_id: entityId, recorded_at: now });
      return { outcome, entity_id: entityId };
    } catch (error) {
      return this.entityRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now);
    }
  }

  rememberEntity(batchId: string, rawProposal: unknown): RememberResult {
    const now = this.now();
    this.ensureRetryAttempt(batchId, now);
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
    const skipped: string[] = [];
    for (const evidenceId of proposal.evidence_message_ids) {
      const resolved = this.trustedEvidence(evidenceId, legacyEvidenceField);
      if (resolved.ambiguous) return this.entityPermanent(batchId, sourceKey, 'ambiguous_evidence', `Legacy message_id identifies multiple trusted transcript events; use an exact evidence_id: ${evidenceId}`, now);
      if (!resolved.message) return this.entityPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${evidenceId}`, now);
      if (isCitableEvidenceKind(resolved.message.event_kind)) evidenceMessages.push(resolved.message);
      else skipped.push(evidenceId);
    }
    if (skipped.length > 0) return this.entityPermanent(batchId, sourceKey, NOT_CITABLE_EVIDENCE, notCitableRejection(skipped), now);
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
    this.retryableAttempts.add(this.attemptKey(batchId));
    try {
      this.store.appendOutcome({ batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome: 'retryable_failed', reason, recorded_at: now });
    } catch { /* the in-memory batch marker still prevents cursor advance */ }
    if (intent) {
      try {
        this.store.appendAssistantIntentOutcome({ intent_id: intent.intent_id, batch_id: batchId, ...this.attemptFields(batchId), outcome: 'retryable_failed', reason, recorded_at: now });
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
    intentOutcome: 'accepted' | 'duplicate' = outcome,
  ): RememberResult {
    try {
      this.store.appendOutcome({ batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome, memory_id: memoryId, recorded_at: now });
      if (intent) {
        this.store.appendAssistantIntentOutcome({
          intent_id: intent.intent_id,
          batch_id: batchId,
          ...this.attemptFields(batchId),
          outcome: intentOutcome,
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
      this.store.appendOutcome({ batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome: 'permanently_rejected', rejection_code: code, reason, recorded_at: now });
      if (intent) {
        this.store.appendAssistantIntentOutcome({
          intent_id: intent.intent_id,
          batch_id: batchId,
          ...this.attemptFields(batchId),
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

  private originalMemoryEvidenceIds(memory: CanonicalMemoryRecord, evidence: readonly EvidenceRecord[]): Set<string> | undefined {
    const legacyStore = new LegacyMemorySourceStore(this.store.rootDir);
    const legacyCreated = legacyStore.listProvenance().some((item) =>
      item.canonical_memory_id === memory.memory_id && item.disposition === 'created'
    );
    if (legacyCreated) return new Set();

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

  suggestMaintenanceReview(
    batchId: string,
    kind: Extract<MaintenanceReviewKind, 'relation'>,
    input: MaintenanceReviewInput,
  ): MaintenanceReviewResult {
    const rawIds = Array.isArray(input?.memory_ids)
      ? input.memory_ids.map((value) => typeof value === 'string' ? value.trim() : '')
      : [];
    const relation = typeof input?.relation === 'string' ? input.relation.trim() as MemoryRelationKind : undefined;
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (
      rawIds.length < 2 || rawIds.length > 8
      || rawIds.some((value) => !value)
      || new Set(rawIds).size !== rawIds.length
      || !relation || !MEMORY_RELATION_KINDS.includes(relation)
      || !reason || reason.length > 1_000
    ) {
      return { outcome: 'rejected', reason: 'maintenance review requires 2-8 unique memory_ids, a valid relation, and a non-empty reason up to 1000 characters' };
    }
    const memoryIds = [...rawIds].sort();
    const kindById = new Map(this.store.listMemories().map((memory) => [memory.memory_id, memory.kind] as const));
    for (const memoryId of memoryIds) {
      if (!kindById.has(memoryId)) return { outcome: 'rejected', reason: `unknown canonical memory ID: ${memoryId}` };
    }
    // Suggestions must refer to the *current* memories the owner can review.
    // Merged/historical/conflicted/inactive genesis remains available as evidence,
    // but is no longer a separate maintenance comparison candidate.
    const currentIds = currentReviewableMemoryIds(this.store);
    const stale = memoryIds.find((memoryId) => !currentIds.has(memoryId));
    if (stale) return { outcome: 'rejected', reason: `memory is not current and active: ${stale}` };
    // Checked before the review-id lookups: a review id does not include the relation.
    const worldViolation = worldRelationViolation(memoryIds.map((memoryId) => kindById.get(memoryId)!), relation);
    if (worldViolation) return { outcome: 'rejected', rejection_code: INVALID_WORLD_RELATION, reason: worldViolation };
    if (relation === 'same_meaning' && memoryIds.every((memoryId) => kindById.get(memoryId) === WORLD_UPDATE_KIND)) {
      const shared = worldMergeOverlap(this.store, memoryIds.map((memoryId) =>
        this.currentWorldUpdate(memoryId)?.resolution_source_memory_ids ?? [memoryId]));
      if (shared.length > 0) {
        return {
          outcome: 'rejected',
          rejection_code: OVERLAPPING_WORLD_EVIDENCE,
          reason: `These world_update memories share transcript evidence (${shared.join(', ')}), so one is likely a replay of the other and a merge would cite a block twice. Suggest related instead: the owner can then review the pair and deactivate the duplicate.`,
        };
      }
    }
    const reviewId = stableId('maintenance_review', {
      subject_id: this.store.subjectId,
      kind,
      memory_ids: memoryIds,
    });
    const previous = this.store.getMaintenanceReview(reviewId);
    if (previous) return { outcome: 'duplicate', review_id: reviewId };
    const priorApproval = this.store.listActiveMemoryResolutions().find((item) =>
      item.relation === relation && item.memory_ids.length === memoryIds.length
      && item.memory_ids.every((id) => memoryIds.includes(id)));
    if (priorApproval) return { outcome: 'duplicate', review_id: priorApproval.review_id };
    // Earlier A+B+C can now be an A+C pending review after an owner merge.
    // The Agent sees A+C in its effective workspace; do not queue it twice.
    const pending = projectRelationReviewInbox(this.store, materializeCurrentMemoryView(this.store)).reviews;
    const alreadyProposed = pending.find((review) => review.origin === 'maintenance_suggest'
      && review.suggested_relation === relation && review.memory_ids.length === memoryIds.length
      && review.memory_ids.every((id) => memoryIds.includes(id)));
    if (alreadyProposed) return { outcome: 'duplicate', review_id: alreadyProposed.review_id };
    const now = this.now();
    const record: MaintenanceReviewRecord = {
      schema_version: 1,
      review_id: reviewId,
      subject_id: this.store.subjectId,
      kind,
      suggested_relation: relation,
      memory_ids: memoryIds,
      reason,
      status: 'pending',
      created_at: now,
      recorded_at: now,
      batch_id: batchId,
    };
    const appended = this.store.appendMaintenanceReview(record);
    return { outcome: appended ? 'accepted' : 'duplicate', review_id: reviewId };
  }

  /**
   * The intent-link check and the writes that publish the link run under one canonical mutation boundary (reentrant;
   * the live worker already holds it around each mutation tool), so two workers can't both see "unlinked" and link
   * one intent to two memories.
   */
  reinforce(batchId: string, input: ReinforceInput): RememberResult {
    return this.store.withMutationBoundary(() => this.reinforceInBoundary(batchId, input));
  }

  private reinforceInBoundary(batchId: string, input: ReinforceInput): RememberResult {
    const now = this.now();
    this.ensureRetryAttempt(batchId, now);
    const memoryId = typeof input?.memory_id === 'string' ? input.memory_id.trim() : '';
    const rawIds = input?.evidence_ids ?? input?.evidence_message_ids;
    const ids = Array.isArray(rawIds) ? rawIds.map((id) => typeof id === 'string' ? id.trim() : '') : [];
    const normalizedIds = [...ids].sort();
    const legacyEvidenceField = input?.evidence_ids === undefined && input?.evidence_message_ids !== undefined;
    // An intent id is part of the source only when given, so reinforcement keys without one stay as they were.
    const intentId = rawAssistantIntentId(input);
    const intentKey = intentId ? { assistant_intent_id: intentId } : {};
    // Likewise a world revision id is part of the source only when given.
    const worldRevisionId = typeof input?.world_revision_id === 'string' ? input.world_revision_id.trim() : undefined;
    const worldKey = input?.world_revision_id === undefined ? {} : { world_revision_id: input.world_revision_id };
    const sourceKey = legacyEvidenceField
      ? stableId('reinforce_src', { batch_id: batchId, memory_id: memoryId, evidence_message_ids: normalizedIds, ...intentKey, ...worldKey })
      : stableId('reinforce_src', { batch_id: batchId, memory_id: memoryId, evidence_ids: normalizedIds, ...intentKey, ...worldKey });
    // Reinforcing with an intent says the intent's moment is already remembered: the intent links to this memory as a
    // `duplicate`. Only a write or retryable failure carries the intent; a rejected reinforcement leaves it unresolved
    // (the turn budget still applies), so a wrong memory_id cannot consume it.
    const intent = this.trustedIntent(intentId);
    // Reinforce can point at any stored memory, so it must never move an intent (and its feel and protection) off the
    // memory it is already linked to, on a first call or on a replayed one.
    const linked = intent ? this.store.getTerminalAssistantIntentOutcome(intent.intent_id) : undefined;
    const linkedElsewhere = (target: string): RememberResult | undefined => (linked?.memory_id && linked.memory_id !== target
      ? { outcome: 'permanently_rejected', rejection_code: 'intent_already_linked', reason: `Assistant intent ${intent!.intent_id} is already linked to memory ${linked.memory_id}.` }
      : undefined);
    const previous = this.store.getTerminalOutcome(sourceKey);
    if (previous) {
      if (previous.outcome === 'accepted' || previous.outcome === 'duplicate') {
        const previousMemoryId = previous.memory_id ?? memoryId;
        if (!intent) return { outcome: 'duplicate', memory_id: previousMemoryId };
        // The reinforcement itself already stands; only the intent link is refused, and nothing new is recorded.
        const refused = linkedElsewhere(previousMemoryId);
        if (refused) return refused;
        const repaired = this.persistOutcomePair(batchId, sourceKey, previous.outcome, previousMemoryId, now, intent, 'duplicate');
        return repaired.outcome === 'retryable_failed' ? repaired : { outcome: 'duplicate', memory_id: previousMemoryId };
      }
      return { outcome: previous.outcome, rejection_code: previous.rejection_code, reason: previous.reason };
    }
    if (intentId && !intent) {
      return this.persistPermanent(batchId, sourceKey, 'unknown_assistant_intent', `Assistant intent is not present in the trusted current-batch catalog: ${intentId}`, now);
    }
    const refused = linkedElsewhere(memoryId);
    if (refused) return this.persistPermanent(batchId, sourceKey, refused.rejection_code!, refused.reason!, now);
    if (!memoryId || ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return this.persistPermanent(batchId, sourceKey, 'invalid_reinforcement', 'memory_id and unique non-empty evidence_ids are required.', now);
    }
    const memory = this.store.getMemory(memoryId);
    if (!memory) return this.persistPermanent(batchId, sourceKey, 'unknown_memory', `Unknown canonical memory ID: ${memoryId}`, now);
    const world = memory.kind === WORLD_UPDATE_KIND;
    if (!world && input.world_revision_id !== undefined) {
      return this.persistPermanent(batchId, sourceKey, 'invalid_reinforcement', 'world_revision_id applies only to a world_update memory.', now);
    }
    if (world && !worldRevisionId) {
      return this.persistPermanent(batchId, sourceKey, 'invalid_reinforcement', 'A world_update reinforcement must cite the head revision it confirms: world_revision_id from memory_search.', now);
    }
    const messages: CanonicalMessage[] = [];
    const skipped: string[] = [];
    const untrusted: string[] = [];
    for (const id of normalizedIds) {
      const resolved = this.trustedEvidence(id, legacyEvidenceField);
      if (resolved.ambiguous) return this.persistPermanent(batchId, sourceKey, 'ambiguous_evidence', `Legacy message_id identifies multiple trusted transcript events; use an exact evidence_id: ${id}`, now);
      if (!resolved.message) return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${id}`, now);
      if (world && !isWorldSourceEvidenceKind(resolved.message.event_kind)) untrusted.push(id);
      if (isCitableEvidenceKind(resolved.message.event_kind)) messages.push(resolved.message);
      else skipped.push(id);
    }
    if (untrusted.length > 0) return this.persistPermanent(batchId, sourceKey, UNTRUSTED_WORLD_SOURCE, untrustedWorldRejection(untrusted), now);
    if (skipped.length > 0) return this.persistPermanent(batchId, sourceKey, NOT_CITABLE_EVIDENCE, notCitableRejection(skipped), now);
    // The merged world_update family this anchor belongs to, read under the mutation lock.
    const family = world ? this.currentWorldUpdate(memoryId) : undefined;
    const memoryEvidence = this.store.listEvidence().filter((item) => item.memory_id === memoryId);
    const originalEvidenceIds = this.originalMemoryEvidenceIds(memory, memoryEvidence);
    if (!originalEvidenceIds) return this.markRetryable(batchId, sourceKey, `Unable to reconstruct canonical evidence provenance for memory: ${memoryId}`, now, intent);
    const completedEvidenceIds = new Set(originalEvidenceIds);
    for (const reinforcement of this.store.listReinforcements()) {
      if (reinforcement.memory_id !== memoryId) continue;
      for (const evidenceId of reinforcement.evidence_ids) completedEvidenceIds.add(evidenceId);
    }
    // A world_update anchor also holds the evidence of its revisions; citing it again confirms nothing new.
    if (world) for (const revision of this.store.listWorldRevisionsForMemoryIds([memoryId])) for (const evidenceId of revision.evidence_ids) completedEvidenceIds.add(evidenceId);
    // A message is already attached when the memory holds its evidence id, or holds the same transcript block under
    // another conversation's id; a block repeated inside this call is attached once. Only completed evidence counts,
    // so a half-committed reinforcement is still repaired. For a world_update, a block behind any write of the merged
    // family is attached too.
    const attachedSources = new Set<string | undefined>(memoryEvidence.filter((item) => completedEvidenceIds.has(item.evidence_id)).map(evidenceSourceKey));
    if (world) for (const block of this.worldFamilyUsedBlocks(memoryId, family)) attachedSources.add(block);
    // Used before this call, judged before the filter below adds this call's own blocks.
    const usedBefore = world
      ? messages.filter((message) => completedEvidenceIds.has(memoryEvidenceId(memoryId, message)) || attachedSources.has(messageBlockKey(message)))
      : [];
    const newMessages = messages.filter((message) => {
      if (completedEvidenceIds.has(memoryEvidenceId(memoryId, message))) return false;
      const source = world ? messageBlockKey(message) : evidenceSourceKey(message);
      if (source === undefined) return true;
      if (attachedSources.has(source)) return false;
      attachedSources.add(source);
      return true;
    });
    if (newMessages.length === 0) return this.persistOutcomePair(batchId, sourceKey, 'duplicate', memoryId, now, intent);
    // A world reinforcement that cites a block already behind a write of the family beside new ones is refused whole;
    // checked after the duplicate check (a torn replay is all used) and before the head check.
    if (world && usedBefore.length > 0) return this.persistPermanent(batchId, sourceKey, REUSED_WORLD_EVIDENCE, reusedWorldEvidenceRejection(usedBefore.map(canonicalEvidenceId)), now);
    if (world) {
      // Evidence for a fact that has since changed must not confirm the new head. Checked after the duplicate check,
      // so a torn reinforcement still replays as a duplicate.
      const head = family?.world_update?.head;
      if (!head?.revision_id || head.revision_id !== worldRevisionId) {
        return this.persistPermanent(batchId, sourceKey, STALE_WORLD_REVISION, `The current head of this world_update is ${head?.revision_id ?? 'not recorded yet'}, not ${worldRevisionId}; nothing was saved. Search again, then reinforce the current head or record a changed fact as a world update.`, now);
      }
    }
    const newMessageIds = newMessages.map(canonicalEvidenceId).sort();
    const evidence: EvidenceRecord[] = newMessages.map((message) => ({
      evidence_id: memoryEvidenceId(memoryId, message), memory_id: memoryId,
      conversation_id: message.conversation_id, message_id: message.message_id, role: message.role, quote: message.quote, captured_at: message.captured_at,
      ...evidenceProvenance(message),
    }));
    const confirms = world ? { world_revision_id: worldRevisionId! } : {};
    const reinforcement: ReinforcementRecord = {
      schema_version: 1, reinforcement_id: legacyEvidenceField
        ? stableId('reinforce', { memory_id: memoryId, evidence_message_ids: newMessageIds, ...confirms })
        : stableId('reinforce', { memory_id: memoryId, evidence_ids: newMessageIds, ...confirms }),
      memory_id: memoryId, batch_id: batchId, evidence_ids: evidence.map((item) => item.evidence_id),
      latest_evidence_at: newMessages.map((message) => message.captured_at).sort().at(-1)!, recorded_at: now,
      ...confirms,
    };
    const existed = this.store.listReinforcements().some((item) => item.reinforcement_id === reinforcement.reinforcement_id);
    try { this.store.appendReinforcement(reinforcement, evidence); }
    catch (error) { return this.markRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now, intent); }
    return this.persistOutcomePair(batchId, sourceKey, existed ? 'duplicate' : 'accepted', memoryId, now, intent, 'duplicate');
  }

  rememberKind(batchId: string, kind: CanonicalMemoryKind, rawInput: unknown): RememberResult {
    const input = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? rawInput as Record<string, unknown>
      : {};
    return this.remember(batchId, {
      ...input,
      schema_version: 1,
      kind,
    });
  }

  remember(batchId: string, rawProposal: unknown): RememberResult {
    const now = this.now();
    this.ensureRetryAttempt(batchId, now);
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
        previous.rejection_code && EVIDENCE_REFUSAL_CODES.has(previous.rejection_code) ? undefined : rawTrustedIntent,
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

    const world = proposal.kind === WORLD_UPDATE_KIND;
    const evidenceMessages: CanonicalMessage[] = [];
    const skipped: string[] = [];
    const untrusted: string[] = [];
    for (const evidenceId of proposal.evidence_message_ids) {
      const resolved = this.trustedEvidence(evidenceId, legacyEvidenceField);
      if (resolved.ambiguous) {
        return this.persistPermanent(batchId, sourceKey, 'ambiguous_evidence', `Legacy message_id identifies multiple trusted transcript events; use an exact evidence_id: ${evidenceId}`, now, assistantIntent);
      }
      if (!resolved.message) {
        return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${evidenceId}`, now, assistantIntent);
      }
      if (world && !isWorldSourceEvidenceKind(resolved.message.event_kind)) untrusted.push(evidenceId);
      if (isCitableEvidenceKind(resolved.message.event_kind)) evidenceMessages.push(resolved.message);
      else skipped.push(evidenceId);
    }
    if (untrusted.length > 0) return this.persistPermanent(batchId, sourceKey, UNTRUSTED_WORLD_SOURCE, untrustedWorldRejection(untrusted), now);
    if (skipped.length > 0) return this.persistPermanent(batchId, sourceKey, NOT_CITABLE_EVIDENCE, notCitableRejection(skipped), now);

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
        this.appendMemoryWithFirstRevision(batchId, recoveredMemory, recoveredEvidence, evidenceMessages, proposal.as_of, now);
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
      this.appendMemoryWithFirstRevision(batchId, memory, evidence, evidenceMessages, proposal.as_of, now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.markRetryable(batchId, sourceKey, reason, now, assistantIntent);
    }
    return this.persistOutcomePair(batchId, sourceKey, 'accepted', memoryId, now, assistantIntent);
  }

  /** A world_update's r1 and evidence land before its anchor row, in one mutation boundary; other kinds append the memory only. */
  private appendMemoryWithFirstRevision(
    batchId: string,
    memory: CanonicalMemoryRecord,
    evidence: EvidenceRecord[],
    messages: readonly CanonicalMessage[],
    asOf: string | undefined,
    now: string,
  ): void {
    if (memory.kind !== WORLD_UPDATE_KIND) {
      this.store.appendMemory(memory, evidence);
      return;
    }
    const fact = String(memory.payload.fact);
    const resolvedAsOf = worldAsOf(asOf, messages, now);
    const revision: Omit<WorldRevisionRecord, 'sequence'> = {
      schema_version: 1,
      revision_id: worldRevisionId(memory.memory_id, fact, resolvedAsOf, messages.map(messageBlockKey)),
      memory_id: memory.memory_id,
      fact,
      as_of: resolvedAsOf,
      source: worldUpdateSource(messages),
      evidence_ids: evidence.map((item) => item.evidence_id),
      batch_id: batchId,
      // The anchor's time. On a replay after a crash before the anchor row, r1 keeps the first attempt's time.
      recorded_at: memory.created_at,
    };
    this.store.withMutationBoundary(() => {
      // r1 and its evidence land before the anchor row, so an anchor never exists without them. A crash in between
      // leaves an r1 no anchor points to: invisible, and the same-batch replay derives the same memory_id and r1.
      this.store.appendWorldRevision(revision, evidence, true);
      this.store.appendMemory(memory, evidence);
    });
  }

  private persistWorldDuplicate(batchId: string, sourceKey: string, memoryId: string, reason: string, now: string): RememberResult {
    try {
      this.store.appendOutcome({
        batch_id: batchId, ...this.attemptFields(batchId), source_key: sourceKey, outcome: 'duplicate', memory_id: memoryId, reason, recorded_at: now,
      });
      return { outcome: 'duplicate', memory_id: memoryId, reason };
    } catch (error) {
      return this.markRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now);
    }
  }

  /**
   * Appends a revision to a world_update anchor: the fact changed. Runs under one canonical mutation boundary, so the
   * duplicate check sees every committed revision. Evidence rules match remember / reinforce for this kind; `source`
   * is derived from the cited events, never taken from the caller.
   */
  worldUpdate(batchId: string, input: WorldUpdateInput): RememberResult {
    return this.store.withMutationBoundary(() => this.worldUpdateInBoundary(batchId, input));
  }

  private worldUpdateInBoundary(batchId: string, input: WorldUpdateInput): RememberResult {
    const now = this.now();
    this.ensureRetryAttempt(batchId, now);
    const memoryId = typeof input?.memory_id === 'string' ? input.memory_id.trim() : '';
    const fact = typeof input?.fact === 'string' ? input.fact.trim() : '';
    const rawAsOf = input?.as_of;
    const ids = Array.isArray(input?.evidence_ids) ? input.evidence_ids.map((id) => typeof id === 'string' ? id.trim() : '') : [];
    const normalizedIds = [...ids].sort();
    const sourceKey = stableId('world_update_src', {
      batch_id: batchId, memory_id: memoryId, fact, evidence_ids: normalizedIds, ...(rawAsOf === undefined ? {} : { as_of: rawAsOf }),
    });
    const previous = this.store.getTerminalOutcome(sourceKey);
    if (previous) {
      if (previous.outcome === 'accepted' || previous.outcome === 'duplicate') {
        return { outcome: 'duplicate', memory_id: previous.memory_id ?? memoryId, ...(previous.reason ? { reason: previous.reason } : {}) };
      }
      return { outcome: previous.outcome, rejection_code: previous.rejection_code, reason: previous.reason };
    }
    if (!memoryId || !fact || ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return this.persistPermanent(batchId, sourceKey, 'invalid_world_update', 'memory_id, a non-empty fact and unique non-empty evidence_ids are required.', now);
    }
    const asOf = rawAsOf === undefined ? undefined : cleanWorldAsOf(rawAsOf);
    if (asOf === null) return this.persistPermanent(batchId, sourceKey, 'invalid_as_of', 'as_of must be a calendar date (YYYY-MM-DD) when present.', now);
    const memory = this.store.getMemory(memoryId);
    if (!memory) return this.persistPermanent(batchId, sourceKey, 'unknown_memory', `Unknown canonical memory ID: ${memoryId}`, now);
    if (memory.kind !== WORLD_UPDATE_KIND) {
      return this.persistPermanent(batchId, sourceKey, NOT_WORLD_UPDATE, `Memory ${memoryId} is a ${memory.kind}, not a world_update; only a world_update takes revisions.`, now);
    }
    if (this.requireChineseSemanticProse && !containsChineseSemanticProse(fact)) {
      return this.persistPermanent(batchId, sourceKey, 'non_chinese_semantic_prose', 'world_update.fact must contain Chinese semantic prose for DS-authored canonical writes.', now);
    }
    const messages: CanonicalMessage[] = [];
    const untrusted: string[] = [];
    for (const id of normalizedIds) {
      const resolved = this.trustedEvidence(id);
      if (resolved.ambiguous) return this.persistPermanent(batchId, sourceKey, 'ambiguous_evidence', `Evidence id identifies multiple trusted transcript events: ${id}`, now);
      if (!resolved.message) return this.persistPermanent(batchId, sourceKey, 'unresolvable_evidence', `Evidence event is not available in the trusted batch: ${id}`, now);
      if (isWorldSourceEvidenceKind(resolved.message.event_kind)) messages.push(resolved.message);
      else untrusted.push(id);
    }
    if (untrusted.length > 0) return this.persistPermanent(batchId, sourceKey, UNTRUSTED_WORLD_SOURCE, untrustedWorldRejection(untrusted), now);

    // The merged chain this anchor belongs to: the head and every earlier revision of the family.
    const family = this.currentWorldUpdate(memoryId);
    const head = family?.world_update?.head;
    if (head && normalizeWorldFact(head.fact) === normalizeWorldFact(fact)) return this.persistWorldDuplicate(batchId, sourceKey, memoryId, WORLD_FACT_DUPLICATE_REASON, now);
    // A transcript block backs at most one write of a family. A block already behind a revision or a confirmation,
    // under any conversation, is a replay whatever the fact's wording, and must not bring an earlier fact back.
    const used = this.worldFamilyUsedBlocks(memoryId, family);
    const reused = messages.filter((message) => used.has(messageBlockKey(message))).map(canonicalEvidenceId);
    if (reused.length === messages.length && reused.length > 0) return this.persistWorldDuplicate(batchId, sourceKey, memoryId, worldReplayDuplicate(reused), now);
    if (reused.length > 0) return this.persistPermanent(batchId, sourceKey, REUSED_WORLD_EVIDENCE, reusedWorldEvidenceRejection(reused), now);

    const resolvedAsOf = worldAsOf(asOf, messages, now);
    const evidence: EvidenceRecord[] = messages.map((message) => ({
      evidence_id: memoryEvidenceId(memoryId, message), memory_id: memoryId,
      conversation_id: message.conversation_id, message_id: message.message_id, role: message.role, quote: message.quote, captured_at: message.captured_at,
      ...evidenceProvenance(message),
    }));
    const revision: Omit<WorldRevisionRecord, 'sequence'> = {
      schema_version: 1,
      revision_id: worldRevisionId(memoryId, fact, resolvedAsOf, messages.map(messageBlockKey)),
      memory_id: memoryId,
      fact,
      as_of: resolvedAsOf,
      source: worldUpdateSource(messages),
      evidence_ids: evidence.map((item) => item.evidence_id),
      batch_id: batchId,
      recorded_at: now,
    };
    const existed = this.store.listWorldRevisionsForMemoryIds([memoryId]).some((item) => item.revision_id === revision.revision_id);
    try { this.store.appendWorldRevision(revision, evidence); }
    catch (error) { return this.markRetryable(batchId, sourceKey, error instanceof Error ? error.message : String(error), now); }
    return this.persistOutcomePair(batchId, sourceKey, existed ? 'duplicate' : 'accepted', memoryId, now);
  }

  /** Records a `deferred` outcome per unresolved intent and returns the ones that must still hold the batch. */
  private deferUnresolvedIntents(batchId: string, intentIds: readonly string[], now: string): string[] {
    if (intentIds.length === 0) return [];
    const deferrals = deferredIntentCounts(this.store.listAssistantIntentOutcomes());
    return intentIds.filter((intentId) => {
      const turn = (deferrals.get(intentId) ?? 0) + 1;
      const released = turn >= MAX_UNRESOLVED_INTENT_TURNS;
      try {
        this.store.appendAssistantIntentOutcome({
          intent_id: intentId,
          batch_id: batchId,
          ...this.attemptFields(batchId),
          outcome: 'deferred',
          reason: released
            ? `Unresolved after ${turn} completed observer turns; released so the transcript cursor can advance.`
            : `Unresolved after completed observer turn ${turn} of ${MAX_UNRESOLVED_INTENT_TURNS}.`,
          recorded_at: now,
        });
      } catch {
        return true; // without a durable deferral record, keep holding the batch
      }
      return !released;
    });
  }

  finalizeBatch(batchId: string, sessionSucceeded: boolean): BatchCompletion {
    const now = this.now();
    const currentAttempt = this.currentAttempt(batchId);
    const attemptId = currentAttempt?.attempt_id;
    const inCurrentAttempt = <T extends { attempt_id?: string }>(item: T): boolean => !attemptId || item.attempt_id === attemptId;
    const outcomes = this.store.listOutcomes().filter((item) => item.batch_id === batchId && inCurrentAttempt(item));
    const entityOutcomes = this.store.listEntityOutcomes().filter((item) => item.batch_id === batchId && inCurrentAttempt(item));
    const latestBySource = new Map<string, RememberOutcome>();
    for (const outcome of outcomes) latestBySource.set(outcome.source_key, outcome);
    const latestEntityBySource = new Map<string, (typeof entityOutcomes)[number]>();
    for (const outcome of entityOutcomes) latestEntityBySource.set(outcome.source_key, outcome);

    const intentOutcomes = this.store.listAssistantIntentOutcomes().filter((item) => item.batch_id === batchId && inCurrentAttempt(item));
    const latestByIntent = new Map<string, AssistantIntentOutcome>();
    for (const outcome of intentOutcomes) latestByIntent.set(outcome.intent_id, outcome);
    const unresolvedIntentIds = [...this.trustedAssistantIntents.keys()].filter((intentId) => {
      const latest = latestByIntent.get(intentId);
      return !latest || latest.outcome === 'retryable_failed';
    });
    // Only a turn the observer actually completed counts against an intent's budget.
    const blockingIntentIds = sessionSucceeded ? this.deferUnresolvedIntents(batchId, unresolvedIntentIds, now) : unresolvedIntentIds;

    const retryReasons: BatchRetryReason[] = [];
    if (!sessionSucceeded) retryReasons.push('turn_failed');
    if (this.retryableAttempts.has(attemptId ?? `legacy:${batchId}`)) retryReasons.push('attempt_retryable');
    if ([...latestBySource.values()].some((item) => item.outcome === 'retryable_failed')) retryReasons.push('memory_retryable');
    if ([...latestEntityBySource.values()].some((item) => item.outcome === 'retryable_failed')) retryReasons.push('entity_retryable');
    if (blockingIntentIds.length > 0) retryReasons.push('intent_blocking');
    const retryable = retryReasons.length > 0;
    const status: BatchCompletion = retryable ? 'retryable_failure' : 'completed';
    this.store.finalizeBatch({
      batch_id: batchId,
      ...(attemptId ? { attempt_id: attemptId } : {}),
      status,
      created_at: currentAttempt?.created_at ?? now,
      finalized_at: now,
      ...(!retryable && outcomes.length === 0 && entityOutcomes.length === 0 && this.trustedAssistantIntents.size === 0 ? { detail: 'no_memory_required' as const } : {}),
      ...(retryable ? { retry_reasons: retryReasons } : {}),
    });
    return status;
  }
}

export function cursorShouldAdvance(completion: BatchCompletion): boolean {
  return completion === 'completed';
}

export function memoryRememberKindToolSchema(kind: CanonicalMemoryKind): Record<string, unknown> {
  const stringSchema = (): Record<string, unknown> => ({ type: 'string', minLength: 1 });
  const stringArraySchema = (requireNonEmpty = false): Record<string, unknown> => ({
    type: 'array',
    ...(requireNonEmpty ? { minItems: 1 } : {}),
    uniqueItems: true,
    items: stringSchema(),
  });
  const fieldDefinitions = MEMORY_KIND_DEFINITIONS[kind].fields as Record<string, MemoryPayloadFieldDefinition>;
  const payloadProperties = Object.fromEntries(Object.entries(fieldDefinitions).map(([name, definition]) => [
    name,
    {
      ...(definition.valueType === 'string_array'
        ? stringArraySchema(definition.requireNonEmptyArray ?? false)
        : stringSchema()),
      ...(definition.description ? { description: definition.description } : {}),
    },
  ]));
  const payloadRequired = Object.entries(fieldDefinitions)
    .filter(([, definition]) => definition.required)
    .map(([name]) => name);

  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'participants', 'evidence_ids', 'payload'],
    properties: {
      summary: {
        ...stringSchema(),
        description: 'Concise source-grounded historical event or stable-fact index. State what happened or what was explicitly stated; do not infer present feelings, motives, fulfillment, or relationship conclusions.',
      },
      participants: {
        type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
        items: { type: 'string', enum: ['user', 'assistant'] },
      },
      evidence_ids: {
        type: 'array', minItems: 1, uniqueItems: true, items: stringSchema(),
        description: 'Exact evidence_id values copied from the trusted current-batch transcript-event evidence catalog.',
      },
      linked_memory_ids: stringArraySchema(),
      assistant_intent_id: {
        ...stringSchema(),
        description: 'Optional trusted assistant remember-intent ID copied exactly from the current-batch assistant intent catalog. Never supply feel text here.',
      },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: payloadRequired,
        description: `Payload for ${kind}. Only the declared fields are accepted. For model-authored new writes, summary and narrative semantic prose must be Chinese; literal names, aliases, trigger tokens, code, provider names, paths, URLs, and trusted evidence stay source-faithful.`,
        properties: payloadProperties,
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
    assistant_intent_id: { type: 'string', minLength: 1, description: 'Optional trusted assistant remember-intent ID copied exactly from the current-batch assistant intent catalog, when this existing memory already holds that intent\'s moment. Links the intent (and its feel) to this memory instead of creating a duplicate.' },
  } };
}

export function memoryMaintenanceReviewToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['memory_ids', 'relation', 'reason'],
    properties: {
      memory_ids: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
        description: 'Canonical memory IDs returned by prior purpose=maintenance memory_search calls in this same Subcon run.',
      },
      relation: {
        type: 'string',
        enum: [...MEMORY_RELATION_KINDS],
        description: 'Suggested relationship between these memories: same meaning, changed over time, context-dependent, unresolved conflict, related, or unrelated. This is only a proposal for owner review.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Short source-grounded explanation for the suggested relation. Do not resolve, merge, supersede, scope, link, dismiss, or rewrite memories here.',
      },
    },
  };
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
