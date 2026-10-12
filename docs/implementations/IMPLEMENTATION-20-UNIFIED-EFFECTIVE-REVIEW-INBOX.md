# Task 20 · Unified Effective-Memory Review Inbox (Draft)

This work is based on Draft PR #125 and is independent of the transport-only formatter in Draft PR #126. Neither project is deployed by this task.

## What the user sees

- Subcon still writes canonical memories normally. Its linked_memory_ids are **unclassified relation observations**. No extra Agent tool call is required to get a Review card.
- Subcon's explicit suggest_memory_relation remains the classified source (relation + reason).
- The owner queue reads both sources in one effective-memory Review projection and attaches origin=remember_link or origin=maintenance_suggest for Telegram presentation. One current pair means one card, even with multiple origin observations.
- The existing memory_search maintenance/current workspace remains the only candidate search that Subcon sees.
- A newly remembered link emits a relation_review activity for Telegram. Historical links are **virtual, read-only candidates** surfaced through list_pending_reviews; do not blast hundreds of Telegram notifications on deployment.
- An existing pending A+B+C same_meaning candidate, after owner resolves A+B→A, is displayed as A+C and can be resolved with the original review_id. Any hidden B source evidence is retained.
- If all pending members resolve to the same current family, the proposal is satisfied by existing owner decisions and disappears from the actionable queue. Original events remain intact. Undo recomputes the group.
- A new dismiss_review owner action closes a redundant or invalid pending candidate without asserting 'unrelated' and without modifying original canonical memory. It is intentionally different from resolve_review(relation=unrelated).

## No data migration

Existing canonical links are adapted to stable virtual observation IDs computed from their original unordered canonical pair and subject. There is no new JSONL store, no source record rewrite, and no scheduled backfill. Resolutions store current effective memory_ids plus original_memory_ids for audit. On every owner resolution and undo, the mapping is recomputed from effective source families.

Review grouping is by current unordered effective memory ID set, while each source retains an independent stable origin_review_id. Historical raw review IDs remain valid for submission even if grouped under a different preferred display card.

## Limits and follow-up

- Only same_meaning creates identity aliasing. Time changes, contexts and conflicts do not manufacture same-meaning aliases.
- Existing owner-confirmed categories are consulted before opening an unclassified link candidate. If an old decision covers the proposed current pair and category, the observation is already satisfied. Incompatible categories flag needs_recheck; do not silently classify a raw link as Related.
- A malformed legacy one-member Review remains visible, flagged needs_recheck, for manual dismiss rather than becoming an invalid semantic resolution.
- Telegram's receiving/rendering client may need to adopt optional origin / omitted suggested_relation and expose dismiss_review. The event producer and owner CLI are implemented here; the separate bot/UI consumer must be verified before live deployment.
- No rewrite of canonical evidence, no new model invocation, no sync foreground additions, no production mutation.
- The current overlay projects on demand; at the current dataset size O(N+R+E) scan per inbox view is simpler and safer than partial incremental cache invalidation. Avoid nested per-memory filesystem scans.
- Owner decisions contradicted by merging two previously independent families require an explicit conflict-aware inbox workflow and must not be asserted as definite Related context; this remains an edge-case release gate for PR #125.

## Verification

Run npm run typecheck, full vitest, and the focused suites effective-review-inbox.test.ts, owner_memory_review.test.ts, live_memory_maintenance_review.test.ts, subcon_visibility_mirror.test.ts.

Required scenarios: A+B/C partial collapse and Undo; reverse canonical link dedupe; Link+Suggest unification; historical virtual link pointer migration; fully satisfied proposals; manual dismissal distinct from unrelated.
