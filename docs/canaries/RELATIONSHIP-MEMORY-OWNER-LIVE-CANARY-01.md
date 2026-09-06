# Relationship Memory Owner Live Canary 01

Date: 2026-08-08

Status: **LIVE PROVEN WITH TRANSIENT CANARY SHIMS**

This document records the first Owner-authorized live proof of the Task 086 relationship-memory scaffold. It is an evidence report, not a normative architecture replacement and not a claim that the current `main` works live without the corrections identified below.

## Repository baseline

Target repository:

```text
kannch8765/claude-subconscious-wip
```

Canonical repository baseline remained unchanged throughout the canary:

```text
main = 69b0eb973116ebb8e13e34f05ee53b19b31c56ee
```

The live experiment used an isolated VPS canary copy. No canary shim was committed to canonical `main` during the experiment.

## Canary goal

Prove the real end-to-end boundary:

```text
natural Claude Code interaction
→ Stop async hook
→ detached Letta Code SDK worker
→ real Subconscious observer model
→ memory_search / memory_remember client tools
→ trusted relationship-memory validator/store
→ durable accepted outcomes + evidence
→ batch completion + cursor decision
→ deterministic projection
→ fresh-session recall from projection
```

The canary intentionally distinguished model prose such as “I remember” from trusted `memory_remember` outcomes. Only durable trusted-store records count as memory-write success.

## Live environment

Observed live components included:

```text
Claude Code CLI: 2.1.220
Letta self-host server: 0.16.8
Letta Code SDK installed from repository lock: 0.1.11
LLM: DeepSeek V4 Flash through OpenCode Go
working Letta model handle: opencode-deepseek/deepseek-v4-flash
embedding: local paraphrase-multilingual-MiniLM-L12-v2 padded to 768
background streaming: Redis-backed
relationship store: isolated canary directory
```

No provider API key or other credential is recorded in this document.

## Provider/runtime blockers resolved during the experiment

These were live-environment findings. They are not all relationship-memory repository defects.

### 1. DeepSeek V4 Flash regional entitlement

Before Owner opt-in, the OpenCode Go route rejected DeepSeek V4 Flash. After the Owner enabled the required China-hosted model opt-in in the provider console, the same model/key path returned HTTP 200 and a direct `DSV4_OK` probe.

### 2. Letta Redis Python dependency

The self-host server was configured for Redis-backed background streaming but initially lacked the Python Redis client dependency. After the isolated canary environment gained the required package, server logs reported:

```text
Redis client initialized
```

This converted earlier worker runs from retryable background-stream failures into normal SDK runs.

### 3. DeepSeek thinking/tool continuation adapter

Treating `deepseek-v4-flash` as a generic OpenAI-compatible model was insufficient for tool continuation. The first tool call could execute, but the following provider request failed because DeepSeek thinking mode requires `reasoning_content` continuity during the active tool turn.

Letta 0.16.8 already ships a dedicated `DeepseekClient` whose implementation preserves reasoning content through active tool turns and removes it when a new user turn begins.

The successful route used:

```text
provider type: deepseek
model endpoint type: deepseek
model endpoint: OpenCode Go compatible endpoint
model: deepseek-v4-flash
```

A canary-only model-metadata shim was required because Letta's `DeepSeekProvider` hardcoded context sizes only for the official `deepseek-chat` / `deepseek-reasoner` names and therefore did not discover OpenCode's `deepseek-v4-flash` alias. The shim supplied a 30k context value only to expose the model through the dedicated DeepSeek adapter.

This provider-composition issue is separate from the relationship-memory correction described later.

### 4. Parallel tool calls

DeepSeek V4 Flash produced multiple tool calls in a single model step. With `parallel_tool_calls=false`, Letta logged that it truncated three calls to the first call, but the later approval/external-tool path still carried all three original call IDs, causing an invalid-tool-call-ID mismatch.

A diagnostic agent with:

```text
parallel_tool_calls=true
```

successfully executed three `memory_search` calls and continued to a normal successful result. The final canary therefore used parallel tool calls.

This is provider/model configuration, not a change to trusted relationship-memory semantics.

## Relationship-memory integration gaps discovered

After provider/runtime transport was healthy, the canary exposed two narrow repository/SDK contract gaps. These are the actionable follow-up for the next implementation task.

