import type {
  EffectiveMemoryRecord,
  MaintenanceReviewRecord,
  MemoryRelationKind,
  MemoryResolutionRecord,
  MemoryResolutionResolveRecord,
} from '../schema/index.js';
import { MEMORY_RELATION_KINDS } from '../schema/index.js';
import { RelationshipMemoryStore, stableJson } from '../store/index.js';
import { RelationshipMemoryOwnerControlPlane } from '../owner/index.js';
import { findProjectedReview, projectRelationReviewInbox } from '../review_inbox.js';

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
  const mergedInto = new Map<string, string>();

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
      for (const memoryId of resolution.memory_ids) if (memoryId !== targetId) {
        hidden.add(memoryId);
        mergedInto.set(memoryId, targetId);
      }
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

  const current = memories
    .map((memory) => byId.get(memory.memory_id)!)
    .filter((memory) => !hidden.has(memory.memory_id));
  const activeIds = new Set(current.filter((memory) => memory.status === 'active').map((memory) => memory.memory_id));
  const targetId = (id: string): string => {
    // Owner can merge a previously consolidated current memory again. Resolve
    // the resulting family alias chain without flattening the stored history.
    const seen = new Set<string>();
    while (mergedInto.has(id) && !seen.has(id)) {
      seen.add(id);
      id = mergedInto.get(id)!;
    }
    return id;
  };
  const links = new Map(current.map((memory) => [memory.memory_id, new Set<string>()]));
  const confirmed = new Map(current.map((memory) => [memory.memory_id, new Set<string>()]));
  const unrelated = new Set<string>();
  const key = (a: string, b: string): string => [a, b].sort().join('\0');
  const pairs = (resolution: MemoryResolutionResolveRecord, action: (from: string, to: string) => void): void => {
    for (const fromId of resolution.memory_ids) {
      for (const toId of resolution.memory_ids) {
        if (fromId !== toId) action(targetId(fromId), targetId(toId));
      }
    }
  };
  // A confirmed "unrelated" is an owner rejection of a link, even if an old
  // model-authored canonical link proposed it. Keep the raw edge for auditing.
  for (const resolution of resolutions) {
    if (resolution.relation === 'unrelated') pairs(resolution, (from, to) => unrelated.add(key(from, to)));
  }
  const link = (fromId: string, toId: string, ownerConfirmed = false): void => {
    const from = targetId(fromId);
    const to = targetId(toId);
    if (from === to || !activeIds.has(from) || !activeIds.has(to) || unrelated.has(key(from, to))) return;
    links.get(from)?.add(to);
    if (ownerConfirmed) confirmed.get(from)?.add(to);
  };

  // The full projected graph retains links already present in canonical/owner
  // content, for lookup and visualization. Those are NOT automatically
  // owner-approved Whisper background.
  for (const memory of byId.values()) {
    for (const linkedId of memory.linked_memory_ids ?? []) link(memory.memory_id, linkedId);
  }
  // Only explicit owner-confirmed "related" resolutions supply Whisper context.
  // Resolve historical/merged endpoints against the final current view, so a
  // review confirmed before a merge remains usable without copying records.
  for (const resolution of resolutions) {
    if (resolution.relation === 'related') pairs(resolution, (from, to) => link(from, to, true));
  }
  return current.map((memory) => {
    const { linked_memory_ids: _oldLinks, resolution_confirmed_related_memory_ids: _oldConfirmed, ...rest } = memory;
    const linkedIds = [...(links.get(memory.memory_id) ?? [])].sort();
    const confirmedIds = [...(confirmed.get(memory.memory_id) ?? [])].sort();
    return {
      ...rest,
      ...(linkedIds.length ? { linked_memory_ids: linkedIds } : {}),
      ...(confirmedIds.length ? { resolution_confirmed_related_memory_ids: confirmedIds } : {}),
    };
  });

}

export function materializeCurrentMemoryView(store: RelationshipMemoryStore): EffectiveMemoryRecord[] {
  const owner = new RelationshipMemoryOwnerControlPlane(store);
  return applyMemoryResolutions(owner.listEffective(), store.listActiveMemoryResolutions());
}

