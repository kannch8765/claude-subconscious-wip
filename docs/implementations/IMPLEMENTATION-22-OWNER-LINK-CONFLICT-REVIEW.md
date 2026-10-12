# Task 22 · Owner relation collision review (Draft)

This PR is stacked on Subcon PR #128 and paired with Telegram PR #32. No production deployment.

## Desired behavior

- A-C was owner-confirmed Related; B-C was owner-confirmed Unrelated. The owner may still confirm A+B as Same Meaning. Do not force an Undo of otherwise legitimate factual merges.
- Reproject both historical decisions onto the effective pair after the merge. A contradictory pair is not an owner-confirmed Related Whisper neighbor.
- The Unified Review Inbox produces one stable virtual owner_conflict candidate with the exact original resolution IDs, ahead of the older automatically inferred Link backlog.
- The owner selects Related or Unrelated again. This records a separate append-only reconciliation, preserves both original owner decisions and supports Undo.
- Undo reconciliation restores the pending conflict. Undo A+B restores the original distinct A-C / B-C decisions and makes the reconciliation inert while the old source families no longer collide.
- Telegram displays the conflict immediately after a Same Meaning merge and offers only the two relevant owner decisions. Normal Subcon tool calls, Memory/Feel origin, and canonical records remain unchanged.
- Both sync and async Whisper recheck that the selected memory remains current and active before queueing; invalidated sync Whisper releases its normal no_whisper checkpoint.
- A previous-stage Kohaku Feel is eligible as explicitly dated historical provenance for changed_over_time Whisper, but is not part of the current preference retrieval representation.

## Algorithm

Pure owner relation conflict projection computes identity aliases from effective source families and colliding owner resolution IDs. In-memory grouping has O(N + R*K^2) complexity with bounded review size K. Never query an extra LLM or embedding model, never rewrite historical pointers, and never create a second persistent Review database.

## Acceptance

- Related / Unrelated collision after Same Meaning merge: one virtual pending card, neither relation silently chosen.
- Related or Unrelated reconciliation changes only current relation projection, keeps old decisions, and supports independent Undo.
- Undo merge deactivates the scoped reconciliation even if its historical record remains active.
- Owner conflict Review is presented before old inferred Link backlog, and Telegram disallows Dismiss and structural merge buttons.
- Stale sync or async model-selected memory is not delivered after owner review changes visibility.
- Historical-stage Feel remains dated and verbatim (or a clearly labeled bounded excerpt).

Use GitHub offline-ci and Telegram unit tests. Do not merge/deploy until stacked dependencies and release sequencing are reviewed.