### Gap A — SDK 0.1.11 drops the top-level `oneOf` tool schema

The repository already defines a detailed authoritative model-facing schema in:

```text
relationship-memory/src/tools/index.ts
memoryRememberToolSchema()
```

It correctly describes all four schema-version-1 variants with a top-level `oneOf`.

However, the installed Letta Code SDK 0.1.11 external-tool serializer reduces a tool schema to only these top-level fields:

```text
type
properties
required
additionalProperties
description
```

It does not forward a top-level `oneOf`.

Consequence: the observer effectively saw `memory_remember` as an empty object contract. In a live run it correctly recognized the relationship event and repeatedly attempted `memory_remember`, but had to discover the proposal contract one rejection at a time. Trusted outcomes included rejections such as:

```text
unknown_field
invalid_schema_version
invalid_summary
invalid_participants
invalid_evidence_message_ids
invalid_payload
unknown_payload_field
invalid_payload_field
```

The trusted validator behaved correctly; the problem was that the observer was not receiving the contract already present in repository code.

For the successful canary only, the model-facing schema was replaced with an SDK-compatible top-level object surface containing the proposal fields and kind-specific payload field descriptions. The authoritative trusted `validateProposal()` logic was not weakened or bypassed.

### Gap B — canonical evidence IDs were trusted but not model-visible

The worker payload already contained:

```text
canonicalMessages[]
  conversation_id
  message_id
  role
  quote
  captured_at
```

and the trusted runtime correctly used those exact messages to validate `evidence_message_ids`.

But the observer-facing `payload.message` included transcript text without those canonical UUIDs. Therefore the observer had no valid way to name the trusted evidence records required by `memory_remember`.

The pre-correction live run reached a semantically valid inside-joke proposal and then failed with:

```text
unresolvable_evidence
```

because the observer had to guess a session-style message ID that did not exist in the trusted batch.

For the successful canary only, the worker message gained a read-only evidence catalog derived from the same trusted `canonicalMessages`, containing exact `message_id`, `role`, and quote. The trusted validator remained authoritative and continued rejecting any evidence ID outside the current trusted batch.

## Successful live memory event

The final proof used a natural relationship-significant interaction. The user designated this phrase as the shared code phrase for the night's joint debugging session:

```text
cobalt-firefly-2849
```

The observer was not explicitly instructed to call a memory API. It independently recognized the event as relationship-memory material, searched for existing canonical records, then proposed records through `memory_remember`.

The trusted store accepted two records.

### Accepted inside joke

```text
memory_id: mem_db656922bdc1e89a4e71e86f
kind: inside_joke
trigger phrase: cobalt-firefly-2849
```

Summary recorded by the observer:

```text
User designated "cobalt-firefly-2849" as the shared code phrase for the night they and the assistant debugged a chain of failures together and rescued the system.
```

### Accepted shared experience

```text
memory_id: mem_563ae51b52681bd96663136f
kind: shared_experience
linked memory: mem_db656922bdc1e89a4e71e86f
```

Summary recorded by the observer:

```text
A late-night debugging marathon where user and assistant together cleared a chain of failures and got the system running.
```

## Trusted evidence binding

Both accepted records were bound to real canonical message UUIDs extracted from the live Claude Code transcript.

```text
user message_id:
8f45862c-472f-424c-93a1-b72df787288d

assistant message_id:
35e354ec-5a34-4e35-87e3-625953f5f1cf
```

The stored evidence retained the exact trusted conversation ID, role, quote, and captured timestamp for each message.

This proves that accepted memory records were not backed by observer-invented evidence identifiers.

## Batch and cursor proof

Successful batch:

```text
batch_id: batch_b3a6ab6bad39103579bc714b
```

Observed durable lifecycle:

```text
pending
→ accepted inside_joke
→ accepted shared_experience
→ completed
```

The detached SDK worker exited normally after finalization.

The adopted source cursor advanced only after trusted completion:

```text
lastProcessedIndex: -1 → 29
```

Earlier live transport failures produced `retryable_failure` and held the cursor, preserving the Task 086 retry semantics.

## Projection proof

After successful completion the worker rebuilt and synchronized projection revision:

```text
projection_361e8844d0134256307e5e34
```

