# Task 15 — Explicit recall latency instrumentation

## Scope

This task adds opt-in timing instrumentation to the explicit relationship-memory recall path only. It does not optimize retrieval, change ranking/filtering/truncation policy, add runtime dependencies, deploy anything, or call a real Letta/model/embedding provider.

The instrumentation is intended to answer the canary question: how much time is spent in local scanning/assembly versus the external query-embedding call.

## Enabling instrumentation

Instrumentation is **off by default**.

Enable it with:

```bash
RELATIONSHIP_MEMORY_RECALL_TIMING=1
```

Truthy values accepted by the implementation are `1`, `true`, `yes`, and `on` (case-insensitive after trimming).

By default, enabled events are emitted as one JSON object per line to `stderr`.

To write to a file instead:

```bash
RELATIONSHIP_MEMORY_RECALL_TIMING=1 \
RELATIONSHIP_MEMORY_RECALL_TIMING_FILE=/path/outside-the-store/recall-timing.jsonl
```

The file path must be an observability/log location, not the relationship-memory store directory. Instrumentation write failures are swallowed so recall behavior is not affected.

## Event shape and phases

Every event contains only non-content identifiers, timings, booleans, and counts:

- `schema_version`
- `event=relationship_memory_recall_timing`
- `recall_id`
- `phase`: `initial`, `expand_recall`, or `total`
- `segment`
- `duration_ms`
- segment-specific counts/booleans

No query text, memory contents, transcript text, or other user content is logged.

Measured segments are:

- `relationship_candidate_set_construction` — candidate construction, including store reads
- `relationship_lexical_scoring` — lexical scoring
- `semantic_query_embedding_external` — `rankExisting` query embedding provider call
- `semantic_local_vector_comparison` — cosine comparison against existing vectors
- `relationship_local_vector_comparison` — local hybrid-score combination
- `relationship_local_vector_sorting` — local ranked-result sorting
- `transcript_search_total` — transcript scan/search, with `scanned_file_count` and `parsed_line_count`
- `transcript_read_window` — transcript context-window read
- `fit_evidence_bundle_assembly` — evidence-bundle object assembly
- `fit_evidence_bundle_truncation` — fit/truncation pass, including before/after byte counts and reduction count
- `execute_recall_total` — end-to-end recall execution; includes `expansion_occurred`

The initial evidence bundle and an `expand_recall` evidence bundle use different `phase` values, so their scans/provider calls can be compared directly.

## Offline behavior coverage

Behavior tests cover:

- disabled instrumentation produces no timing file/output
- enabled instrumentation produces the required segments and initial/expand distinction
- enabled and disabled runs return byte-identical `RecallResult` values
- timing output does not contain query, memory, transcript, or hidden/user-content sentinels
- an unwritable timing target does not fail recall
- existing recall tests remain unchanged and continue to pass

A dedicated sample test executes a synthetic canonical store plus synthetic transcript data with a mock semantic provider; it performs an initial bundle and one expand call. No real service is contacted.

## Actual offline timing sample

The following lines were emitted by the synthetic/mock test in `PR offline CI` run `34049960540` at head `4640e72d80f020fa6443270400a94ff39a5e01eb`. These are actual measured values from that CI runner, not illustrative values. They are **not** representative of production provider latency.

```jsonl
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"relationship_candidate_set_construction","duration_ms":0.27814999999998236,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"relationship_lexical_scoring","duration_ms":0.1860110000000077,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"semantic_query_embedding_external","duration_ms":0.20974699999999302,"usable_document_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"semantic_local_vector_comparison","duration_ms":0.0670910000000049,"usable_document_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"transcript_search_total","duration_ms":5.021961999999974,"scanned_file_count":1,"parsed_line_count":2,"candidate_count":2}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"transcript_read_window","duration_ms":1.2268119999999954,"context_count":2,"before":2,"after":2}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"initial","segment":"fit_evidence_bundle_truncation","duration_ms":0.42887699999999995,"truncated":false,"reduction_steps":0,"bytes_before":2386,"bytes_after":2386}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"expand_recall","segment":"semantic_query_embedding_external","duration_ms":0.028974000000005162,"usable_document_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"expand_recall","segment":"transcript_search_total","duration_ms":0.8982869999999821,"scanned_file_count":1,"parsed_line_count":2,"candidate_count":2}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-task15-offline-sample","phase":"total","segment":"execute_recall_total","duration_ms":15.299084999999991,"expansion_occurred":true}
```

The mock provider returns immediately, so the sample is useful only to prove segment production and phase separation. The real canary is expected to show a materially different `semantic_query_embedding_external` duration.

## Validation before report commit

At head `4640e72d80f020fa6443270400a94ff39a5e01eb`:

- `npm run test:ci`: PASS — 53 test files, 468 tests
- `npm run typecheck`: PASS
- `PR offline CI / offline-ci`: SUCCESS — run `34049960540`

A final exact-head offline-ci run is required after this report commit; its final head/run are returned with the task handoff.

## Optimization opportunities observed but not implemented

No optimization was performed in this task. The measurement surface makes these existing candidates directly measurable:

1. `transcriptSearch` can enumerate up to 1000 transcript files and parse their JSONL rows; an initial evidence bundle and `expand_recall` can therefore repeat the scan.
2. `rankExisting` waits synchronously for the external query embedding provider, currently behind its existing timeout boundary.
3. Evidence-bundle transcript windows require subsequent transcript reads after search hits are selected.

Whether any of these should be optimized is deliberately left to a later task after a real canary provides production-scale numbers.

## Remaining validation

The only intentionally deferred measurement is the real online canary after embedding quota is available. This task does not claim any production latency result.