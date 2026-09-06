# Task 15 — Explicit recall latency instrumentation

## Scope

This task adds measurement only to the bundle-first explicit recall path. It does not change retrieval ranking, filtering, evidence limits, truncation, error handling, store mutation behavior, or any recall return structure. No performance optimization was implemented and no new runtime dependency was added.

The instrumentation is opt-in and uses a monotonic clock (`performance.now()`).

## Enablement

Instrumentation is disabled by default.

```bash
RELATIONSHIP_MEMORY_RECALL_TIMING=1
```

When enabled, JSON Lines are written to stderr by default. To write to a dedicated file instead:

```bash
RELATIONSHIP_MEMORY_RECALL_TIMING=1 \
RELATIONSHIP_MEMORY_RECALL_TIMING_FILE=/path/outside/the/store/recall-timing.jsonl
```

`RELATIONSHIP_MEMORY_RECALL_TIMING` also accepts `true`, `yes`, or `on` (case-insensitive). A configured output path inside the relationship-memory store is refused, including containment resolved through an existing symlink ancestor. File/path/write errors are swallowed so observability cannot fail recall. The instrumentation never uses a relationship-memory store write path.

When instrumentation is not enabled, no timing sink is opened or written.

## Event shape and measured boundaries

Each record is a content-free JSON object with:

- `schema_version`, fixed at `1`
- `event`, fixed at `relationship_memory_recall_timing`
- `recall_id`
- `phase`: `initial`, `expand`, or `total`
- `segment`
- `duration_ms`
- numeric/boolean counters specific to the segment

No query text, memory summary/payload, transcript text, transcript path, or other user content is emitted.

The implemented segments are:

| Segment | Meaning |
| --- | --- |
| `candidate_set_build` | Canonical candidate construction and its store reads, excluding accumulated lexical-scoring time |
| `lexical_scoring` | `lexicalTextScore` time while constructing canonical candidates |
| `semantic_index_lookup` | Local derivative-index read plus usable-vector selection in `rankExisting` |
| `query_embedding` | External `EmbeddingProvider.embedQuery` wait in `rankExisting` |
| `vector_compare` | Local cosine comparisons over usable vectors |
| `ranking_sort` | Hybrid score construction plus existing result sort/render path |
| `transcript_search` | Transcript file discovery plus JSONL scan/search; includes `scanned_files` and `parsed_lines` |
| `transcript_read` | Bounded transcript-window JSONL read; includes `parsed_lines` and `context_count` |
| `fit_evidence_bundle` | Bundle assembly plus `fitEvidenceBundle` truncation/fit; includes serialized byte count |
| `evidence_bundle_total` | One complete evidence-bundle retrieval pass |
| `expand_recall` | The single expansion call when used, with `occurred: true` |
| `recall_total` | End-to-end `executeRecall` duration, with `expand_recall: true/false` |

The same per-pass segments are tagged `phase: initial` or `phase: expand`, so an expansion's second local transcript scan and second query-embedding call can be distinguished from the first pass.

## Behavior coverage

A dedicated behavior test (`relationship-memory/tests/recall-instrumentation.test.ts`) covers:

- default-disabled mode creates no timing file and does not write timing output to stderr;
- enabled mode emits the required segments, counts, and initial/expand/total phases;
- enabled and disabled runs with the same deterministic `recall_id` produce byte-for-byte identical serialized `RecallResult` values;
- timing output does not contain sentinel query text, memory/intent content, transcript content, or system content;
- a configured missing/unwritable parent path does not fail recall;
- a timing path inside the canonical store is refused without failing recall;
- the real `FileBackedSemanticRetriever.rankExisting` path is exercised with a mock `EmbeddingProvider`, proving separate local index lookup, query embedding, and vector comparison events without a real network call;
- a throwing semantic timing callback does not change `rankExisting` success behavior.

Existing `relationship-memory/tests/recall.test.ts` assertions were not modified.

## Actual offline sample

The first PR offline-CI run used only synthetic relationship-memory/transcript fixtures and a mock semantic provider. It emitted this actual sample from the instrumented recall test:

```jsonl
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-timing-fixed","phase":"initial","segment":"candidate_set_build","duration_ms":0.0816899999999805,"candidate_count":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-timing-fixed","phase":"initial","segment":"query_embedding","duration_ms":1.25,"usable_vectors":1}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-timing-fixed","phase":"initial","segment":"transcript_search","duration_ms":0.4471290000000181,"scanned_files":1,"parsed_lines":3,"result_count":2}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-timing-fixed","phase":"initial","segment":"fit_evidence_bundle","duration_ms":0.04454299999997602,"serialized_bytes":2794}
{"schema_version":1,"event":"relationship_memory_recall_timing","recall_id":"recall-timing-fixed","phase":"total","segment":"recall_total","duration_ms":3.9260830000000055,"expand_recall":true}
```

These numbers prove the fields are produced; they are not a production latency benchmark. In particular, the `query_embedding` duration above is a deterministic mock timing value and no real embedding provider was called.

## Validation before report-only commit

Code/test head: `8771f72e5db977a492733ef8c3ed507606c1c0ab`

PR offline CI run: https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34050686416

- `npm run test:ci`: PASS — 53 test files, 466 tests
- `npm run typecheck`: PASS
- `offline-ci` conclusion: SUCCESS
- run `head_sha`: `8771f72e5db977a492733ef8c3ed507606c1c0ab`

The final report commit is documentation-only; final-head CI is verified separately in the task handoff.

## Optimization opportunities observed but intentionally not implemented

The measurements expose the existing repeated work without changing it:

1. `expand_recall` performs a second `transcriptSearch`, so transcript file discovery and JSONL parsing can run twice in one explicit recall.
2. `expand_recall` performs canonical candidate construction/store reads again.
3. When existing semantic vectors are usable, each evidence-bundle pass performs its own query-embedding external call; an expansion therefore can incur a second external embedding request.

Potential reuse/caching strategies belong to a later performance task because they can affect freshness, cancellation, query semantics, or ranking behavior. None were implemented here.

## Remaining items

- Real production/canary latency remains intentionally unmeasured in this task. The owner can enable the instrumentation during the planned embedding-quota canary using the environment variables above.
- No deployment or production data access was performed.
