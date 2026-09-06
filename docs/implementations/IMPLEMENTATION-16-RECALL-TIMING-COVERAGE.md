# Task 16 — Recall timing coverage repair

## Scope

This task fixes the Task 15 observability failure mode where `emitRecallTimingSegment()` silently returned when no `AsyncLocalStorage` recall timing context was present.

The fix is intentionally limited to instrumentation behavior and tests. It does not change retrieval, ranking, filtering, truncation, recall error handling, store locking/writes, dependencies, deployment, or any production data/service.

Task 16 is based on Task 15 PR #101 exact head `2f73fc2530bc1b51170faf8d9b4ee054d30a7ac6`.

## Root cause

Task 15 established timing context inside `evidenceBundle()` with `withRecallTimingContext()`. That covered bundle-first `initial` and `expand_recall` work.

The legacy/multi-round `buildRecallTools()` path invokes `relationship_memory_search`, `transcript_search`, and `transcript_read` outside that context. Task 15's emitter therefore did this:

```ts
const context = recallTimingContext();
if (!context) return;
```

The result was silent loss: the recall still emitted `execute_recall_total`, but segment events from context-free call sites disappeared with no warning.

## Fix

When timing is enabled and a segment is emitted without timing context, the emitter now writes an explicit fallback event instead of returning silently.

The new phase is:

- `unscoped` — the segment was measured, but no ALS recall timing context was available at the emission site.

An `unscoped` event has:

- `recall_id: "unscoped"`
- `phase: "unscoped"`
- `context_missing: true`
- a process-local monotonically increasing `event_index`
- the original segment's duration and count fields

Existing phases are unchanged:

- `initial` — bundle-first initial evidence bundle
- `expand_recall` — bundle-first expansion evidence bundle
- `total` — end-to-end `executeRecall`

Instrumentation remains default-off. `emitRecallTimingSegment()` returns before incrementing `event_index` or performing output work when `RELATIONSHIP_MEMORY_RECALL_TIMING` is disabled.

No query text, memory content, transcript content, or other user content is added to fallback events.

## Pre-fix failing regression evidence

The regression test was first committed without the fix at:

- commit: `afb8136bd3a5fc8065d3b26c990b32a0e6f7ecce`
- `PR offline CI` run: `34050734791`
- run head SHA: `afb8136bd3a5fc8065d3b26c990b32a0e6f7ecce`
- result: **FAILURE** in `npm run test:ci`

The test exercised `buildRecallTools()` with two `relationship_memory_search` calls, one `transcript_search`, and one `transcript_read`. Before the fix, its complete timing output was only:

```jsonl
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task16-multiround","phase":"total","segment":"execute_recall_total","duration_ms":11.946926000000019,"expansion_occurred":false}
```

Vitest then failed because there were no segmented multi-round events:

```text
FAIL relationship-memory/tests/recall-timing-coverage.test.ts
AssertionError: expected [] to include 'relationship_memory_search:relationsh…'
Test Files 1 failed | 53 passed (54)
Tests      1 failed | 468 passed (469)
```

The first red version of the new Task 16 test expected a call-scoped representation to prove the events were absent. The final implementation deliberately chose the smaller equivalent `unscoped` fallback design instead; the final Task 16 test asserts the required behavior directly: non-total segments must exist, context absence must be explicit, repeated calls must be visibly separate, and output must remain content-free. No Task 15 test assertion was changed.

## Actual multi-round offline sample after the fix

The following lines are actual output from synthetic store/transcript data with a mock semantic provider in `PR offline CI` run `34051051016` at head `7bc157eb08a5a53494f6b3ca55870559ecf46df2`. They are measured CI-run values, not illustrative values and not production latency measurements.

```jsonl
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"relationship_candidate_set_construction","duration_ms":0.6764279999999872,"context_missing":true,"event_index":1,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"relationship_lexical_scoring","duration_ms":0.683591999999976,"context_missing":true,"event_index":2,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"relationship_local_vector_sorting","duration_ms":0.01564899999999625,"context_missing":true,"event_index":3,"ranked_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"relationship_candidate_set_construction","duration_ms":0.1388780000000338,"context_missing":true,"event_index":4,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"relationship_lexical_scoring","duration_ms":0.14356700000001865,"context_missing":true,"event_index":5,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"relationship_local_vector_sorting","duration_ms":0.011521000000016102,"context_missing":true,"event_index":6,"ranked_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"transcript_search_total","duration_ms":4.831490000000031,"context_missing":true,"event_index":7,"scanned_file_count":1,"parsed_line_count":2,"candidate_count":2}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"unscoped","phase":"unscoped","segment":"transcript_read_window","duration_ms":1.1778520000000299,"context_missing":true,"event_index":8,"context_count":2,"before":1,"after":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task16-multiround","phase":"total","segment":"execute_recall_total","duration_ms":12.219942000000003,"expansion_occurred":false}
```

The two `relationship_candidate_set_construction` events at `event_index` 1 and 4 visibly establish that two separate relationship-search invocations occurred.

