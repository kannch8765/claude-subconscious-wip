import type { RelationshipMemoryStore } from './store/index.js';
import { RelationshipMemoryOwnerControlPlane } from './owner/index.js';
import { materializeCurrentMemoryView } from './resolution/index.js';
import { canonicalLinkReviewObservations, projectRelationReviewInbox } from './review_inbox.js';

/**
 * Counts-only, entirely read-only release preflight.
 * Never return IDs, summaries, snippets, Feel, timestamps, or review reasons.
 * Projection costs O(N + R*K²); no writes, models, or embedding refreshes.
 */
export function auditEffectiveReviewCounts(store: RelationshipMemoryStore) {
  const canonical = new RelationshipMemoryOwnerControlPlane(store).listEffective();
  const current = materializeCurrentMemoryView(store);
  const inbox = projectRelationReviewInbox(store, current);
  const active = store.listActiveMemoryResolutions();
  const rawReviews = store.listMaintenanceReviews();
  const byOrigin = { remember_link: 0, maintenance_suggest: 0, owner_conflict: 0 };
  for (const review of inbox.reviews) byOrigin[review.origin]++;

  const families = current.filter((memory) =>
    (memory.resolution_source_memory_ids?.length ?? 1) > 1,
  ).length;
  const canonicalActive = canonical.filter((memory) => memory.status === 'active').length;
  const effectiveActive = current.filter((memory) => memory.status === 'active').length;
  const activeSameMeaning = active.filter((record) => record.relation === 'same_meaning').length;

  return {
    schema_version: 1,
    canonical: { total: canonical.length, active: canonicalActive, inactive: canonical.length - canonicalActive },
    effective: {
      total: current.length, active: effectiveActive, inactive: current.length - effectiveActive,
      projected_out_active: Math.max(0, canonicalActive - effectiveActive),
      merged_families: families,
    },
    automatic_links: { unique_original_observations: canonicalLinkReviewObservations(store).length },
    review: {
      actionable: inbox.reviews.length,
      actionable_by_origin: byOrigin,
      suspended: inbox.suspended, satisfied: inbox.satisfied, deduplicated: inbox.deduplicated,
      stored_pending: rawReviews.filter((review) => review.status === 'pending').length,
    },
    resolution: { active: active.length, same_meaning: activeSameMeaning },
  };
}
