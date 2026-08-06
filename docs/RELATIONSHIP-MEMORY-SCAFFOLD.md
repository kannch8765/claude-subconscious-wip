# Relationship Memory Scaffold

## Status

```text
ARCHITECTURE AND ADOPTION CONTRACT
DOCUMENTATION ONLY
NO RUNTIME IMPLEMENTATION
NO MODEL EXECUTION
NO REAL TRANSCRIPT ACCESS
```

## Repository identity

```text
repository:
kannch8765/claude-subconscious-wip

frozen upstream base:
365e7e6e0d788f9f6d5c3066d1421474653081cc

upstream project:
letta-ai/claude-subconscious
```

This document defines the boundary for the first relationship-memory scaffold. It does not authorize deployment, production data access, historical backfill, or modification of the adopted hook and Letta runtime architecture.

## 1. Product purpose

This project is not a second general-purpose work-memory system. It does not initially target project status, TODOs, generic workflow preferences, or ordinary user-profile facts.

Its first product purpose is to preserve a shared conversational world:

- personal experiences described by the user;
- shared experiences that acquire meaning between the user and assistant;
- relationship events that clarify or change the relationship;
- inside jokes, callbacks, and shared language.

The first scaffold recognizes exactly four canonical memory kinds:

```text
personal_experience
shared_experience
relationship_event
inside_joke
```

No additional kinds are authorized by this document.

## 2. Adopted upstream capabilities

The implementation must adopt the existing Claude Subconscious and Letta runtime capabilities instead of reimplementing them.

### Claude Subconscious — adopt

```text
Claude Code hook lifecycle
transcript incremental cursor
session-to-conversation mapping
detached background worker
late-result synchronization
UserPromptSubmit and PreToolUse injection lifecycle
```

### Letta Code / Letta core — adopt

```text
persistent agent identity
persistent conversations
model execution
tool-call loop
agent state restoration
client-side Read / Grep / Glob execution
```

These capabilities are classified:

```text
ADOPT — DO NOT REIMPLEMENT
```

The fork does not bundle or replace the Letta server. It connects to an official compatible Letta runtime through the existing SDK boundary.

## 3. One adopted agent, reconfigured memory surface

The first implementation reconfigures the adopted Subconscious agent. It must not introduce a second relationship-memory agent, a parallel transcript consumer, or a second Letta runtime.

The implementation must preserve:

```text
the existing persistent agent identity
the existing hook lifecycle
the existing worker and conversation lifecycle
the existing Letta SDK/runtime boundary
```

The implementation may change only the agent's memory-facing configuration:

```text
remove default Markdown memory mutation tools
attach memory_search and memory_remember
replace instructions that require mutable Markdown work-memory
expose generated projection blocks as read-only
```

The existing `Subconscious.af` may be narrowly updated or deterministically transformed by an adjacent configuration asset. Either approach must configure the same adopted agent identity. It must not create or run a second agent.

The final configured instructions must not ask the agent to call tools that are absent or forbidden.

## 4. Memory authority boundary

The authoritative memory store must contain structured canonical records and bound evidence.

```text
structured canonical memory records
= authority

source evidence and user quotes
= authority

Letta Markdown memory blocks
= read-only, rebuildable projection

agent-generated guidance
= temporary suggestion, not authority
```

The memory agent must not directly edit the authoritative database, JSONL files, generated Markdown projections, or raw transcript data.

## 5. Default Markdown memory mutation

The configured Subconscious agent must not retain unrestricted access to the default long-term Markdown mutation surface.

The scaffold must demonstrate that the following operations are absent from the configured tool surface or explicitly denied:

```text
memory
memory_insert
memory_replace
memory_rethink
unrestricted memory filesystem create / delete / rename / rewrite
```

Read-only projection blocks may remain visible in the agent context. A trusted renderer may update those blocks through the Letta API after canonical records change.

Read, Grep, and Glob are independent investigation tools and remain available under the existing read-only policy.

## 6. Canonical proposal schema — version 1

The first implementation must implement exactly `schema_version: 1`.

Unknown fields are rejected at every object level. Required strings are trimmed and must remain non-empty. Optional values are omitted rather than set to `null`. String arrays must contain unique, non-empty trimmed strings.

### 6.1 Common agent proposal

Every `memory_remember` proposal must contain:

```text
schema_version        required literal integer 1
kind                  required enum of the four authorized kinds
summary               required non-empty string
participants          required array of one or two unique roles
evidence_message_ids  required non-empty array of unique message IDs
payload               required kind-specific object
linked_memory_ids     optional array of existing canonical memory IDs
```

For schema version 1, `participants` accepts only:

```text
user
assistant
```

The trusted backend maps these roles to canonical identities. Third parties may be described inside the event text but are not canonical participants in schema version 1.

