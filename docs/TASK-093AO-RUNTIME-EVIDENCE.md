# Task 093AO runtime evidence

Task 093AO is a historical post-sanitization DarioTouch synthetic-pair striper. It consumes the Task 093AN sanitized transcript snapshot and replaces only strict historical DarioTouch pairs with positional `{}` placeholders, preserving JSONL record count and all non-matching records.

## Candidate and dependency

- Task 093AO branch: `task/093ao-historical-dariotouch-pair-stripe`
- Executed candidate head: `1d182f9808b6426b5590248129c70e0c06b95ba3`
- Task 093AN sanitized input snapshot manifest SHA-256: `4f714f9e289a4788d8637b9ad41324de60490ab04635bb52572b5d40f94341bf`
- Input snapshot: `/var/lib/subconscious-backfill-input/owner-transcripts-sanitized-093an-01`
- Output snapshot: `/var/lib/subconscious-backfill-input/owner-transcripts-dariotouch-striped-093ao-01`

The historical heuristic is intentionally narrow: an exact single-semantic-text `user` record containing only `🫳`, followed only by zero or more positional `{}` placeholders, then an exact single-semantic-text `assistant` record containing only `🫳`. Both semantic records become `{}`; intervening placeholders remain unchanged. Unpaired, reversed, interrupted, or non-exact `🫳` records are preserved.

## Test evidence

Targeted Task 093AO tests at the executed candidate head:

- 2 test files passed
- 7 tests passed
- Covers exact matching, placeholder gaps, non-exact/unpaired/reversed/interrupted preservation, batch resume, and integrity behavior.

GitHub Actions full-suite evidence:

- Workflow: `Task 093AO tests`
- Run ID: `31597922944`
- Attempt 2: PASS
- Head: `1d182f9808b6426b5590248129c70e0c06b95ba3`

Attempt 1 at the same head exposed an existing timing-sensitive `concurrent-writer-safety` lock-contention test; all Task 093AO tests were green. Re-running the unchanged exact head produced a full-suite PASS.

## Authorized real-canary evidence

The authorized Task 093AN sanitized canary was striped to a temporary output using the exact candidate head.

- Input records: 2,668
- Output records: 2,668
- DarioTouch pairs striped: 86
- Records striped: 172
- Changed lines: 172
- Non-placeholder output changes: 0
- Remaining exact `🫳` records: user 0, assistant 0
- Input bytes: 2,443,681
- Output bytes: 2,418,882
- Input SHA-256: `75428c007e363380a3c88e9ffe01a93d6bcd7f24bd641c94052c99e4f911023e`
- Output SHA-256: `a73ac51b75c088712d73e1e9bdfab2bc482a6f5ac47baae3a092304af6101ecc`
- Observed wall time: ~1.01 s
- Observed max RSS: ~94,700 KiB

The temporary canary output was removed after verification; the input snapshot was not modified.

## Full historical run evidence

The exact candidate head was then run over the complete Task 093AN sanitized snapshot.

- Files total: 195
- Files processed: 195
- Files skipped: 0
- Manifest `complete`: true
- Input bytes: 84,059,255 (about 80.17 MiB)
- Output bytes: 83,779,468 (about 79.90 MiB)
- DarioTouch pairs striped: 968
- Records striped: 1,936
- Output manifest entries: 195
- Missing outputs: 0
- Output SHA-256 mismatches: 0
- Aggregate output bytes matched manifest summary exactly
- Final output manifest SHA-256: `872572218973f641f028c6a3206ad4760036d19933115451ee3427698fde5e7d`

After the full stripe, 66 exact `🫳` semantic records remained intentionally untouched:

- user: 36
- assistant: 30

These are the previously observed unpaired/non-strict cases and demonstrate that the striper does not apply a global emoji deletion rule.

## Privacy boundary

No transcript contents, sanitized transcript contents, per-file transcript names, or per-file manifest entries are committed as runtime evidence. This document records only aggregate counts, integrity hashes, operational snapshot roots, and test/run identifiers needed to reproduce or audit the historical backfill input preparation.
