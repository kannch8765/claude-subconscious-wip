import type {
  CanonicalMemoryKind,
  CanonicalMessage,
  EffectiveMemoryRecord,
  EvidenceRecord,
  MemoryRelationKind,
  ReinforcementRecord,
  WorldRevisionRecord,
  WorldUpdateSource,
  WorldUpdateView,
} from '../schema/index.js';
import { WORLD_UPDATE_KIND } from '../schema/index.js';
import { RelationshipMemoryStore, stableId, stableJson } from '../store/index.js';
import { semanticText } from '../retrieval/index.js';

/** Two facts are the same when they match after trimming and collapsing whitespace. */
export function normalizeWorldFact(fact: string): string {
  return fact.trim().replace(/\s+/gu, ' ');
}

/** `tool` when any cited event is a tool_result, else `user`. The model never supplies it. */
export function worldUpdateSource(messages: readonly CanonicalMessage[]): WorldUpdateSource {
  return messages.some((message) => message.event_kind === 'tool_result') ? 'tool' : 'user';
}

/**
 * `sourceBlocks`: the transcript-block identity of each cited event (the key reinforce dedupe uses), so the same block
 * carried again by another conversation gives the same revision id.
 */
export function worldRevisionId(memoryId: string, fact: string, asOf: string, sourceBlocks: readonly string[]): string {
  return stableId('world_rev', { memory_id: memoryId, fact, as_of: asOf, source_blocks: [...sourceBlocks].sort() });
}

/** The call's date when given, else the latest captured_at of the cited evidence. */
export function worldAsOf(explicit: string | undefined, messages: readonly CanonicalMessage[], fallback: string): string {
  return explicit ?? messages.map((message) => message.captured_at).sort().at(-1) ?? fallback;
}

export type EvidenceSource = Pick<EvidenceRecord, 'message_id' | 'block_index' | 'event_kind' | 'tool_use_id'>;

/**
 * Which transcript block evidence came from, without the conversation that carried it: a later conversation can carry
 * the same message again under a new transcript evidence id. Message-level evidence (no block_index or event_kind,
 * the shape from before per-block evidence) has no block source; it is matched by evidence id only.
 */
export function evidenceSourceKey(item: EvidenceSource): string | undefined {
  if (item.block_index === undefined || item.event_kind === undefined) return undefined;
  return stableJson({
    message_id: item.message_id,
    block_index: item.block_index,
    event_kind: item.event_kind,
    ...(item.tool_use_id ? { tool_use_id: item.tool_use_id } : {}),
  });
}

/** The transcript block behind an evidence row; message-level evidence falls back to its source or own evidence id. */
export function evidenceBlockKey(item: EvidenceSource & Pick<EvidenceRecord, 'evidence_id' | 'source_evidence_id'>): string {
  return evidenceSourceKey(item) ?? item.source_evidence_id ?? item.evidence_id;
}

/**
 * The transcript blocks behind every write of a world_update family: each revision and each reinforcement of the
 * anchors. Only written rows count, so a half-committed revision or reinforcement is still repaired. Key: the block
 * (`evidenceBlockKey`); value: the transcript evidence id (`source_evidence_id ?? evidence_id`).
 */
export function worldFamilyBlocks(store: RelationshipMemoryStore, anchorIds: readonly string[]): Map<string, string> {
  const ids = new Set(anchorIds);
  const written = new Set<string>();
  for (const revision of store.listWorldRevisionsForMemoryIds([...ids])) for (const id of revision.evidence_ids) written.add(id);
  for (const reinforcement of store.listReinforcements()) {
    if (ids.has(reinforcement.memory_id)) for (const id of reinforcement.evidence_ids) written.add(id);
  }
  const blocks = new Map<string, string>();
  for (const item of store.listEvidenceForMemoryIds([...ids])) {
    if (written.has(item.evidence_id)) blocks.set(evidenceBlockKey(item), item.source_evidence_id ?? item.evidence_id);
  }
  return blocks;
}

export interface WorldChainInput {
  /** The anchor and, after an owner same_meaning merge, the anchors merged into it. */
  anchors: ReadonlyArray<Pick<EffectiveMemoryRecord, 'memory_id' | 'payload' | 'observed_at' | 'created_at'>>;
  /** Revisions of any of the anchors, in any order. */
  revisions: readonly WorldRevisionRecord[];
  /** Evidence rows of the anchors (only captured_at is read). */
  evidence: ReadonlyArray<Pick<EvidenceRecord, 'evidence_id' | 'memory_id' | 'captured_at'>>;
  reinforcements: ReadonlyArray<Pick<ReinforcementRecord, 'memory_id' | 'evidence_ids' | 'latest_evidence_at' | 'world_revision_id'>>;
}

