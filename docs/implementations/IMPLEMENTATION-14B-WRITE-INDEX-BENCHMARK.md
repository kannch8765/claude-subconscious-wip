# Task 14B — Alternating-writer write-index benchmark

## Scope

This task measures the Task 14 write-index implementation under sequential single-writer and alternating-writer workloads. It does not modify production implementation code, existing tests, CI configuration, or runtime behavior.

Compared implementations:

- **old**: `relationship-memory/src/store/index.ts` at Task 14 base `3fdfce27152bdedba502030e817a4b1b256e72f6`.
- **new**: `relationship-memory/src/store/index.ts` at PR #106 head `4facc4d80e38c72b55d3b9d2a8ad51c3c47059fa`.

Both source snapshots were re-read directly from GitHub at those exact SHAs before measurement. The local benchmark copies byte-for-byte matched the snapshots used for Task 14.

No VPS, production store, Letta, model, embedding provider, or network service was used.

## Question

Task 14 validates the sidecar manifest by comparing the canonical JSONL byte size with the size recorded in `.write-index-v1/`. The concern for Task 14B was that two writers alternating between mutation boundaries might repeatedly make each other's sidecar stale, causing `rebuildWriteIndex` to rebuild a growing dataset on nearly every write.

The implementation detail that matters is that both writers share the same on-disk sidecar. A successful Task 14 writer appends canonical JSONL and then updates the shared marker/manifest while still inside the canonical mutation boundary. Therefore another writer using the same implementation can observe an already-current manifest. Task 14B measures whether that is what actually happens.

## Environment

- ChatGPT isolated Linux sandbox; no VPS / production access.
- Node.js `v22.16.0`.
- TypeScript `5.8.3` to emit runnable JS copies of the exact old/new store source.
- Temporary stores from `fs.mkdtempSync` under the sandbox's local temporary filesystem.
- Each measured sample starts from a fresh empty store directory.

## Workload

Each logical record uses the same synthetic shape as the Task 14 benchmark:

- one unique canonical memory;
- one unique evidence row;
- one `appendMemory(memory, [evidence])` call per logical write.

Three scenarios were measured:

1. **single** — one `RelationshipMemoryStore` instance performs all N writes.
2. **alternate-1** — two store instances share the same root and alternate after every write: A writes 1, B writes 1, repeat.
3. **alternate-10** — two store instances share the same root and alternate in blocks of 10 writes: A writes 10, B writes 10, repeat.

N = 200 and N = 1000.

For every scenario × N × implementation cell, five independent fresh-store samples were taken and the median is reported. Old/new samples were interleaved within each repetition to reduce temporal machine-load bias. A small untimed N=20 warmup was run once per implementation before the measured cases.

The full six-cell sweep exceeded the sandbox's single-command execution window before the final `alternate-10 / N=1000` cell completed, so that cell was immediately rerun as a separate five-sample invocation in the same sandbox, with the same emitted binaries and driver logic. No source or benchmark logic changed between invocations.

## Temporary rebuild instrumentation

For the **new** emitted JS only, each store instance was monkey-patched in the benchmark process so calls to the existing private-at-TypeScript-level `rebuildWriteIndex(dataset, fileName, records, entryFor)` method incremented two counters:

- `rebuilds += 1` per call;
- `rebuild_marker_writes += records.length`, which equals the number of `writeMarkerEntry` calls made by that rebuild for these unique-ID synthetic records.

The wrapper immediately delegated to the original method and did not change its inputs, return value, or control flow. The old implementation has no `rebuildWriteIndex`, so rebuild counters are not applicable there.

This instrumentation existed only in the disposable benchmark process. No counting/logging code is committed in this branch.

## Results

### Median comparison

| Scenario | N | Old median | New median | New vs old | New rebuilds per run | Marker writes during rebuild per run |
|---|---:|---:|---:|---:|---:|---:|
| single | 200 | 101.2 ms | 208.9 ms | 2.064× slower | 2 | 0 |
| single | 1000 | 1508.9 ms | 849.3 ms | 1.777× faster | 2 | 0 |
| alternate-1 | 200 | 81.4 ms | 172.2 ms | 2.115× slower | 2 | 0 |
| alternate-1 | 1000 | 1462.1 ms | 862.0 ms | 1.696× faster | 2 | 0 |
| alternate-10 | 200 | 83.8 ms | 226.7 ms | 2.705× slower | 2 | 0 |
| alternate-10 | 1000 | 1770.3 ms | 1076.2 ms | 1.645× faster | 2 | 0 |

