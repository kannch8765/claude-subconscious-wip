# Task 093AN runtime evidence

This note records bounded runtime evidence for the transcript wrapper sanitizer and batch runner. It intentionally contains no transcript contents, sanitized transcript contents, or per-file private manifest entries.

## Candidate exercised on VPS

The runtime strip described below exercised exact candidate head:

`123423d9cdfe8d4bcbd24d00c015e1fa1f73db8d`

The source was the owner Claude Code transcript root, with the batch runner's default exclusions for `archive` and `subagents`. The output was written to a separate snapshot root; the source tree was not modified in place.

## Single-snapshot equivalence canary

Before the full batch run, the wrapper sanitizer was exercised against the previously owner-authorized 6,139,476-byte historical snapshot.

Results:

- input records: 2,668
- sanitized records: 2,668
- input bytes: 6,139,476
- sanitized bytes: 2,443,681
- saved ratio: 60.20%
- canonical evidence events: 871 raw / 871 sanitized
- canonical evidence exact equality: PASS
- historical observer messages: 1,057 raw / 1,057 sanitized
- historical observer exact equality: PASS

The temporary sanitized canary copy and temporary worktree were removed after verification. The authorized source snapshot remained unchanged.

## Full owner transcript strip

Preflight after the default exclusions:

- files: 195
- input bytes: 228,635,493 (218.04 MiB)

Final batch manifest summary:

- `complete`: true
- files total: 195
- files processed: 195
- files skipped: 0
- output bytes: 84,059,255 (80.17 MiB)
- bytes saved: 144,576,238
- saved ratio: 63.23%
- manifest entries: 195
- missing outputs: 0
- output SHA-256 mismatches: 0
- excluded path segments: `archive`, `subagents`
- manifest SHA-256: `4f714f9e289a4788d8637b9ad41324de60490ab04635bb52572b5d40f94341bf`

The runner exited after completion; no sanitizer runner process remained active.

## GitHub CI before runtime batch

Task 093AN GitHub Actions run `31584284903` passed on exact head `123423d9cdfe8d4bcbd24d00c015e1fa1f73db8d` with `npm ci` followed by the complete `npm test` suite.

The suite includes the wrapper consumer-equivalence tests plus batch runner coverage for directory mirroring, default exclusions, manifest/hash recording, verified resume/skip behavior, dry-run behavior, input/output overlap rejection, and orphan/mismatched output rejection.

## Privacy boundary

No transcript contents, sanitized transcript contents, per-file transcript names, or per-file manifest entries are committed as runtime evidence. This document records only aggregate counts, byte totals, equality outcomes, and integrity summaries needed for review.