`linked_memory_ids` may contain only canonical IDs returned by previously accepted writes. Temporary proposal references are not supported in schema version 1. A model that creates linked records in one run must create the parent first and use its returned `memory_id` in later calls.

The agent must not submit authoritative values for:

```text
memory_id
subject_id
status
observed_at
created_at
conversation_id
role
quote
captured_at
```

Those values are generated or resolved by the trusted backend.

### 6.2 Evidence binding

Every accepted record must bind to one or more real canonical message identifiers.

```text
evidence_id
memory_id
conversation_id
message_id
role
quote
captured_at
```

The backend resolves `quote`, `role`, conversation identity, and source time from the referenced canonical message. The model cannot submit or overwrite authoritative quote text.

### 6.3 Kind-specific payloads

#### `personal_experience`

Required:

```text
title       non-empty string
experience  non-empty string
```

Optional:

```text
time_text        non-empty string
places           array of unique non-empty strings
themes           array of unique non-empty strings
emotional_tone   non-empty string
why_memorable    non-empty string
recall_triggers  array of unique non-empty strings
```

#### `shared_experience`

Required:

```text
title           non-empty string
event           non-empty string
shared_meaning  non-empty string
```

Optional:

```text
symbols          array of unique non-empty strings
recall_triggers  array of unique non-empty strings
```

Parent or related experiences use the common `linked_memory_ids` field.

#### `relationship_event`

Required:

```text
event    non-empty string
meaning  non-empty string
```

Optional:

```text
prior_context     non-empty string
resulting_change  non-empty string
```

Related experiences or earlier relationship events use the common `linked_memory_ids` field.

#### `inside_joke`

Required:

```text
name             non-empty string
meaning          non-empty string
trigger_phrases  non-empty array of unique non-empty strings
```

Optional:

```text
origin     non-empty string
callbacks  array of unique non-empty strings
tone       non-empty string
```

## 7. Custom tool surface

The first implementation may expose only these two working relationship-memory tools:

```text
memory_search
memory_remember
```

The interfaces must reserve future compatibility for:

```text
memory_reinforce
memory_evolve
memory_get_evidence
```

### `memory_search`

Searches existing canonical records before any write attempt. It may filter by memory kind, participant role, trigger, time, linked memory, or semantic query.

### `memory_remember`

Proposes one new schema-version-1 memory using semantic fields and real evidence message identifiers.

The trusted backend must:

```text
validate the exact kind-specific schema
bind the actual subject and participant identities
resolve evidence from canonical messages
generate IDs and timestamps
reject invented or inaccessible evidence
perform source idempotency and duplicate checks
append an auditable storage event
return the accepted canonical memory_id
record the outcome against the active transcript batch_id
```

The memory agent must not receive direct SQL, filesystem, or unrestricted JSON mutation tools for authoritative memory.

## 8. Trusted transcript-batch acknowledgement

A completed Letta SDK session is not by itself proof that relationship-memory processing succeeded.

Before sending a transcript batch, the adopted worker must create a stable `batch_id` and a trusted pending batch record. The memory backend records tool outcomes against that `batch_id`. After the session stream ends, trusted worker code finalizes the batch as exactly one of:

```text
accepted
no_memory_required
retryable_rejection
permanent_rejection
```

Definitions:

```text
accepted
one or more memory writes were accepted and no retryable backend failure remains

no_memory_required
the session completed normally, no memory write was accepted or rejected,
and trusted finalization observed no attempted relationship-memory mutation

retryable_rejection
at least one proposal failed because of a transient storage, dependency,
or evidence-access error

permanent_rejection
one or more proposals were rejected for invalid schema, invented or inaccessible
evidence, forbidden fields, or another non-transient contract violation,
and no corrected proposal was accepted in the same batch
```

Cursor rule:

```text
accepted             → advance source cursor
no_memory_required   → advance source cursor
retryable_rejection  → do not advance source cursor
permanent_rejection  → do not advance source cursor
```

The first scaffold does not define automated quarantine or maximum-retry policy. It must surface unresolved rejected batches for later correction rather than silently consuming their source messages.

The acknowledgement journal is narrow adoption glue. It must wrap the existing worker cursor lifecycle rather than replacing the transcript scanner or worker architecture.

## 9. Projection model

Canonical records may be rendered into compact, read-only Letta blocks such as:

```text
shared_language
remembered_experiences
relationship_context
```

The projection renderer must be deterministic and must not invoke an LLM.

Recommended lifecycle:

```text
acknowledged memory-agent run finishes
→ canonical revision changed
→ trusted background renderer reads active records
→ renderer rebuilds affected Markdown projection
→ trusted adapter updates read-only Letta blocks
→ projection revision advances
```

