# Task 086 — Relationship Memory Scaffold — Independent Review R1

## Verdict

```text
NEEDS_CHANGES

BLOCKED_086_RETRYABLE_OUTCOME_CAN_BE_SILENTLY_CONSUMED
```

## Reviewed identity

```text
repository:
kannch8765/claude-subconscious-wip

implementation branch:
scaffold/relationship-memory-01

frozen implementation base:
68e567eb59d9b75a3236f4d38d9600ebe6f1c28a

reviewed exact head:
85519c02af80d0cb7d1322e629fd8df820858ae2

independent review branch:
review/relationship-memory-01-r1
```

The review branch was created from the exact reviewed Task 086 head. The implementation branch and `main` are not modified by this review artifact.

## Exact-head CI evidence

Task 086 exact-head CI is accepted as valid evidence.

```text
support branch:
ci/relationship-memory-01

support head:
bdaa96f88079c60bb8faac52b85058bd181ef3b3

workflow run:
31172236000

workflow conclusion:
success

checkout target:
85519c02af80d0cb7d1322e629fd8df820858ae2

repository test result:
4/4 test files passed
49/49 tests passed
relationship-memory: 12/12 passed
```

The support workflow is isolated from the implementation tree and explicitly checks out the exact Task 086 head before running `npm ci` and `npm test`.

## Findings

### Blocking — retryable outcome can be silently consumed

`RelationshipMemoryRuntime.remember()` can correctly return `retryable_failed` when a durable terminal outcome cannot be committed. However, `finalizeBatch()` determines retryability only from:

1. `sessionSucceeded`, and
2. durable entries reread from `outcomes.jsonl`.

That is insufficient when the failure being exercised is the outcome journal itself.

A concrete failure sequence is:

```text
appendMemory(...)
  -> succeeds

appendOutcome(accepted)
  -> outcome_commit fails

catch path attempts appendOutcome(retryable_failed)
  -> outcome_commit fails again

memory_remember returns retryable_failed
  -> correct non-terminal business result

finalizeBatch()
  -> rereads outcomes.jsonl
  -> sees no retryable_failed outcome because that outcome could not be persisted
  -> sessionSucceeded may still be true
  -> finalizes batch as completed

cursorShouldAdvance(completed)
  -> true
```

In the zero-other-outcome case, the same batch can additionally be labeled `completed` with `detail: no_memory_required`, despite a memory mutation attempt having returned `retryable_failed`.

This violates the Task 086 batch/cursor contract: a batch is retryable when at least one `memory_remember` invocation returned `retryable_failed`, and completion is allowed only when every attempted memory mutation has a durable terminal outcome.

The store already defines `outcome_commit` as a failure-injection phase, so this is not a speculative external failure model. The current acceptance suite exercises `memory_commit` failure but does not exercise the corresponding `outcome_commit` failure path.

## Required correction

Keep the correction narrow. Do not redesign the relationship-memory architecture.

The runtime needs trusted per-batch state that records whether any invocation returned `retryable_failed`, independent of whether that retryable result could itself be durably journaled. `finalizeBatch()` must hold the batch whenever that state is present.

Equivalent designs are acceptable, but the required semantic invariant is:

```text
memory_remember returns retryable_failed
=> current batch is retryable
=> finalizeBatch cannot produce completed
=> cursor cannot advance
```

Recommended shape:

```text
remember() returns retryable_failed
-> mark trusted runtime/batch sawRetryableFailure = true

finalizeBatch():
retryable =
  !sessionSucceeded
  OR sawRetryableFailure
  OR durable journal contains latest retryable_failed outcome
```

## Required deterministic regression coverage

Add coverage for at least these cases:

```text
1. accepted memory persisted
   + accepted outcome commit fails
   + retryable outcome journal also fails
   => memory_remember returns retryable_failed
   => finalizeBatch = retryable_failure
   => cursor = HOLD

2. permanent rejection outcome commit fails
   => memory_remember returns retryable_failed
   => finalizeBatch = retryable_failure
   => cursor = HOLD

3. duplicate outcome commit fails
   => memory_remember returns retryable_failed
   => finalizeBatch = retryable_failure
   => replay does not duplicate canonical memory
```

The correction should preserve the already-passing replay, evidence-binding, linked-memory, projection, and tool-surface behavior.

## Passed review areas

No blocking finding was identified in these reviewed areas:

```text
PASS exact reviewed identity
PASS exact-head CI provenance
PASS adopted worker / conversation topology
PASS canonical structured authority
PASS backend-bound trusted transcript evidence
PASS schema_version 1
PASS exactly four authorized memory kinds
PASS exact proposal tool schema at reviewed head
PASS source replay semantics
PASS semantic dedupe behavior
PASS canonical linked-memory validation
PASS deterministic rebuildable projections
PASS Markdown memory mutation tools removed from relationship-memory surface
PASS Read / Grep / Glob retained for read-only investigation
PASS normal completed / permanent-rejection cursor semantics
```

## Non-blocking note

```text
NOTE_086_SDK_TOOLS_MODE_NOW_IGNORED
```

`scripts/send_worker_sdk.ts` still receives `sdkToolsMode: 'off' | 'read-only' | 'full'`, and the upstream sender still calculates and passes it, but the Task 086 relationship-memory worker now fixes the client-side tool surface to:

```text
Read
Grep
Glob
memory_search
memory_remember
```

This may be intentional narrowing for the Task 086 contract. It is not treated as an R1 blocker. The correction worker should not expand scope merely to redesign this setting; if touched, preserve the intended relationship-memory boundary and add a test or explicit contract note clarifying the chosen behavior.

## R1 close condition

R1 is ready for independent re-review when all of the following are true:

```text
- correction is committed only to the Task 086 implementation branch
- exact new head is reported
- retryable-return state participates in batch finalization authority
- outcome_commit failure regressions are covered
- repository tests pass on the corrected exact head
- no unrelated architecture or tool-surface expansion is introduced
```
