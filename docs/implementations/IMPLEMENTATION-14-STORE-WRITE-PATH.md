# Task 14 — Store write-path full-scan removal

## Scope

This task is a pure performance change to `relationship-memory/src/store/index.ts` plus regression coverage and the requested `STATUS.md` correction. Canonical JSONL formats, lock acquisition/release/timeout/stale-recovery logic, recall/retrieval code, scripts, hooks, config, workflows, package metadata, and production data are unchanged.

Base used for the implementation: `main` at `3fdfce27152bdedba502030e817a4b1b256e72f6`.

## Problem

The pre-change append methods repeatedly parsed whole append-only files to answer point lookups:

- `appendMemory`: full `memories.jsonl` scan plus full `evidence.jsonl` scan.
- `appendReinforcement`: full `reinforcements.jsonl` scan plus full `evidence.jsonl` scan.
- `appendEntity`: full `entities.jsonl` scan plus full `entity-evidence.jsonl` scan.
- `appendAssistantIntent`: full `assistant-intents.jsonl` scan.
- `appendAssistantIntentOutcome`: full `assistant-intent-outcomes.jsonl` scan plus `stableJson` comparison for every record.

For N sequential writes into a growing store this makes the amount of parsed historical data grow quadratically.

## Implementation

The canonical JSONL files remain the sole authority. The write path now maintains a hidden best-effort accelerator under `.write-index-v1/`.

Each indexed canonical dataset has:

- `manifest.json`, containing the canonical JSONL byte size that the sidecar was built against.
- hashed marker files for point existence checks.
- marker value data only where identity comparison is required (`reinforcement_id`, assistant intent identity, exact assistant-intent outcome identity).

Hash collisions do not silently alias records: a marker file stores an array of `{ key, value? }` entries and the full key is compared after locating the hashed file.

### Boundary-local memory state

The only in-memory cache is `mutationWriteIndexReady`, which records which datasets have already been validated during the current `withMutationBoundary` call. It is created only after the canonical mutation lock is acquired and is explicitly cleared before the lock is released. It never survives a mutation boundary.

Nested mutations inside one outer boundary may reuse that readiness state. Separate boundaries always revalidate the sidecar against disk.

### Sidecar validation and rebuild

Before marker absence is trusted, the store checks the dataset manifest against the current canonical JSONL byte size. If the manifest is missing, malformed, or has a different size, the sidecar is rebuilt from the canonical JSONL while the mutation lock is held. Only after rebuild completes is a new manifest published.

This directly covers another writer or a raw external append between boundaries: the canonical file size changes, so the old manifest cannot be treated as current. Regression coverage includes both a second `RelationshipMemoryStore` instance and a direct external append to `memories.jsonl`.

If the sidecar cannot be validated or rebuilt, the write method falls back to the original full canonical scan for that operation. Correctness therefore does not depend on `.write-index-v1/` existing or being writable.

## Crash / partial-write consistency

Canonical JSONL is always appended before the accelerator is updated.

- Crash after canonical append but before marker update: manifest still records the previous canonical size, so the next boundary sees a size mismatch and rebuilds.
- Crash after marker update but before manifest update: the manifest still has the previous canonical size, so the next boundary rebuilds.
- Crash or corruption while writing the manifest: parse failure or size mismatch invalidates it and forces rebuild.
- Crash during rebuild: the dataset sidecar directory is removed before rebuild and the manifest is written last, so a partial rebuild has no valid manifest and is rebuilt again next time.
- Sidecar maintenance failure after a successful canonical append is caught; the manifest is invalidated best-effort and the canonical write remains successful. A future boundary rebuilds from canonical authority.

No sidecar state can cause a canonical append to be rolled back, and missing sidecar files do not change behavior.

The manifest uses canonical byte size because these canonical files are append-only under the store contract. Direct append changes that size and is detected. This task does not attempt to make arbitrary same-size out-of-band rewrites a supported mutation mode.

## Preserved semantics

Regression tests verify:

- duplicate `memory_id`, `evidence_id`, `reinforcement_id`, `entity_id`, and entity evidence remain idempotent;
- reinforcement identity collision still throws when either `memory_id` or `evidence_ids` differs;
- assistant intent identity collision behavior is unchanged;
- exact duplicate assistant intent outcomes are not appended twice;
- writes nested in one outer mutation boundary produce the same canonical records as the same writes performed through separate boundaries;
- a second store instance writing between boundaries is visible to the first store on its next mutation;
- a raw external canonical append invalidates the sidecar before absence is trusted;
- `failureInjector` aborts leave canonical disk state unchanged and later writes remain correct.

Existing concurrency/idempotency suites are left unchanged.

## Offline performance measurement

Measurement environment:

- ChatGPT isolated Linux sandbox (not VPS / production).
- Node.js `v22.16.0`.
- TypeScript `5.8.3` used only to emit runnable JS copies of the exact old/new store implementations for the benchmark.
- Local temporary directories created with `fs.mkdtempSync`.
- No Letta, model, embedding provider, network service, or production memory data.

Method:

1. Old implementation: exact `relationship-memory/src/store/index.ts` from base `3fdfce27152bdedba502030e817a4b1b256e72f6`.
2. New implementation: Task 14 write-index implementation; the final typing-only marker declaration change is erased at runtime and does not affect these timings.
3. For each N, create a fresh empty synthetic store and call `appendMemory` N times with one unique memory and one unique evidence record per call.
4. Measure wall-clock time around the N appends using `performance.now()`.
5. Run each case five times and report all samples plus the median.

Results:

| N | old samples (ms) | old median | new samples (ms) | new median |
|---:|---|---:|---|---:|
| 200 | 174.9, 161.3, 160.7, 162.8, 161.0 | 161.3 ms | 301.4, 299.8, 304.9, 291.3, 273.9 | 299.8 ms |
| 1000 | 2160.3, 1975.5, 1917.6, 2026.3, 1940.2 | 1975.5 ms | 1263.3, 1057.7, 1051.5, 1123.1, 987.0 | 1057.7 ms |

Growth from N=200 to N=1000 (5x more writes):

- old median: `1975.5 / 161.3 = 12.25x`;
- new median: `1057.7 / 299.8 = 3.53x`.

The new path has visible fixed filesystem overhead at small N because it creates and updates sidecar markers/manifests, so N=200 is slower in this synthetic run. At N=1000 it is already about `1.87x` faster, and—more importantly for this task—the growth trend no longer follows the old repeated-full-scan curve. The measurement therefore supports the intended asymptotic improvement while also recording the small-store overhead rather than hiding it.

## Validation

First implementation CI run:

- full Vitest passed: 55 files / 477 tests, including `relationship-memory.test.ts`, `backfill.test.ts`, `concurrent-writer-safety.test.ts`, `legacy-ombre-concurrency.test.ts`, and the new 7-test write-path suite;
- typecheck initially failed on one TypeScript union-narrowing issue in the reinforcement marker path;
- that issue was corrected with a typing-only marker declaration change, with no runtime behavior change.

Final `npm run typecheck`, `npm run test:ci`, and `PR offline CI / offline-ci` status are recorded on the final PR head once the post-report run completes.

## STATUS.md correction

Recall remains in the state “real canary not executed.” The blocker wording was corrected from embedding quota exhaustion to memory-agent/model quota exhaustion; embedding quota remains available per owner clarification.

## Known risks / remaining items

- The sidecar adds filesystem metadata/inode overhead. This is intentional to obtain point lookups without reparsing growing canonical JSONL files. A future task may evaluate a denser index representation if production inode count becomes material, but changing representation is outside Task 14.
- First mutation against an existing store with no valid sidecar performs a one-time rebuild from canonical JSONL. This is required so absence can be trusted safely.
- Arbitrary same-size out-of-band rewrites are not supported by the append-only store contract; normal external appends and all writers using the canonical mutation lock are covered.
- No deployment or real service canary was performed in this task.