## Repeated multi-round calls

Task 16 does not invent a synthetic recall/tool-call context when none exists. Instead, every context-free event gets a unique `event_index`.

For `relationship_memory_search`, each invocation emits one `relationship_candidate_set_construction` event, so repeated calls are individually countable and distinguishable by the unique index of those start events. In the sample above, indices 1 and 4 are the two calls.

The downstream events are not explicitly grouped under a shared call ID. For sequential tool calls, JSONL order makes the segments usable for the intended canary diagnosis. If concurrent context-free tool calls are introduced, exact grouping of their downstream segments would require an explicit tool-call context and is listed below as a known correlation gap.

## Path × segment coverage after Task 16

| Recall path | Phase in log | Segments verified/available | Notes |
| --- | --- | --- | --- |
| Bundle-first initial `evidenceBundle()` | `initial` | candidate construction, lexical scoring, `semantic_query_embedding_external`, semantic/local vector comparison, relationship local comparison/sort, transcript search/read, bundle assembly/truncation | Task 15 behavior unchanged; real `recall_id` retained. |
| Bundle-first `expand_recall` | `expand_recall` | same bundle segments as initial | Task 15 behavior unchanged; initial vs expansion remains explicit. |
| Multi-round `buildRecallTools()` → `relationship_memory_search` | `unscoped` | candidate construction, lexical scoring, relationship local sorting | These existing segment emissions are no longer silently lost. |
| Multi-round `buildRecallTools()` → `transcript_search` | `unscoped` | `transcript_search_total`, scanned-file count, parsed-line count | Verified by Task 16 synthetic test. |
| Multi-round `buildRecallTools()` → `transcript_read` | `unscoped` | `transcript_read_window` and context counts | Verified by Task 16 synthetic test. |
| Direct session segment emission outside timing context | `unscoped` | any call to `emitRecallTimingSegment()` | Dedicated fallback behavior test verifies it is visible rather than dropped. |
| End-to-end `executeRecall()` | `total` | `execute_recall_total`, `expansion_occurred` | Does not depend on ALS context; unchanged. |

## Known coverage / correlation gaps

The audit found two limitations that are now documented rather than hidden:

1. **Multi-round semantic `rank()` does not currently have Task 15's query-embedding/vector sub-segments.** `buildRecallTools().relationship_memory_search` calls `relationshipMemorySearchHybrid()`, which calls `SemanticRetriever.rank()`. Task 15 added `semantic_query_embedding_external` and `semantic_local_vector_comparison` around `FileBackedSemanticRetriever.rankExisting()`, used by the bundle-first read-only path, not around `rank()`. Therefore the multi-round sample correctly has candidate/lexical/sort events but no separate query-embedding/vector event. This is a pre-existing instrumentation-coverage gap, not an ALS silent-drop after this fix. Task 16 does not alter retrieval code to broaden measurement scope.
2. **`unscoped` events do not have a shared tool-call correlation ID.** `event_index` makes every event unique and makes repeated relationship calls countable by their candidate-start events, but concurrent context-free tool calls could interleave downstream lines. An explicit tool-call timing context would be required for exact concurrent grouping.

No enabled call to `emitRecallTimingSegment()` is silently discarded for missing ALS context after this change. This does **not** mean every internal operation has a timing call; the `rank()` gap above is the known example.

## Tests

Task 16 adds behavioral tests only; there are no source-string assertions.

The new tests verify:

- the pre-fix multi-round path no longer collapses to total-only timing;
- two repeated `relationship_memory_search` calls produce two distinct candidate-start events;
- `relationship_memory_search`, `transcript_search`, and `transcript_read` segments are present;
- missing context produces explicit `unscoped` / `context_missing:true` events;
- fallback events have unique `event_index` values;
- output does not contain query, memory, evidence, feel, summary, event, or transcript sentinel content.

Task 15's existing tests and their assertions were left untouched, including disabled-output, enabled-vs-disabled `RecallResult` identity, redaction, and write-failure safety tests.

Validation before this report commit at head `7bc157eb08a5a53494f6b3ca55870559ecf46df2`:

- `npm run test:ci`: PASS — 54 test files, 470 tests
- `npm run typecheck`: PASS
- `PR offline CI / offline-ci`: SUCCESS — run `34051051016`

A new exact-head `offline-ci` run after this report commit is required and is returned in the final handoff.

## Enablement

Task 15 enablement remains unchanged:

```bash
RELATIONSHIP_MEMORY_RECALL_TIMING=1
```

Optional file output remains:

```bash
RELATIONSHIP_MEMORY_RECALL_TIMING=1 \
RELATIONSHIP_MEMORY_RECALL_TIMING_FILE=/path/outside-the-store/recall-timing.jsonl
```

The instrumentation remains disabled by default and does not perform timing output I/O when disabled.

## Remaining item

The real provider canary remains intentionally unexecuted. No VPS, deployment, real Letta/model/embedding provider, or production relationship-memory data was accessed in Task 16.
