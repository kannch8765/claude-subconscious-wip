# Task 18 — Async reviewed-memory continuity and bounded related whispers

Scope: live asynchronous Subcon only. No sync-foreground, explicit Recall MCP, UI, production, or schema migrations in this task.

## Behavior

- Canonical genesis, historical evidence, owner revisions and all accepted/undone relation resolutions remain append-only. They remain available for audits, undo, analytics and future graph visualization.
- Maintenance search in the async live worker uses the resolved current view, like foreground recall. Merged sources and superseded/uncertain facts are no longer independent candidates. Owner edits override original wording. Maintenance continues refreshing semantic document vectors for new memories; foreground search remains read-only.
- Suggestions and confirmation require current active memory IDs. Older proposals cannot resolve against deactivated or hidden sources without re-reviewing the current records. Original review history is unchanged.
- A merged same-meaning survivor may enter another later same-meaning review. Its evidence family accumulates across merges and each merge remains independently undoable.
- Direct related edges are projected against final merge targets after active resolutions are read. Historical edges remain stored. Inactive or hidden endpoints disappear from the current graph. No transitive related edges are inferred.
- Subcon continues to choose one primary memory and 1–3 primary quote snippets, calling the existing deliver_whisper tool. Only in async mode, the delivery script automatically adds summaries of directly linked current memories, without a second LLM call or an additional tool action. Neighbors have no quote snippets and are not marked as previously delivered primary memories.
- Associated summaries are ranked lexically against the current topic, deduplicated, and fit within a short delivery character budget. There is no limit imposed on database relations or on the size of a memory's graph neighborhood. The script does not traverse neighbors of neighbors.

## Why this shape

The current memory is a projection, not a second copy of the canonical records. The same reviewed relation graph serves recall and future visualization. The automatic whisper only materializes a bounded direct neighborhood.

## Verification

Regression coverage checks end-to-end async search and whisper delivery; related A—C—D chains with merged A+B and no recursive D; sequential same-meaning merges and undo; cached foreground vs refreshable maintenance semantics; inactive, missing, session-known and duplicate filtering; and preserved original evidence/history.

Deployment is deferred pending PR review and controlled release verification.