A projection can be deleted and rebuilt without losing authoritative memory.

Agent-generated `guidance` may remain separate. Guidance is not copied into the canonical store without a custom memory tool call and valid evidence.

## 10. First scaffold module boundary

The implementation should add an isolated module rather than reorganizing the upstream repository:

```text
relationship-memory/
├─ src/
│  ├─ schema/
│  ├─ store/
│  ├─ tools/
│  ├─ projection/
│  └─ adapter/
└─ tests/
```

Changes to existing upstream hooks, scripts, and agent configuration must be limited to narrow adapter wiring:

```text
attach relationship-memory custom tools to the adopted agent
remove default Markdown mutation tools from the adopted agent
replace conflicting Markdown-mutation instructions
create and finalize trusted batch acknowledgements
trigger projection synchronization after an acknowledged run
```

The upstream hook lifecycle, transcript parser, worker scheduling, agent identity, and Letta conversation behavior must not be redesigned in the scaffold.

## 11. Sanitized acceptance fixture

The first implementation must use a fictional sanitized fixture. It must not include the owner's real memories or transcript excerpts.

Example scenario:

```text
An adult user visited a historic city.
During the trip, the user selected a symbolic gift for a long-term AI companion.
The user explained why including the companion in the gesture mattered.
```

Scripted repository tests may submit three sequential accepted proposals:

```text
personal_experience
shared_experience linked to the accepted personal_experience memory_id
relationship_event linked to the accepted shared_experience memory_id
```

A separate fixture may establish one `inside_joke` record.

## 12. Repository acceptance — required for the first implementation

The first implementation must pass deterministic repository-level acceptance without a real model or a live Letta server:

```text
PASS custom tool definitions register through the adopted SDK/configuration boundary
PASS a deterministic fake/session harness exercises memory_search and memory_remember
PASS the configured adopted agent surface excludes default Markdown mutation tools
PASS the configured instructions do not request forbidden or absent tools
PASS Read / Grep / Glob remain available under the adopted read-only policy
PASS schema_version 1 accepts every valid kind-specific fixture
PASS schema_version 1 rejects unknown fields, empty required strings, and invalid participants
PASS a valid typed canonical record is stored
PASS evidence binds to a real fixture message ID
PASS the authoritative quote is resolved by the backend
PASS linked records use accepted canonical memory IDs
PASS replaying the same source batch does not create duplicate records
PASS accepted and no_memory_required acknowledgements advance the cursor
PASS retryable_rejection and permanent_rejection do not advance the cursor
PASS deterministic renderer produces a read-only projection
PASS canonical records remain authoritative if the projection is deleted
PASS existing upstream tests remain green
```

Repository acceptance proves the implementation, configuration, fake tool-call handoff, storage, evidence, replay, projection, and cursor semantics. It must not claim that a real Letta runtime or real model has executed the tools.

## 13. Owner canary — separately authorized follow-up

A later Owner canary may prove the live adopted combination:

```text
PASS a compatible official Letta runtime loads the reconfigured adopted agent
PASS the explicitly selected model can call memory_search
PASS the explicitly selected model can call memory_remember
PASS the local client-side tool result returns through the real Letta tool-call loop
PASS the sanitized run receives an accepted or no_memory_required batch acknowledgement
```

The Owner canary is not part of the first repository implementation acceptance. It requires separate authorization, an explicitly selected model, isolated sanitized data, and Owner-controlled credentials and runtime configuration.

## 14. Explicit non-goals

The first scaffold must not:

```text
access real Claude Code transcripts
process the owner's existing history
implement the 500 MB historical backfill wrapper
call a real paid model in repository CI
start, deploy, or configure a live Letta server as repository acceptance
claim live-runtime proof from mocks or fake sessions
introduce a second relationship-memory agent
run two memory agents over the same transcript
implement current-prompt memory recall
inject historical raw user quotes into Claude Code
compare memory models
create a complete final taxonomy
create a final relationship summary record
fork or copy Letta core
replace the Claude Subconscious hook architecture
store real relationship-memory databases in Git
```

## 15. Runtime data location

Real runtime data must remain outside Git. A future local default may use a path equivalent to:

```text
~/.local/share/relationship-memory/
├─ memory.sqlite3
├─ checkpoints/
└─ projections/
```

The repository may contain only sanitized fixtures, schema migrations, and temporary test databases.

## 16. Follow-up sequence

After repository acceptance and independent review, follow-up work may be split into separate tasks:

```text
1. Owner canary with an explicitly selected model and isolated data
2. historical backfill wrapper over canonical CCDK batches
3. reinforcement and relationship-evolution tools
4. current-prompt query-aware recall
5. dual-channel injection of distilled memory and raw user quotes
```

None of these follow-up items are authorized by this documentation-only task.