### Raw five-sample timings

| Scenario | N | Old samples (ms) | New samples (ms) |
|---|---:|---|---|
| single | 200 | 107.4, 94.6, 101.2, 105.0, 85.8 | 207.7, 198.0, 238.7, 225.9, 208.9 |
| single | 1000 | 1660.1, 1500.3, 1550.5, 1508.9, 1502.4 | 893.5, 825.2, 874.4, 768.3, 849.3 |
| alternate-1 | 200 | 83.5, 81.4, 83.0, 78.5, 79.2 | 180.4, 164.6, 177.4, 172.2, 167.5 |
| alternate-1 | 1000 | 1462.1, 1457.9, 1487.3, 1454.9, 1619.4 | 862.0, 877.1, 848.7, 802.3, 951.9 |
| alternate-10 | 200 | 83.8, 80.7, 81.5, 86.7, 94.4 | 187.5, 202.8, 226.7, 228.7, 227.9 |
| alternate-10 | 1000 | 2161.3, 1770.3, 1758.8, 1790.9, 1704.9 | 1236.9, 1076.2, 1187.2, 1030.3, 1073.2 |

### Rebuild counters

For every one of the five repetitions in every **new** scenario/N cell:

- rebuild call counts were exactly `[2, 2, 2, 2, 2]`;
- marker writes performed **inside rebuilds** were exactly `[0, 0, 0, 0, 0]`.

The two rebuild calls are the first mutation's initialization of the `memories` and `evidence` datasets while both canonical files are still empty. Because the rebuild input arrays are empty at that point, they write no historical marker rows. Normal post-append marker maintenance is intentionally not included in the rebuild-marker count.

Most importantly, neither per-record alternation nor 10-record alternation caused any additional rebuild after initialization, including at N=1000.

## Interpretation

The specific Task 14B concern is **not reproduced** when both writers use the Task 14 implementation.

A second store instance does not inherently stale the first instance's index. The writer that just appended also advances the shared on-disk sidecar manifest to the new canonical size before releasing the mutation boundary. The next writer revalidates against disk and finds the manifest current. The direct rebuild counters confirm that this remains true across hundreds of writer handoffs.

There is therefore no alternating-writer O(n²) rebuild pattern in the requested homogeneous two-writer scenarios.

The timing results also do not show an alternation-specific collapse:

- At N=200, the new implementation is still slower than the old implementation in all three scenarios (about 2.1× to 2.7× here). This is consistent with Task 14's already-reported small-store sidecar overhead.
- At N=1000, the new implementation is faster than the old implementation in all three scenarios: 1.777× for one writer, 1.696× for per-record alternation, and 1.645× for 10-record alternation.

Absolute timing varies with sandbox filesystem/machine load, so the rebuild counters are the stronger evidence for the question Task 14B was designed to answer. The counters stay flat at the two empty-store initialization rebuilds rather than growing with N or writer handoffs.

## What this does not prove

This benchmark intentionally follows the requested scenarios: both alternating instances use the same new implementation. It does **not** measure a mixed-version writer or an out-of-band writer that appends canonical JSONL without updating `.write-index-v1/`.

Such a writer would change canonical size while leaving the manifest behind, and the next Task 14 writer is designed to rebuild. Task 14 already tests the correctness of that invalidation path, but its repeated performance under a continuously mixed old/new or raw-append workload is a different benchmark from Task 14B.

## Conclusion

For the repository's same-version multi-writer case represented by two `RelationshipMemoryStore` instances, Task 14's sidecar does **not** rebuild on every handoff. The feared alternating-write degradation was not observed.

Based on this measurement alone, there is no evidence that the manifest invalidation rule needs redesign specifically for homogeneous concurrent writers. The remaining measured cost is the already-known small-N sidecar overhead, not repeated full-dataset rebuild.

No implementation improvement is made in this task.