The live Letta agent then contained read-only generated blocks equivalent to:

```text
shared_language
  cobalt-firefly-2849 → shared code phrase for the night the user and assistant rescued the system together

remembered_experiences
  The night we saved the chain → the joint debugging marathon
```

The canonical structured store remained authoritative; projection blocks were generated/read-only views.

## Trusted search proof

A trusted `memory_search` using the code phrase returned both canonical records:

```text
inside_joke: mem_db656922bdc1e89a4e71e86f
shared_experience: mem_563ae51b52681bd96663136f
```

The shared-experience record retained its canonical link to the inside-joke record.

## Replay / duplicate proof

The accepted inside-joke proposal was replayed under a new trusted batch.

Result:

```text
outcome: duplicate
memory_id: mem_db656922bdc1e89a4e71e86f
batch completion: completed
memory count: 2 → 2
```

No duplicate canonical memory was created.

This is live confirmation of the scaffold's idempotent replay/dedupe semantics.

## Fresh-session recall proof

A separate fresh Claude Code run used:

```text
new HOME
new session ID
no prior transcript
no Claude Code built-in tools
same accepted Subconscious agent/store
```

The repository currently has two injection modes with intentionally different behavior.

### `LETTA_MODE=whisper`

`sync_letta_memory.ts` injects new Subconscious messages but does not inject relationship core-memory blocks. A fresh whisper-mode session therefore did not immediately possess the code-phrase projection. This matches the existing implementation and is not a storage failure.

### `LETTA_MODE=full`

A second fresh session used `LETTA_MODE=full`. SessionStart output visibly contained the generated relationship-memory blocks including `cobalt-firefly-2849` and the linked debugging experience.

The user then asked only:

```text
cobalt-firefly-2849 是什么来着？
```

With no old transcript and no tools available, Claude answered that the phrase was the code for the night the user and assistant worked through the DSV4, Redis, Stop-hook, DeepSeek continuation, parallel-tool-call, and observer contract problems together.

This closes the live read path:

```text
canonical memory
→ projection
→ full-mode SessionStart injection
→ fresh-session natural recall
```

## What this canary proves

Live evidence now exists for:

```text
PASS real Claude Code Stop async hook dispatches detached worker
PASS Letta Code SDK external client tools execute against a real observer model
PASS trusted memory_search executes
PASS trusted memory_remember executes
PASS accepted canonical memories persist durably
PASS accepted records bind real transcript message UUIDs
PASS batch pending → completed is durable
PASS completed advances the source cursor
PASS earlier retryable failures hold the cursor
PASS deterministic projection is rebuilt and synchronized
PASS trusted search returns accepted records
PASS replay returns duplicate without creating another memory
PASS full-mode fresh session can recall projected relationship memory
```

## What this canary does not prove

Do not expand this result into claims not tested here.

Still separate or intentionally unresolved:

```text
observer policy tuning: what should or should not become long-term relationship memory
historical transcript ingestion/backfill
production deployment and lifecycle management
OpenCode/DeepSeek provider composition without canary metadata glue
performance/timeout tuning for synchronous prompt hooks
large-scale memory quality, ranking, forgetting, consolidation, or privacy policy
```

The canary also does not authorize changing the four frozen schema-version-1 memory kinds.

## Required next repository correction

The next implementation task should remain narrow and make the successful observer contract possible without transient canary shims:

```text
1. expose memory_remember through an SDK-compatible model-facing schema surface
   while keeping the existing trusted validator authoritative

2. expose the current trusted canonical evidence catalog to the observer
   so it can select exact evidence_message_ids without guessing

3. prove both behaviors with sanitized deterministic repository tests
```

Do not combine that correction with:

```text
Letta observer prompt/policy tuning
provider/model configuration
historical ingestion
new memory kinds
projection redesign
production deployment
```

## Canary verdict

```text
RELATIONSHIP_MEMORY_LIVE_ARCHITECTURE = PROVEN
CURRENT_CANONICAL_INTEGRATION = NEEDS_NARROW_OBSERVER_CONTRACT_CORRECTION
```

The important boundary remains intact: the model may propose, but trusted repository code decides whether a relationship memory is accepted, duplicate, permanently rejected, or retryable; binds evidence; finalizes the batch; advances the cursor; and rebuilds projections.
