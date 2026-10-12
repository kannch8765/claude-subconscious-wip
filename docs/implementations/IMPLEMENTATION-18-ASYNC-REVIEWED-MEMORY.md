# Task 18 — Async reviewed-memory continuity and bounded related whispers

Scope: live asynchronous Subcon only. No sync-foreground, explicit Recall MCP, UI, production, or schema migrations in this task.

## Behavior

- Canonical genesis, historical evidence, owner revisions and all accepted/undone relation resolutions remain append-only. They remain available for audits, undo, analytics and future graph visualization.
- Maintenance search in the async live worker uses the resolved current view, like foreground recall. Merged sources and superseded/uncertain facts are no longer independent candidates. Owner edits override original wording. Maintenance continues refreshing semantic document vectors for new memories; foreground search remains read-only.
- Suggestions and confirmation require current active memory IDs. Older proposals cannot resolve against deactivated or hidden sources without re-reviewing the current records. Original review history is unchanged.
- A merged same-meaning survivor may enter another later same-meaning review. Its evidence family accumulates across merges and each merge remains independently undoable.
- Direct related edges are projected against final merge targets after active resolutions are read. Historical edges remain stored. Inactive or hidden endpoints disappear from the current graph. No transitive related edges are inferred. Owner-confirmed unrelated decisions suppress even old model-authored edges from the current projection, while the underlying source is retained for audit/undo.
- Subcon continues to choose one primary memory and 1–3 primary quote snippets, calling the existing deliver_whisper tool. Only in async mode, the delivery script automatically adds summaries of directly linked current memories, without a second LLM call or an additional tool action. Neighbors have no quote snippets and are not marked as previously delivered primary memories.
- Associated summaries are ranked lexically against the current topic, deduplicated, and fit within a short delivery character budget. There is no limit imposed on database relations or on the size of a memory's graph neighborhood. The script does not traverse neighbors of neighbors.

- Pending Review cards on the asynchronous owner-control surface are filtered through the same current-active memory predicate used for suggestions and resolution. Stale cards are kept in the immutable audit history but no longer occupy the actionable queue; undo can restore their visibility. Status reports actionable pending and stale counts separately.

## Related Top-2 selection (async only)

- Once Subcon selects the main memory, the existing delivery tool reuses the compact `foreground_recall` query that returned that memory. The script falls back to the most recent user message only when no search query is available.
- Candidate set is the owner's explicitly **confirmed related** current active **direct** linked neighbors only. Canonical/model-authored links are retained in the full graph but are not trusted as owner-confirmed whisper context. The original relation network is retained, with no transitive expansion and no limit on how many links may be stored.
- The reranker uses the same Latin/CJK tokenizer as the existing lexical search, with NFKC normalization. It calculates query-term coverage, similarity with the main memory, and MMR redundancy against the main and already selected neighbors. Weight: 0.75 relevance / 0.25 redundancy. No embedding/model request, no separate tool.
- Selection is greedy with deterministic tie-breaks, `top_k=2`, and the existing 420-character related-text budget. If some neighbor has lexical support for this topic, zero-signal neighbors do not fill unused slots; if none matches textually, the algorithm falls back to owner-confirmed direct relations.
- Only neighbors' current summaries are inserted (never their original quotes). They are not recorded as primary memories already surfaced during the session.
- Offline tests compare near-duplicate vs complementary neighbors, normalization for Japanese and full-width Latin text, large-degree graphs, non-recursive expansion and query reuse.

## Oct 12 review: relation provenance and honest evaluation scope

The canonical `linked_memory_ids` field was already populated by automated writes before owner reviews. It is not a mark of owner confirmation. Review found 588 canonical memories with initial links, but only 22 active owner-confirmed related resolutions (33 approved pairs) in the read-only workspace snapshot. The corrected projection distinguishes general `linked_memory_ids` (full graph for analysis) from computed `resolution_confirmed_related_memory_ids` (eligible for Whisper). No canonical records or persisted relations are rewritten. The owner may undo approval or confirm unrelated, and Whisper updates accordingly.

The earlier A/B proxy comparison across 617 current memories with *any* links is only a stress test for ranking behavior; it **does not** estimate live gains on owner-confirmed relations. Under the corrected eligibility, 46 current active memories have approved related neighbors, 16 have at least 2, and 4 have at least 3. Future effectiveness claims should evaluate that confirmed subset and actual query context.

## Why this shape

The current memory is a projection, not a second copy of the canonical records. The same reviewed relation graph serves recall and future visualization. The automatic whisper only materializes a bounded direct neighborhood.

## Verification

Regression coverage checks end-to-end async search and whisper delivery; related A—C—D chains with merged A+B and no recursive D; sequential same-meaning merges and undo; cached foreground vs refreshable maintenance semantics; inactive, missing, session-known and duplicate filtering; and preserved original evidence/history.

Deployment is deferred pending PR review and controlled release verification.
