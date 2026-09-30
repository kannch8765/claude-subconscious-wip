import type {
  EffectiveMemoryRecord,
  MemoryRelationKind,
  MemoryResolutionRecord,
  MemoryResolutionResolveRecord,
} from '../schema/index.js';
import { MEMORY_RELATION_KINDS } from '../schema/index.js';
import { RelationshipMemoryStore, stableJson } from '../store/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';

export interface ResolveReviewCommand {
  resolution_id: string;
  relation: MemoryRelationKind;
  target_memory_id?: string;
  owner_summary?: string;
  contexts?: Record<string, string>;
  note?: string;
}

export interface UndoReviewCommand {
  resolution_id: string;
  note?: string;
}

const STRUCTURAL_RELATIONS = new Set<MemoryRelationKind>([
  'same_meaning',
  'changed_over_time',
  'context_dependent',
  'conflict',
]);

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value, field);
}

function normalizedContexts(value: unknown, memoryIds: readonly string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('contexts must be an object keyed by memory_id');
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  const expected = [...memoryIds].sort();
  if (stableJson(keys) !== stableJson(expected)) throw new Error('context_dependent resolution requires one context for every reviewed memory_id');
  return Object.fromEntries(expected.map((memoryId) => [memoryId, nonEmpty(raw[memoryId], `contexts.${memoryId}`)]));
}

function activeResolutionByReview(records: readonly MemoryResolutionRecord[]): Map<string, MemoryResolutionResolveRecord> {
  const activeByReview = new Map<string, MemoryResolutionResolveRecord>();
  for (const record of records) {
    if (record.action === 'resolve') {
      activeByReview.set(record.review_id, record);
      continue;
    }
    const active = activeByReview.get(record.review_id);
    if (active?.resolution_id === record.undoes_resolution_id) activeByReview.delete(record.review_id);
  }
  return activeByReview;
}

export function activeMemoryResolutions(records: readonly MemoryResolutionRecord[]): MemoryResolutionResolveRecord[] {
  return [...activeResolutionByReview(records).values()]
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.resolution_id.localeCompare(b.resolution_id));
}

function withRelationMetadata(
  memory: EffectiveMemoryRecord,
  resolution: MemoryResolutionResolveRecord,
): EffectiveMemoryRecord {
  const reviewIds = [...new Set([...(memory.resolution_review_ids ?? []), resolution.review_id])].sort();
  return {
    ...memory,
    resolution_relation: memory.resolution_relation && resolution.relation === 'related'
      ? memory.resolution_relation
      : resolution.relation,
    resolution_review_ids: reviewIds,
  };
}

export function applyMemoryResolutions(
  memories: readonly EffectiveMemoryRecord[],
  resolutions: readonly MemoryResolutionResolveRecord[],
): EffectiveMemoryRecord[] {
  const byId = new Map(memories.map((memory) => [memory.memory_id, { ...memory }]));
  const hidden = new Set<string>();

  for (const resolution of resolutions) {
    const members = resolution.memory_ids.map((memoryId) => byId.get(memoryId)).filter((memory): memory is EffectiveMemoryRecord => Boolean(memory));
    if (members.length !== resolution.memory_ids.length) continue;

    if (resolution.relation === 'same_meaning') {
      const targetId = resolution.target_memory_id!;
      const target = byId.get(targetId);
      if (!target) continue;
      const sourceIds = [...new Set(members.flatMap((memory) => memory.resolution_source_memory_ids ?? [memory.memory_id]))].sort();
      const linked = [...new Set(members.flatMap((memory) => memory.linked_memory_ids ?? []).filter((memoryId) => !sourceIds.includes(memoryId)))].sort();
      byId.set(targetId, {
        ...withRelationMetadata(target, resolution),
        ...(resolution.owner_summary ? { summary: resolution.owner_summary } : {}),
        ...(linked.length ? { linked_memory_ids: linked } : {}),
        resolution_source_memory_ids: sourceIds,
      });
      for (const memoryId of resolution.memory_ids) if (memoryId !== targetId) hidden.add(memoryId);
      continue;
    }

    if (resolution.relation === 'changed_over_time') {
      const targetId = resolution.target_memory_id!;
      const target = byId.get(targetId);
      if (!target) continue;
      const historical = resolution.memory_ids.filter((memoryId) => memoryId !== targetId).sort();
      byId.set(targetId, {
        ...withRelationMetadata(target, resolution),
        resolution_historical_memory_ids: historical,
      });
      for (const memoryId of historical) hidden.add(memoryId);
      continue;
    }

    if (resolution.relation === 'context_dependent') {
      for (const memoryId of resolution.memory_ids) {
        const memory = byId.get(memoryId);
        if (!memory) continue;
        byId.set(memoryId, {
          ...withRelationMetadata(memory, resolution),
          resolution_context: resolution.contexts?.[memoryId],
        });
      }
      continue;
    }

    if (resolution.relation === 'conflict') {
      for (const memoryId of resolution.memory_ids) hidden.add(memoryId);
      continue;
    }

    if (resolution.relation === 'related') {
      for (const memoryId of resolution.memory_ids) {
        const memory = byId.get(memoryId);
        if (!memory) continue;
        const linked = [...new Set([...(memory.linked_memory_ids ?? []), ...resolution.memory_ids.filter((id) => id !== memoryId)])].sort();
        byId.set(memoryId, {
          ...withRelationMetadata(memory, resolution),
          linked_memory_ids: linked,
        });
      }
      continue;
    }

    // unrelated is an owner-confirmed dismissal only; it intentionally changes no memory view.
  }

  return memories
    .map((memory) => byId.get(memory.memory_id)!)
    .filter((memory) => !hidden.has(memory.memory_id));
}

