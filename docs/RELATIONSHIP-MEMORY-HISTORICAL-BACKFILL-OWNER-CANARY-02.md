# Relationship Memory Historical Backfill Owner Canary 02

Date: 2026-08-09

Status: **PASS**

This document records the second Owner-authorized historical backfill canary. It continues Canary 01 from the same checkpoint against the same transcript, with no authority changes and no parameter changes. It is an evidence report and does not modify canonical `main`.

Canary 01 is recorded in `docs/RELATIONSHIP-MEMORY-HISTORICAL-BACKFILL-OWNER-CANARY-01.md`.

## Repository baseline

```text
kannch8765/claude-subconscious-wip
main = 76e875095d6e0595041adc536b7e002f8888442e
```

Unchanged from Canary 01.

## Authority

Identical to Canary 01. Nothing was re-pointed, re-created, or re-imported.

```text
canonical ledger root  /srv/haru-mcp-workspace/task-093b/live/relationship-memory
subject id             owner-live-093b-45a14f87-7e0f-4844-b4e8-9a32473796a5
letta agent id         agent-8c9329b5-63e0-4a45-98e4-1770a61521df
conversation           conv-a8710d3f-85f7-4cd9-b7bd-c3cb9a50d1e8   (reused)
checkpoint/state       /root/.local/state/canary01/backfill-state.json   (continued)
transcript             /root/.claude/projects/-root/60bfe431-c007-4515-af62-03e0fbcd9405.jsonl
```

The run resumed naturally from `committed_offset = 33508`. No transcript preview, no source selection, and no reading of any additional owner transcript occurred.

## Bounded run

```bash
npm run backfill -- \
  --transcript /root/.claude/projects/-root/60bfe431-c007-4515-af62-03e0fbcd9405.jsonl \
  --state /root/.local/state/canary01/backfill-state.json \
  --root /srv/haru-mcp-workspace/task-093b/live/relationship-memory \
  --max-batches 1 \
  --max-records 20
```

Identical to Canary 01.

## Terminal result

```text
batch id     historical_batch_b528934c21d20eb43658bb11
created_at   2026-08-09T09:35:55.289Z
finalized_at 2026-08-09T09:44:00.449Z   (8m05s)
status       completed
detail       (none — memories were produced)
sent         20 trusted evidence messages
CLI result   {"status":"completed","batchesProcessed":1,"sourcesVisited":1}
```

Unlike Canary 01 this batch carried no `no_memory_required` detail, and took approximately 9.5× longer, consistent with real memory synthesis work.

## Observer outcomes

```text
outcomes recorded          9
  accepted                 5
  permanently_rejected     4   (rejection_code = unresolvable_evidence)
memories created           5   (total 2 → 7)
memory reinforcements      0
linked_memory_ids          0
dedupe_key collisions      0   (checked across the whole memories ledger)
```

## Accepted memories (sanitized)

Sensitive prose is not reproduced. Only classification and shape are recorded.

```text
kind = inside_joke          4 records
kind = relationship_event   1 record
status                      active   (all 5)
participants                [user, assistant]   (all 5)
```

The four `inside_joke` records carried structured payloads with `name`, `meaning`, `trigger_phrases`, `origin`, `callbacks`, and `tone`. The single `relationship_event` carried `event`, `meaning`, `prior_context`, and `resulting_change`, correctly framing the episode as the origin point of a recurring ritual rather than as an isolated event.

Classification quality was accurate: recurring private phrases were filed as `inside_joke`, and the one episode with lasting relational consequence was filed as `relationship_event`.

## Bound evidence

```text
evidence records after run   20
  bound to Canary 02 memories 16
  pre-existing                 4
```

This confirms the bound-evidence semantics noted in Canary 01: evidence rows are persisted only when bound to an accepted memory.

## Canonical ledgers before/after

```text
file              before                          after
batches.jsonl     1374 B  2fbb475d60fb553f   →    1650 B  7fbd9b3a2a61d080   (+2 rows: pending, completed)
memories.jsonl    2644 B  8cedb7745dfcf642   →    9285 B  9efc22bf17d5a5a1   (+5 records)
evidence.jsonl    3392 B  eb26fcd5922f05e5   →   11037 B  6b52307412f8a8c3   (+16 records)
outcomes.jsonl     582 B  8d2811723a5c34fd   →    2808 B  ac8552f4cc835f2f   (+9 records)
```

File count `4 → 4`. No new canonical ledger file was created; `reinforcements.jsonl` still does not exist. All four files remained `haru:haru 600` after being appended to by `root`.

## Checkpoint

```text
committed_offset   33508 → 63372
generation         1
```

The authorized transcript is approximately 6 MB; this canary has consumed roughly 1% of it.

## Live observer cursor/state

Recorded before and after; all byte-for-byte unchanged:

```text
log-offsets              f456c1ffc6a33cd5   unchanged
session-id               3a07ba45c6bb84b2   unchanged
subject-id               5289c957809f053b   unchanged
replay-result.json       2f75f5be8771daab   unchanged
agent-after-live.json    a2c9244c35b0db49   unchanged
```

## Errors

None. No retryable failures. The four `permanently_rejected` outcomes are correct authority-gate behaviour, not errors; see Finding 3.

## Findings

These are forward-looking improvements. None of them constitutes a canary failure, and none of them was treated as a defect to be fixed within the canary.

### Finding 1 — canonical prose was unnecessarily translated to English

The source conversation is primarily Chinese, but the observer wrote canonical `summary`, `meaning`, `origin` and related prose in English. Original `trigger_phrases` were preserved verbatim, so keyword recall is not degraded. Still, the canonical narrative should default to the primary language of the source material rather than being translated. Follow-up should make language preservation explicit in the observer contract.

### Finding 2 — clearly related memories in the same batch were not linked

At least two of the five accepted memories are semantically bound to each other: one `inside_joke` names the persona that the `relationship_event` describes the origin of. Despite the reinforcement/linking foundation being present at this head, `linked_memory_ids` was empty on every record. Follow-up should make the sequencing explicit in the observer/system-prompt contract: write the parent memory first, capture the accepted `memory_id`, then write the child with that id in `linked_memory_ids`.

### Finding 3 — evidence ids were submitted in truncated or uncatalogued form

All four rejections share `rejection_code = unresolvable_evidence` with reason `Evidence message is not available in the trusted batch: <id>`. Three of the four ids were 8-character truncations, and one was a full UUID that was not in the trusted catalog for that batch:

```text
d7a33761                               (8 chars)
dc56c706                               (8 chars)
fe2c1406                               (8 chars)
4078dae1-9e35-4c35-87d7-e3543b15385f   (full UUID, not in trusted catalog)
```

The truncated forms match the short ids the observer also used inside memory payload `origin` fields, which suggests the model carried its own shorthand into the evidence submission path. The backend authority gate correctly refused all four rather than binding unverifiable evidence. Follow-up should state explicitly in the prompt that `evidence_message_id` must be copied verbatim and in full from the trusted batch.

## Conclusion

Canary 02 passes. Continuing from the Canary 01 checkpoint under identical authority, the run produced 5 accepted canonical memories with 16 bound evidence records, correctly rejected 4 unverifiable evidence submissions at the authority gate, created no unexpected ledger files, preserved `haru:haru 600` ownership on all canonical files appended to by `root`, and left the entire live observer cursor/state byte-for-byte unchanged.