/** A review can act only on current, active memories. Historical records stay on disk. */
export function currentReviewableMemoryIds(store: RelationshipMemoryStore): Set<string> {
  return new Set(materializeCurrentMemoryView(store)
    .filter((memory) => memory.status === 'active')
    .map((memory) => memory.memory_id));
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

    const originalReview = this.store.getMaintenanceReview(id);
    if (originalReview && originalReview.status !== 'pending') {
      throw new Error('Maintenance review is not pending: ' + id);
    }
    const review = findProjectedReview(
      projectRelationReviewInbox(this.store, materializeCurrentMemoryView(this.store)), id,
    );
    if (!review) throw new Error('Review is not actionable in the current workspace: ' + id);
    if (review.kind !== 'relation') throw new Error('Maintenance review is not a relation review: ' + id);

    if (!MEMORY_RELATION_KINDS.includes(command.relation)) throw new Error(`unsupported relation: ${command.relation}`);
    const relation = command.relation;
    const targetMemoryId = optionalText(command.target_memory_id, 'target_memory_id');
    const ownerSummary = optionalText(command.owner_summary, 'owner_summary');
    const note = optionalText(command.note, 'note');
    const memoryIds = [...review.memory_ids].sort();
    if (memoryIds.length < 2) throw new Error('Review has fewer than two current memories; use dismiss_review for legacy malformed cards');

    for (const memoryId of memoryIds) {
      if (!this.store.getMemory(memoryId)) throw new Error(`Unknown canonical memory ID: ${memoryId}`);
    }
    const currentIds = currentReviewableMemoryIds(this.store);
    const staleId = memoryIds.find((memoryId) => !currentIds.has(memoryId));
    if (staleId) throw new Error(`Review references a memory that is no longer current and active: ${staleId}`);

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
        const overlaps = active.memory_ids.filter((memoryId) => memoryIds.includes(memoryId));
        if (overlaps.length === 0) continue;
        // A previously merged survivor is a new current memory, so it can join
        // another same-meaning family or become historical when preferences change.
        // Other overlapping structural decisions still require owner re-review.
        const extendsMergedCurrent = active.relation === 'same_meaning'
          && (relation === 'same_meaning' || relation === 'changed_over_time')
          && overlaps.length === 1 && overlaps[0] === active.target_memory_id;
        if (!extendsMergedCurrent) {
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
      original_memory_ids: review.original_memory_ids,
      recorded_at: this.now(),
      ...(targetMemoryId ? { target_memory_id: targetMemoryId } : {}),
      ...(ownerSummary ? { owner_summary: ownerSummary } : {}),
      ...(contexts ? { contexts } : {}),
      ...(note ? { note } : {}),
    };
    return this.store.appendMemoryResolution(record);
  }

  /** Dismiss a no-longer-needed candidate without falsely asserting 'unrelated'. */
  dismissReview(reviewId: string, note?: string): MaintenanceReviewRecord {
    const original = this.store.getMaintenanceReview(reviewId);
    if (original && original.status !== 'pending') throw new Error('Review is already closed: ' + reviewId);
    const review = original ?? findProjectedReview(
      projectRelationReviewInbox(this.store, materializeCurrentMemoryView(this.store)), reviewId,
    );
    if (!review) throw new Error('Unknown review: ' + reviewId);
    const record: MaintenanceReviewRecord = {
      ...review, memory_ids: [...(('original_memory_ids' in review
        ? review.original_memory_ids : review.memory_ids) as string[])],
      status: 'dismissed', recorded_at: this.now(),
      ...(note ? { resolution_note: note } : {}),
    };
    // Exclude derived UI-only fields from the append-only canonical review record.
    const { origin: _origin, original_memory_ids: _original, origin_review_ids: _origins,
      needs_recheck: _needs, ...stored } = record as MaintenanceReviewRecord & {
        origin?: string; original_memory_ids?: string[]; origin_review_ids?: string[]; needs_recheck?: boolean;
      };
    this.store.appendMaintenanceReview(stored);
    return stored;
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
