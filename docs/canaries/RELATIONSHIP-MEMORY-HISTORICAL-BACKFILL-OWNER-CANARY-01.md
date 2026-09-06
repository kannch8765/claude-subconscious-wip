# Relationship Memory Historical Backfill Owner Canary 01

Date: 2026-08-09

Status: **PASS**

This document records the first Owner-authorized historical backfill canary against a real Claude Code transcript owned by the assistant account (`root`). It is an evidence report. It is not a normative architecture change and it does not modify canonical `main`.

## Repository baseline

Target repository:

```text
kannch8765/claude-subconscious-wip
```

Canonical baseline, unchanged throughout the canary:

```text
main = 76e875095d6e0595041adc536b7e002f8888442e
"Merge Task 093L — relationship-memory reinforcement/linking foundation"
```

Both the published historical backfill foundation and the reinforcement/linking foundation are present at this head.

## Authority

The canary reused the three live authorities without modification, and created only the two artifacts a bounded canary is permitted to create.

Reused (live, unchanged):

```text
canonical ledger root  /srv/haru-mcp-workspace/task-093b/live/relationship-memory
subject id             owner-live-093b-45a14f87-7e0f-4844-b4e8-9a32473796a5
letta agent id         agent-8c9329b5-63e0-4a45-98e4-1770a61521df
```

Created for this canary only:

```text
dedicated backfill conversation  conv-a8710d3f-85f7-4cd9-b7bd-c3cb9a50d1e8   (auto-created by CLI)
dedicated checkpoint/state       /root/.local/state/canary01/backfill-state.json
backfill session id              relationship-memory-backfill-213b24f6-640a-4c9a-a659-2fe29c341326
```

No agent auto-import occurred. No second relationship-memory root was created.

The `subject-id` file in the live workspace was verified byte-for-byte equal to the supplied subject id before the run.

## Authorized transcript

Exactly one transcript was authorized and read. It was not modified, moved, copied, or re-permissioned.

```text
/root/.claude/projects/-root/60bfe431-c007-4515-af62-03e0fbcd9405.jsonl
```

No other transcript or transcript root was scanned.

## Execution identity

The run was executed as `root`, reading a `root`-owned transcript and appending to `haru`-owned canonical ledgers. Appending to an existing file does not change its owner, group, or mode; this was verified after the run.

A fail-closed preflight was required before execution:

1. all four canonical ledgers already exist
2. all four are still `haru:haru 600`
3. pre-run hashes recorded
4. any unmet condition aborts; `root` is never allowed to create a missing ledger

Preflight result: **PASS**.

## Runtime

```text
node    v22.23.1
tsx     4.21.0
letta   0.16.8   (self-hosted, 127.0.0.1:8283, health 200)
```

## Bounded run

```bash
npm run backfill -- \
  --transcript /root/.claude/projects/-root/60bfe431-c007-4515-af62-03e0fbcd9405.jsonl \
  --state /root/.local/state/canary01/backfill-state.json \
  --root /srv/haru-mcp-workspace/task-093b/live/relationship-memory \
  --max-batches 1 \
  --max-records 20
```

## Terminal result

```text
batch id     historical_batch_19385ed985e9f61422288361
created_at   2026-08-09T09:23:09.602Z
finalized_at 2026-08-09T09:24:00.484Z   (51s)
status       completed
detail       no_memory_required
sent         20 trusted evidence messages
CLI result   {"status":"completed","batchesProcessed":1,"sourcesVisited":1}
```

Terminal decision was `completed` with `no_memory_required`. This is a normal observer decision, not a failure and not a no-op error.

## Canonical ledgers before/after

```text
file              before                          after
batches.jsonl     1068 B  b7075192ae40c6a0   →    1374 B  2fbb475d60fb553f   (+2 rows: pending, completed)
memories.jsonl    2644 B  8cedb7745dfcf642   →    2644 B  8cedb7745dfcf642   (unchanged)
evidence.jsonl    3392 B  eb26fcd5922f05e5   →    3392 B  eb26fcd5922f05e5   (unchanged)
outcomes.jsonl     582 B  8d2811723a5c34fd   →     582 B  8d2811723a5c34fd   (unchanged)
```

File count `4 → 4`. No new canonical ledger file was created. All four remained `haru:haru 600`. In particular `reinforcements.jsonl` was not created.

## Bound-evidence semantics

`evidence.jsonl` did not change even though 20 trusted evidence messages were sent to the observer. This is expected: evidence records are persisted only when they are bound to an accepted memory. With `no_memory_required` there is nothing to bind, so no evidence rows are written. Canary 02 confirms the complementary case, where 16 evidence rows are persisted alongside 5 accepted memories.

## Checkpoint

```text
committed_offset   0 → 33508
generation         1
conversation_id    conv-a8710d3f-85f7-4cd9-b7bd-c3cb9a50d1e8
agent_id           agent-8c9329b5-63e0-4a45-98e4-1770a61521df
```

## Live observer cursor/state

Recorded before and after; all byte-for-byte unchanged:

```text
log-offsets              f456c1ffc6a33cd5   unchanged
session-id               3a07ba45c6bb84b2   unchanged
subject-id               5289c957809f053b   unchanged
replay-result.json       2f75f5be8771daab   unchanged
agent-after-live.json    a2c9244c35b0db49   unchanged
```

The live observer was not disturbed by the historical backfill run.

## Observer behaviour

```text
memory create        0
memory reinforce     0
memory link          0
outcomes recorded    0
```

The observer spent 51 seconds on 20 trusted evidence messages before returning `no_memory_required`. The batch covered the beginning of the transcript. The observer made a terminal `no_memory_required` decision and produced no canonical memories. This is consistent with the intended conservative behaviour: a historical batch may complete without forcing a memory write.

## Errors

None. No retryable failures, no blocked-failure terminal state.

## Conclusion

Canary 01 passes. A bounded 1×20 historical backfill executed against a real owner transcript, reused all three live authorities, created only the permitted dedicated conversation and checkpoint, produced a clean `completed / no_memory_required` terminal decision, and left both the canonical memory ledgers (other than the batch record) and the entire live observer cursor/state untouched.
