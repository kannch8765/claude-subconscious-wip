# Batch failure model: ownership-based batch outcome

Status: **implemented** on `task/ownership-batch-outcome` (2026-10-15). Not deployed yet.

## Problem

Since the #138 deploy, 21 of 59 live batch attempts ended `retryable_failure`,
all as `turn_failed`. 13 of those were a single `deliver_whisper` call rejected
with `whisper_not_surfaced`; one more was `deliver_whisper` called twice. The
same pattern is chronic (135 cases in Sep, 132 in Oct).

A failed batch holds the transcript cursor, so an optional whisper UX mistake
blocks durable memory work for the whole session — the second "poison" pattern
after the unresolved-intent loop fixed in #138.

## Root cause: two failure signals, one of them blunt

The batch outcome is decided by two signals with very different precision:

| Signal | Where | Precision |
|---|---|---|
| Durable outcome ledger: `outcomes`, `entity_outcomes`, intent outcomes, `retryableAttempts` | `RelationshipMemoryRuntime.finalizeBatch` | Per work item. Knows *what* failed and whether it is retryable. |
| `sessionSucceeded = !clientToolFailure` | `runNativeClientToolConversation` → `send_worker_native.ts` | One sticky bit: "did **any** client tool throw at any point in the turn". |

Memory tools already never throw on business failures; they return
`retryable_failed` / `permanently_rejected` and write the ledger. stdio MCP
tools already never throw (they return `status: 'unavailable'`). The only
remaining throw sites are model-input validation in worker-local tools:

- `deliver_whisper`: not surfaced in this turn, bad arity, called twice.
- `requireMaintenanceSearchProvenance` for `suggest_memory_relation`.
- Malformed tool-argument JSON.

All of these are returned to the model as tool errors (so it *can* self-correct),
yet the sticky bit fails the batch even when the model recovers in the next step.

The likely trigger for `whisper_not_surfaced`: the Letta conversation is
persistent, so memory/snippet ids from earlier turns are in context, while the
worker only accepts ids surfaced by `foreground_recall` in **this** turn.

## Principle

> **A batch fails only when work the batch owns is not durably settled.**
> The turn-level signal answers one question only: *did the observer complete a
> turn over this batch?*

What a live async batch owns:

| Work | Owned? | Retry useful? |
|---|---|---|
| Memory remember / reinforce outcomes for transcript evidence | yes | yes |
| Entity outcomes | yes | yes |
| Trusted remember intents (#138 deferral budget) | yes | yes |
| Whisper delivery | **no** — ephemeral foreground UX, keyed to a moment that has passed | no: a replayed whisper is stale |
| `suggest_memory_relation` proposals | **no** — optional, re-derivable on any later maintenance search | no |
| stdio MCP side effects | **no** — already best-effort | no |

## Model

```
observer turn
  ├─ transport failed (Letta error, stop_reason=error, stream error,
  │   required memory_search missing, unknown tool, worker exception)
  │      → turnCompleted = false → retryable_failure   (unchanged)
  └─ turn completed
         → tool errors are feedback to the model + telemetry, never a batch verdict
         → batch status = ledger only (finalizeBatch, unchanged)
```

Rules:

1. `runNativeClientToolConversation` reports facts, not a verdict: it returns
   `toolErrors: { name, message }[]`. `clientToolFailure` stays as a derived
   boolean so the backfill runners keep their current behaviour.
2. The live worker sets `turnSucceeded = true` once the conversation returns.
   Thrown/rejected turns stay `false` exactly as today.
3. Owned-work tools convert **unexpected** exceptions into the ledger: the
   mutation-tool wrapper catches anything thrown by `execute` (e.g. an IO error
   escaping `withMutationBoundary`) and calls a new
   `runtime.markAttemptRetryable(batchId)` before re-throwing to the
   model. A failed `purpose=maintenance` search, and an owned-work call whose
   arguments are not valid JSON, hold the attempt the same way (they can hide
   an owned write). A failed `foreground_recall` search does not. So "ledger
   only" never loses a real memory failure.
4. `deliver_whisper` errors become actionable: the `whisper_not_surfaced` error
   lists the memory ids (and their snippet ids) surfaced this turn, so the model
   can retry correctly in the same turn. A second call returns
   `{ status: 'already_resolved' }` instead of throwing.
5. Sync lane follows the same rule (turn completed ⇒ completed-resource
   cleanup). Foreground release is already handled by the `no_whisper`
   checkpoint, so behaviour seen by Kohaku is unchanged.
6. Durable reason: `BatchRecord` gains optional `retry_reasons: string[]`
   (`turn_failed`, `memory_retryable`, `entity_retryable`, `intent_blocking`,
   `attempt_retryable`), and the worker log records each tool error class. This is
   what we had to reconstruct from Letta traces this week.

## Non-goals

- Replaying already-stuck sessions (separate controlled replay, next step).
- The 4 pre-Letta failures (2–3 s). Probable cause: the initial
  `conversations.messages.create` has no 409-busy retry. That is a genuine
  transport failure and stays retryable; it is tracked separately.
- Backfill runners keep `clientToolFailure` semantics.

## Tests (`scripts/batch_ownership_outcome.test.ts`)

These run end-to-end through the real native client-tool loop with a scripted
Letta stream. All 10 fail on the pre-change code.


- Turn with `deliver_whisper` rejected, then normal end → batch `completed`, cursor advances.
- Same, with a `retryable_failed` memory outcome → still `retryable_failure` (ledger wins).
- Mutation tool throws unexpectedly → `retryable_failure` with `attempt_retryable`.
- `suggest_memory_relation` provenance rejection alone → `completed`.
- Transport failure / missing required `memory_search` → `retryable_failure` (unchanged).
- `whisper_not_surfaced` error message contains this turn's surfaced ids.
- Second `deliver_whisper` → `already_resolved`, no tool error.
- Sync: rejected whisper then end → `completed`, `no_whisper` checkpoint.
- Payload-file entrypoint advances the cursor after a rejected whisper.
- Updated the source-string assertions in `live_async_memory_surfacing.test.ts` /
  `sync_subcon_mode.test.ts` that pin `turnSucceeded = !result.clientToolFailure`.

## Busy conversation on the first send (409)

Overlapping Stop hooks share one Letta conversation. The second worker's first send used to hit
`409 Another request is currently being processed` and fail the whole batch as `turn_failed`
(13 of the remaining failures on 2026-10-15/16). The lock is intended Letta behaviour (Redis,
`CONVERSATION_LOCK_TTL_SECONDS = 300`), so the fix follows Letta's own client instead of
working around the server:

- **Busy:** retry with letta-code's exponential backoff (10 s, 20 s, 40 s, …), bounded by a
  total wait of 240 s (below the 300 s lock TTL). letta-code stops after three retries; our
  turns are longer (p90 ≈ 100 s), hence the time budget.
- **Waiting for approval:** letta-code denies the pending tool calls it finds on the last
  in-context message and resends with the denials prepended (Letta 0.16.8 accepts an approval
  followed by the user message). A pending approval may also be a live sibling worker between
  tool rounds, so we deny only when the *same* tool call ids stay pending for 90 s, and at most once.
- Async lane only (`initialBusyRetry`). Sync keeps its 3 s continuation retry; its first send
  is foreground-latency bound.
- Whisper behaviour is unchanged. A waited turn produces a later whisper; `ready_latency_ms`
  already measures that, so any staleness cut-off waits for data.
- Each wait is logged (`Initial send busy|approval_pending|denied_stale_approvals|accepted`).
- Tests: `native_letta_backfill.test.ts` › *initial send waits for a busy conversation*.
