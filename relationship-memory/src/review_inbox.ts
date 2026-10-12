import type { EffectiveMemoryRecord, MaintenanceReviewRecord, MemoryRelationKind } from './schema/index.js';
import { RelationshipMemoryStore, stableId } from './store/index.js';

export interface ProjectedRelationReview extends MaintenanceReviewRecord {
  origin: 'remember_link' | 'maintenance_suggest';
  original_memory_ids: string[];
  origin_review_ids: string[];
  needs_recheck?: boolean;
}
export interface ProjectedReviewInbox {
  reviews: ProjectedRelationReview[];
  suspended: number;
  satisfied: number;
  deduplicated: number;
}
const key = (ids: readonly string[]) => [...new Set(ids)].sort().join('|');

/** Stable virtual records for original Remember links, without canonical mutations. */
export function canonicalLinkReviewObservations(store: RelationshipMemoryStore): MaintenanceReviewRecord[] {
  const seen = new Set<string>();
  const result: MaintenanceReviewRecord[] = [];
  for (const memory of store.listMemories()) {
    for (const linked of memory.linked_memory_ids ?? []) {
      if (linked === memory.memory_id) continue;
      const ids = [memory.memory_id, linked].sort();
      const pair = key(ids);
      if (seen.has(pair)) continue;
      seen.add(pair);
      result.push({ schema_version: 1,
        review_id: stableId('maintenance_link_review', { subject_id: store.subjectId, memory_ids: ids }),
        subject_id: store.subjectId, kind: 'relation', memory_ids: ids,
        reason: 'Remember 自动 Link（尚未分类）', status: 'pending',
        created_at: memory.created_at, recorded_at: memory.created_at });
    }
  }
  return result;
}

/** Read-only owner review projection: no canonical/review history is rewritten. */
export function projectRelationReviewInbox(
  store: RelationshipMemoryStore,
  current: readonly EffectiveMemoryRecord[],
): ProjectedReviewInbox {
  const currentId = new Map<string, string>();
  for (const memory of current) {
    if (memory.status !== 'active') continue;
    for (const source of memory.resolution_source_memory_ids ?? [memory.memory_id]) currentId.set(source, memory.memory_id);
  }
  const project = (ids: readonly string[]): string[] | undefined => {
    const mapped = ids.map((id) => currentId.get(id));
    return mapped.some((id) => !id) ? undefined : [...new Set(mapped as string[])].sort();
  };
  const stored = store.listMaintenanceReviews();
  const byId = new Map(stored.map((item) => [item.review_id, item]));
  const active = store.listActiveMemoryResolutions();
  const resolvedIds = new Set(active.map((item) => item.review_id));
  const decisions = new Map<string, Set<MemoryRelationKind>>();
  for (const resolution of active) {
    const members = project(resolution.memory_ids);
    if (!members) continue;
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        const pair = key([members[i], members[j]]);
        const kinds = decisions.get(pair) ?? new Set<MemoryRelationKind>();
        kinds.add(resolution.relation);
        decisions.set(pair, kinds);
      }
  }
  // A manual dismissal closes one observation, not a semantic edge.
  // Only an explicit owner resolution may settle another source's suggestion.

  const groups = new Map<string, ProjectedRelationReview[]>();
  let suspended = 0, satisfied = 0;
  const add = (record: MaintenanceReviewRecord, origin: ProjectedRelationReview['origin']): void => {
    if (record.kind !== 'relation' || record.status !== 'pending') return;
    const members = project(record.memory_ids);
    if (!members) { suspended++; return; }
    if (members.length < 2) {
      if (record.memory_ids.length >= 2 || origin === 'remember_link') { satisfied++; return; }
      // Legacy malformed one-member suggestions are visible for cleanup,
      // never silently elevated to a semantic owner resolution.
      const legacy = groups.get(key(members)) ?? [];
      legacy.push({ ...record, memory_ids: members,
        original_memory_ids: [...record.memory_ids], origin_review_ids: [record.review_id],
        origin, needs_recheck: true });
      groups.set(key(members), legacy);
      return;
    }
    const pairs: string[] = [];
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        pairs.push(key([members[i], members[j]]));
    const observed = pairs.map((pair) => decisions.get(pair) ?? new Set<MemoryRelationKind>());
    const covered = pairs.every((_pair, i) => record.suggested_relation
      ? observed[i].has(record.suggested_relation) : observed[i].size > 0);
    if (covered) { satisfied++; return; }
    const needsRecheck = observed.some((relations) => relations.size > 1
      || (relations.size > 0 && record.suggested_relation && !relations.has(record.suggested_relation)));
    const projected: ProjectedRelationReview = { ...record, memory_ids: members,
      original_memory_ids: [...record.memory_ids], origin_review_ids: [record.review_id],
      origin, ...(needsRecheck ? { needs_recheck: true } : {}) };
    const list = groups.get(key(members)) ?? [];
    list.push(projected);
    groups.set(key(members), list);
  };
  for (const review of stored) add(review, 'maintenance_suggest');
  for (const observation of canonicalLinkReviewObservations(store)) {
    if (byId.has(observation.review_id) || resolvedIds.has(observation.review_id)) continue;
    add(observation, 'remember_link');
  }
  const reviews: ProjectedRelationReview[] = [];
  let deduplicated = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => (a.origin === 'maintenance_suggest' ? 0 : 1)
      - (b.origin === 'maintenance_suggest' ? 0 : 1)
      || a.created_at.localeCompare(b.created_at) || a.review_id.localeCompare(b.review_id));
    const original = [...new Set(group.flatMap((entry) => entry.original_memory_ids))].sort();
    reviews.push({ ...group[0], original_memory_ids: original,
      origin_review_ids: [...new Set(group.flatMap((entry) => entry.origin_review_ids))],
      ...(group.some((entry) => entry.needs_recheck) ? { needs_recheck: true } : {}) });
    deduplicated += group.length - 1;
  }
  reviews.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.review_id.localeCompare(b.review_id));
  return { reviews, suspended, satisfied, deduplicated };
}
export const findProjectedReview = (inbox: ProjectedReviewInbox, id: string) =>
  inbox.reviews.find((review) => review.origin_review_ids.includes(id));