export function materializeCurrentMemoryView(store: RelationshipMemoryStore): EffectiveMemoryRecord[] {
  const owner = new RelationshipMemoryOwnerControlPlane(store);
  return applyMemoryResolutions(owner.listEffective(), store.listActiveMemoryResolutions());
}

export class RelationshipMemoryResolutionControlPlane {
  constructor(readonly store: RelationshipMemoryStore, readonly now: () => string = () => new Date().toISOString()) {}

  resolveReview(reviewId: string, command: ResolveReviewCommand): MemoryResolutionResolveRecord {
    const id = nonEmpty(reviewId, 'review_id');
    const resolutionId = nonEmpty(command.resolution_id, 'resolution_id');
    const existing = this.store.listMemoryResolutionRecords().find((record) => record.resolution_id === resolutionId);
    if (existing) {
      if (existing.action !== 'resolve' || existing.review_id !== id) {
        throw new Error(`resolution_id already used for a different owner mutation: ${resolutionId}`);
      }
      const comparable = {
        relation: command.relation,
        target_memory_id: optionalText(command.target_memory_id, 'target_memory_id'),
        owner_summary: optionalText(command.owner_summary, 'owner_summary'),
        contexts: command.relation === 'context_dependent' ? normalizedContexts(command.contexts, existing.memory_ids) : command.contexts,
        note: optionalText(command.note, 'note'),
      };
      const existingComparable = {
        relation: existing.relation,
        target_memory_id: existing.target_memory_id,
        owner_summary: existing.owner_summary,
        contexts: existing.contexts,
        note: existing.note,
      };
      if (stableJson(comparable) !== stableJson(existingComparable)) {
        throw new Error(`resolution_id already used for a different owner mutation: ${resolutionId}`);
      }
      return existing;
    }

    const review = this.store.getMaintenanceReview(id);
    if (!review) throw new Error(`Unknown maintenance review ID: ${id}`);
    if (review.kind !== 'relation') throw new Error(`Maintenance review is not a relation review: ${id}`);
    if (review.status !== 'pending') throw new Error(`Maintenance review is not pending: ${id}`);

    if (!MEMORY_RELATION_KINDS.includes(command.relation)) throw new Error(`unsupported relation: ${command.relation}`);
    const relation = command.relation;
    const targetMemoryId = optionalText(command.target_memory_id, 'target_memory_id');
    const ownerSummary = optionalText(command.owner_summary, 'owner_summary');
    const note = optionalText(command.note, 'note');
    const memoryIds = [...review.memory_ids].sort();

    for (const memoryId of memoryIds) {
      if (!this.store.getMemory(memoryId)) throw new Error(`Unknown canonical memory ID: ${memoryId}`);
    }

    if (relation === 'same_meaning' || relation === 'changed_over_time') {
      if (!targetMemoryId || !memoryIds.includes(targetMemoryId)) throw new Error(`${relation} resolution requires target_memory_id from the reviewed memory set`);
    } else if (targetMemoryId) {
      throw new Error(`${relation} resolution does not accept target_memory_id`);
    }

    if (ownerSummary && relation !== 'same_meaning') throw new Error('owner_summary is only accepted for same_meaning resolution');
    const contexts = relation === 'context_dependent'
      ? normalizedContexts(command.contexts, memoryIds)
      : undefined;
    if (relation !== 'context_dependent' && command.contexts !== undefined) throw new Error(`${relation} resolution does not accept contexts`);

    if (STRUCTURAL_RELATIONS.has(relation)) {
      for (const active of this.store.listActiveMemoryResolutions()) {
        if (!STRUCTURAL_RELATIONS.has(active.relation)) continue;
        if (active.memory_ids.some((memoryId) => memoryIds.includes(memoryId))) {
          throw new Error(`memory already participates in active structural resolution: ${active.review_id}`);
        }
      }
    }

    const record: MemoryResolutionResolveRecord = {
      schema_version: 1,
      resolution_id: resolutionId,
      review_id: review.review_id,
      subject_id: review.subject_id,
      action: 'resolve',
      relation,
      memory_ids: memoryIds,
      recorded_at: this.now(),
      ...(targetMemoryId ? { target_memory_id: targetMemoryId } : {}),
      ...(ownerSummary ? { owner_summary: ownerSummary } : {}),
      ...(contexts ? { contexts } : {}),
      ...(note ? { note } : {}),
    };
    return this.store.appendMemoryResolution(record);
  }

  undoReview(reviewId: string, command: UndoReviewCommand): MemoryResolutionRecord {
    const id = nonEmpty(reviewId, 'review_id');
    const resolutionId = nonEmpty(command.resolution_id, 'resolution_id');
    const note = optionalText(command.note, 'note');
    const existing = this.store.listMemoryResolutionRecords().find((record) => record.resolution_id === resolutionId);
    if (existing) {
      if (existing.action !== 'undo' || existing.review_id !== id || existing.note !== note) {
        throw new Error(`resolution_id already used for a different owner mutation: ${resolutionId}`);
      }
      return existing;
    }
    const active = this.store.listActiveMemoryResolutions().find((resolution) => resolution.review_id === id);
    if (!active) throw new Error(`Maintenance review has no active resolution: ${id}`);
    return this.store.appendMemoryResolution({
      schema_version: 1,
      resolution_id: resolutionId,
      review_id: active.review_id,
      subject_id: active.subject_id,
      action: 'undo',
      undoes_resolution_id: active.resolution_id,
      recorded_at: this.now(),
      ...(note ? { note } : {}),
    });
  }
}