/** Chain order: recorded_at, then the commit sequence (an anchor's r1 is 0), then revision_id. */
export function compareWorldRevisions(a: WorldRevisionRecord, b: WorldRevisionRecord): number {
  return a.recorded_at.localeCompare(b.recorded_at) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.revision_id.localeCompare(b.revision_id);
}

/**
 * One chain for the anchor(s): every revision in recorded_at order, oldest first, ties by commit sequence. The head is
 * the last one; an earlier `as_of` never reorders it. `last_confirmed` is the latest captured_at over the head's own
 * evidence and every reinforcement that confirmed this head (its `world_revision_id`), whenever it was written.
 *
 * A transcript block backs at most one write of a family (the write path refuses a reuse), and an owner merge of two
 * families that share a block is refused, so the chain needs no per-block filtering.
 */
export function buildWorldUpdateView(input: WorldChainInput): WorldUpdateView {
  const anchorIds = new Set(input.anchors.map((anchor) => anchor.memory_id));
  const revisions = input.revisions.filter((revision) => anchorIds.has(revision.memory_id)).sort(compareWorldRevisions);
  const capturedAt = new Map(input.evidence.filter((item) => anchorIds.has(item.memory_id)).map((item) => [item.evidence_id, item.captured_at]));
  const reinforcements = input.reinforcements.filter((item) => anchorIds.has(item.memory_id));
  const latest = (values: Array<string | undefined>): string | undefined => values.filter((value): value is string => Boolean(value)).sort().at(-1);
  const head = revisions.at(-1);

  if (!head) {
    // Only reachable between an anchor's append and its r1 append; the batch retry writes r1.
    const anchor = [...input.anchors].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.memory_id.localeCompare(b.memory_id))[0];
    const evidenceIds = input.evidence.filter((item) => anchorIds.has(item.memory_id)).map((item) => item.evidence_id);
    return {
      head: { fact: String(anchor?.payload.fact ?? ''), as_of: anchor?.observed_at ?? '', recorded_at: anchor?.created_at ?? '' },
      revision_count: 0,
      last_confirmed: latest([...capturedAt.values()]) ?? anchor?.observed_at ?? '',
      head_evidence_ids: [...new Set(evidenceIds)],
      revisions: [],
    };
  }

  const confirming = reinforcements.filter((item) => item.world_revision_id === head.revision_id);
  return {
    head: { revision_id: head.revision_id, fact: head.fact, as_of: head.as_of, source: head.source, recorded_at: head.recorded_at },
    revision_count: revisions.length,
    last_confirmed: latest([
      ...head.evidence_ids.map((id) => capturedAt.get(id)),
      ...confirming.map((item) => item.latest_evidence_at),
    ]) ?? head.recorded_at,
    head_evidence_ids: [...new Set([...head.evidence_ids, ...confirming.flatMap((item) => item.evidence_ids)])],
    revisions,
  };
}

function sourceIds(memory: Pick<EffectiveMemoryRecord, 'memory_id' | 'resolution_source_memory_ids'>): string[] {
  return memory.resolution_source_memory_ids ?? [memory.memory_id];
}

/**
 * Adds `world_update` (head, revision_count, last_confirmed, full chain) to every world_update memory and shows the
 * head's fact as `payload.fact`. Other kinds pass through untouched, and a store without world_update memories is not
 * read at all. Call it after owner resolutions so a same_meaning merge shows one chain over all merged anchors.
 */
