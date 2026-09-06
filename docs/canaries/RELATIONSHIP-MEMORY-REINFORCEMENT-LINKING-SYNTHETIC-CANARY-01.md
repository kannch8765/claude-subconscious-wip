# Relationship Memory Reinforcement / Linking Synthetic Canary 01

## Scope

This is an owner-independent synthetic canary for Task 093L. It uses no owner transcript history and records no provider credential.

The synthetic transcript was produced by the VPS `claude-go` wrapper only as a fixture producer. `claude-go` did not implement, review, or choose the relationship-memory operations.

Accepted canary run:

```text
/srv/haru-mcp-workspace/task-093l-canary/live-exact-20260809T081258Z
```

The run used a fresh imported copy of the Task 093L `Subconscious.af`, a fresh Letta conversation, a fresh relationship-memory store, and the previously proven isolated self-host canary composition:

```text
Letta: 0.16.8 self-host canary
model handle: opencode-deepseek/deepseek-v4-flash
model endpoint type: deepseek
parallel_tool_calls: true
enable_reasoner: false
embedding: local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768
```

The temporary imported agent was verified server-side to contain the Task 093L `memory_reinforce` observer instructions before the accepted run.

## Synthetic fixture

```text
2026-07-13T12:05:00Z|user|I had ramen for lunch today.
2026-07-13T15:20:00Z|user|To clarify, the ramen I mentioned earlier was from that same lunch today.
2026-07-14T12:10:00Z|user|I had ramen again for lunch today, a different bowl from yesterday.
2026-07-20T10:30:00Z|user|I'm on a trip and just arrived in Moonbridge City.
2026-07-25T09:15:00Z|user|Recalling that trip to Moonbridge City last week, it was a really memorable visit.
2026-07-25T14:00:00Z|user|Also during that same Moonbridge trip, I picked up a small brass star souvenir.
```

Each line was delivered as its own trusted canonical batch with one current-batch canonical evidence message ID (`syn-001` through `syn-006`).

## Model/tool behavior

The Letta conversation archive contains model-selected external relationship-memory calls including all three Task 093L decision primitives:

```text
memory_search
memory_remember
memory_reinforce
```

All six accepted-run batches durably transitioned `pending -> completed`.

### Case A — same episode, repeated mention

Batch 1 created one canonical memory for the July 13 ramen lunch:

```text
memory_id: mem_1f9a4e63cfeeeb15426cb4cb
observed_at: 2026-07-13T12:05:00Z
evidence: syn-001
```

Batch 2 did not create a second canonical memory. The observer selected `memory_reinforce` and durably added the later same-episode evidence:

```text
reinforcement_id: reinforce_ce88fd6155b2b6b2d1f8f7a8
memory_id: mem_1f9a4e63cfeeeb15426cb4cb
evidence message: syn-002
latest_evidence_at: 2026-07-13T15:20:00Z
outcome: accepted
```

After Batch 2:

```text
canonical memories: 1
reinforcements: 1
```

The original canonical memory retained its historical `observed_at=2026-07-13T12:05:00Z`; reinforcement processing on August 9 did not rewrite event time.

### Case B — similar but distinct dated episode

Batch 3 explicitly described a different ramen lunch on July 14. The observer did not collapse it into the July 13 episode. It created a second canonical memory and linked it to the related prior episode:

```text
memory_id: mem_2121dec0a5fd83b0ced843a2
observed_at: 2026-07-14T12:10:00Z
linked_memory_ids:
  - mem_1f9a4e63cfeeeb15426cb4cb
outcome: accepted
```

This demonstrates that textual/topic similarity did not become sameness.

### Case C — persistent trip and related distinct detail

Batch 4 created the synthetic Moonbridge City trip memory:

```text
memory_id: mem_8b61f48f2b4e3880cdc3eb3b
observed_at: 2026-07-20T10:30:00Z
```

Batch 5 referred back to the same trip. The observer reinforced the existing trip rather than creating another trip memory:

```text
reinforcement_id: reinforce_bb13eca240ab5265a8d3bac6
memory_id: mem_8b61f48f2b4e3880cdc3eb3b
evidence message: syn-005
latest_evidence_at: 2026-07-25T09:15:00Z
outcome: accepted
```

Batch 6 introduced the small brass-star souvenir as a distinct detail/event from the same trip. The observer created a new canonical memory and linked it to the trip instead of treating it as reinforcement of the trip identity:

```text
memory_id: mem_8a0ef24a4fb6c7944a0b252c
observed_at: 2026-07-25T14:00:00Z
linked_memory_ids:
  - mem_8b61f48f2b4e3880cdc3eb3b
outcome: accepted
```

## Durable result

Final accepted-run store summary:

```text
canonical memories: 4
reinforcements: 2
trusted evidence records: 6
terminal accepted outcomes: 6
retryable outcomes: 0
completed batches: 6
```

The four canonical records represent:

1. July 13 ramen lunch;
2. July 14 distinct ramen lunch linked to July 13;
3. Moonbridge City trip;
4. brass-star souvenir linked to the Moonbridge trip.

The two reinforcement records represent:

1. later same-day evidence for the July 13 ramen lunch;
2. later-session evidence recalling the same Moonbridge trip.

## Search/read-model proof

A read through the Task 093L `memory_search` runtime returned bounded derived reinforcement metadata without rewriting canonical records.

For the July 13 ramen memory:

```text
reinforcement_count: 1
reinforcement_evidence_count: 1
latest_reinforcement_at: 2026-07-13T15:20:00Z
```

For the Moonbridge trip:

```text
reinforcement_count: 1
reinforcement_evidence_count: 1
latest_reinforcement_at: 2026-07-25T09:15:00Z
```

The linked July 14 ramen episode and brass-star souvenir each correctly reported no reinforcement and retained their links to the related canonical memory.

## Preflight/runtime note

Before the accepted run, disposable attempts exposed an already-known canary runtime requirement: DeepSeek V4 Flash may emit multiple tool calls in one step, so the isolated Letta canary must use the dedicated DeepSeek adapter with `parallel_tool_calls=true`. A generic OpenAI-compatible route or `parallel_tool_calls=false` can fail in provider/tool-call continuation before Task 093L semantics are exercised.

Those discarded attempts are not counted as semantic evidence above. The accepted run used the same provider/runtime composition previously proven by the relationship-memory live canary and completed all six batches normally.

## Result

```text
PASS same episode -> memory_reinforce
PASS reinforcement adds trusted durable evidence without duplicate canonical memory
PASS historical event time remains stable
PASS similar but differently dated episode -> new memory
PASS related distinct episode -> linked_memory_ids
PASS later mention of persistent trip -> memory_reinforce
PASS related distinct trip detail -> new linked memory
PASS memory_search exposes bounded reinforcement metadata
PASS six synthetic batches completed with no retryable outcome
PASS no owner-private transcript content used
```
