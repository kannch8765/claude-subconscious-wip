import type { EffectiveMemoryRecord, MemoryResolutionResolveRecord } from './schema/index.js';

export interface ConflictingOwnerLink {
  memory_ids: [string, string];
  related_review_ids: string[];
  related_resolution_ids: string[];
  unrelated_review_ids: string[];
  unrelated_resolution_ids: string[];
}

/**
 * Owner link decisions are immutable; opposite decisions cannot be silently
 * collapsed when two canonical source families are merged.
 * Optionally preview one same-meaning merge before appending its resolution.
 * Time: O(N + R * K^2), K = bounded review member count.
 */
export function findConflictingOwnerLinks(
  current: readonly EffectiveMemoryRecord[],
  resolutions: readonly MemoryResolutionResolveRecord[],
  proposedMerge?: { memory_ids: readonly string[]; target_memory_id: string },
): ConflictingOwnerLink[] {
  const currentIdOf = new Map<string, string>();
  for (const memory of current) {
    if (memory.status !== 'active') continue;
    for (const source of memory.resolution_source_memory_ids ?? [memory.memory_id]) {
      currentIdOf.set(source, memory.memory_id);
    }
  }
  const merging = new Set(proposedMerge?.memory_ids ?? []);
  const mapped = (id: string): string | undefined => {
    const effective = currentIdOf.get(id);
    if (!effective) return undefined;
    return merging.has(effective) ? proposedMerge?.target_memory_id : effective;
  };
  const pairs = new Map<string, {
    ids: [string, string]; related: Set<string>; unrelated: Set<string>;
    relatedResolutions: Set<string>; unrelatedResolutions: Set<string>;
  }>();
  for (const resolution of resolutions) {
    if (resolution.reconciles_resolution_ids?.length || (resolution.relation !== 'related' && resolution.relation !== 'unrelated')) continue;
    for (let i = 0; i < resolution.memory_ids.length; i++) {
      for (let j = i + 1; j < resolution.memory_ids.length; j++) {
        const left = mapped(resolution.memory_ids[i]);
        const right = mapped(resolution.memory_ids[j]);
        if (!left || !right || left === right) continue;
        const ids = [left, right].sort() as [string, string];
        const key = JSON.stringify(ids);
        const entry = pairs.get(key) ?? { ids, related: new Set<string>(),
          unrelated: new Set<string>(), relatedResolutions: new Set<string>(),
          unrelatedResolutions: new Set<string>() };
        entry[resolution.relation].add(resolution.review_id);
        if (resolution.relation === 'related') entry.relatedResolutions.add(resolution.resolution_id);
        else entry.unrelatedResolutions.add(resolution.resolution_id);
        pairs.set(key, entry);
      }
    }
  }
  return [...pairs.values()]
    .filter((pair) => pair.related.size > 0 && pair.unrelated.size > 0)
    .map((pair) => ({
      memory_ids: pair.ids,
      related_review_ids: [...pair.related].sort(),
      related_resolution_ids: [...pair.relatedResolutions].sort(),
      unrelated_review_ids: [...pair.unrelated].sort(),
      unrelated_resolution_ids: [...pair.unrelatedResolutions].sort(),
    }))
    .sort((a, b) => JSON.stringify(a.memory_ids).localeCompare(JSON.stringify(b.memory_ids)));
}

/** Reconciliation is effective only while the exact old decisions still collide. */
export function validOwnerConflictReconciliation(
  conflict: ConflictingOwnerLink,
  resolutions: readonly MemoryResolutionResolveRecord[],
): MemoryResolutionResolveRecord | undefined {
  const sourceIds = [...conflict.related_resolution_ids, ...conflict.unrelated_resolution_ids].sort();
  return [...resolutions].reverse().find((resolution) =>
    (resolution.relation === 'related' || resolution.relation === 'unrelated')
    && JSON.stringify([...(resolution.reconciles_resolution_ids ?? [])].sort()) === JSON.stringify(sourceIds)
    && JSON.stringify([...resolution.memory_ids].sort()) === JSON.stringify(conflict.memory_ids));
}