export function attachWorldUpdateViews(
  store: RelationshipMemoryStore,
  memories: readonly EffectiveMemoryRecord[],
  reinforcements?: readonly ReinforcementRecord[],
): EffectiveMemoryRecord[] {
  const worldMemories = memories.filter((memory) => memory.kind === WORLD_UPDATE_KIND);
  if (worldMemories.length === 0) return [...memories];
  const anchorIds = [...new Set(worldMemories.flatMap(sourceIds))];
  const wanted = new Set(anchorIds);
  // Grouped once by anchor, so each chain only reads its own rows.
  const byAnchor = <T extends { memory_id: string }>(rows: readonly T[]): Map<string, T[]> => {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      if (!wanted.has(row.memory_id)) continue;
      const bucket = grouped.get(row.memory_id) ?? [];
      bucket.push(row);
      grouped.set(row.memory_id, bucket);
    }
    return grouped;
  };
  const revisions = byAnchor(store.listWorldRevisionsForMemoryIds(anchorIds));
  const evidence = byAnchor(store.listEvidenceForMemoryIds(anchorIds));
  const anchorReinforcements = byAnchor(reinforcements ?? store.listReinforcements());
  const genesisById = new Map<string, Pick<EffectiveMemoryRecord, 'memory_id' | 'payload' | 'observed_at' | 'created_at'>>();
  for (const memory of memories) genesisById.set(memory.memory_id, memory);
  for (const memoryId of anchorIds) {
    if (!genesisById.has(memoryId)) {
      const genesis = store.getMemory(memoryId);
      if (genesis) genesisById.set(memoryId, genesis);
    }
  }
  return memories.map((memory) => {
    if (memory.kind !== WORLD_UPDATE_KIND) return memory;
    const ids = sourceIds(memory);
    const anchors = ids.map((id) => genesisById.get(id)).filter((anchor): anchor is NonNullable<typeof anchor> => Boolean(anchor));
    const view = buildWorldUpdateView({
      anchors,
      revisions: ids.flatMap((id) => revisions.get(id) ?? []),
      evidence: ids.flatMap((id) => evidence.get(id) ?? []),
      reinforcements: ids.flatMap((id) => anchorReinforcements.get(id) ?? []),
    });
    return { ...memory, payload: { ...memory.payload, fact: view.head.fact }, world_update: view };
  });
}

/** The summary a search or recall card serves for a world_update: its topic and current head, never the r1 wording. */
export function withServedWorldSummary<T extends EffectiveMemoryRecord>(memory: T): T {
  if (memory.kind !== WORLD_UPDATE_KIND || !memory.world_update) return memory;
  return { ...memory, summary: `${String(memory.payload.topic ?? '')}：${memory.world_update.head.fact}` };
}

/** Search and recall show the head only: the chain is dropped, the head, count and last_confirmed stay. */
export function withoutWorldRevisions<T extends EffectiveMemoryRecord>(memory: T): T {
  if (!memory.world_update?.revisions) return memory;
  const { revisions: _revisions, ...view } = memory.world_update;
  return { ...memory, world_update: view };
}

const WORLD_WORLD_RELATIONS: ReadonlySet<MemoryRelationKind> = new Set(['related', 'unrelated', 'same_meaning']);
const WORLD_OTHER_RELATIONS: ReadonlySet<MemoryRelationKind> = new Set(['related', 'unrelated']);

export const INVALID_WORLD_RELATION = 'invalid_world_relation';
export const OVERLAPPING_WORLD_EVIDENCE = 'overlapping_world_evidence';

/**
 * Transcript evidence ids of the blocks that two or more of the families (each a list of anchor ids) both used for a
 * write, sorted and unique. Empty means the families can merge without one chain citing a block twice.
 */
export function worldMergeOverlap(store: RelationshipMemoryStore, families: readonly (readonly string[])[]): string[] {
  const blocks = families.map((anchorIds) => worldFamilyBlocks(store, anchorIds));
  const shared = new Set<string>();
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      for (const [block, evidenceId] of blocks[i]) {
        const other = blocks[j].get(block);
        if (other === undefined) continue;
        shared.add(evidenceId);
        shared.add(other);
      }
    }
  }
  return [...shared].sort();
}

/**
 * Relations with a world_update member: world ↔ world may be related, unrelated or same_meaning (two anchors for one
 * topic); world ↔ any other kind only related or unrelated. A merge or a temporal/conflict/context relation across them
 * would break the revision chain. Returns why the relation is refused, or undefined when it is allowed.
 */
export function worldRelationViolation(kinds: readonly CanonicalMemoryKind[], relation: MemoryRelationKind): string | undefined {
  const worldCount = kinds.filter((kind) => kind === WORLD_UPDATE_KIND).length;
  if (worldCount === 0) return undefined;
  if (worldCount === kinds.length) {
    return WORLD_WORLD_RELATIONS.has(relation) ? undefined : `world_update memories relate to each other only as related, unrelated or same_meaning, not ${relation}.`;
  }
  return WORLD_OTHER_RELATIONS.has(relation) ? undefined : `A world_update relates to other kinds only as related or unrelated, not ${relation}.`;
}

/** Index text of a world_update memory: its topic and head fact (expects `attachWorldUpdateViews` output). */
export function worldUpdateIndexText(memory: Pick<EffectiveMemoryRecord, 'payload'>): string {
  return semanticText(memory.payload.topic, memory.payload.fact);
}
