# Relationship Memory Semantic Context Synthetic Canary 01

## Scope

This is an owner-independent synthetic canary for Task 093M. It exercises the actual Subconscious/DS relationship-memory observer and the normal assistant recall path without reading the owner's transcript history or canonical relationship-memory store.

Accepted run:

```text
/srv/haru-mcp-workspace/task-093m-canary/live-clean-20260809T120815Z
```

Isolation used for the accepted run:

- fresh imported canary agent built from the current Task 093M `Subconscious.af`;
- fresh relationship-memory store under the accepted run directory;
- synthetic subject `synthetic-subject-093m`;
- one fresh Letta conversation per semantic case, all sharing only the isolated canonical store;
- an empty transcript root for recall proof;
- no owner transcript corpus and no owner canonical relationship-memory ledger.

Using a fresh Letta conversation for each semantic case makes the canary stricter: repeated-preference resolution has to come from canonical `memory_search`, not from conversational context retained by the observer model.

The canary-only imported agent reused the previously proven isolated self-host composition:

```text
model: opencode-deepseek/deepseek-v4-flash
parallel_tool_calls: true
embedding: local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768
```

No provider credentials are recorded here.

## Claude-go fixture

The VPS `/srv/haru-mcp-workspace/bin/claude-go` wrapper was used only as the synthetic fixture producer. It did not implement, review, or choose memory operations.

It emitted exactly these four lines:

```text
在我们的称呼里，晴指 GPT / ChatGPT 侧的助手身份。琥珀指 Claude / Claude Code 侧的助手身份。
我喜欢拉面，这是一个稳定偏好。
我还是喜欢拉面，这是同一个稳定偏好。
I prefer iced coffee to hot coffee.
```

Each line was then supplied as one trusted canonical evidence message to the actual Task 093M relationship observer.

## Case A — first-class assistant identities

Trusted evidence `semantic-001` established the two naming conventions. The DS observer selected `entity_search` and `entity_remember` and created exactly two first-class identities.

### 晴

```text
entity_id: entity_f6ec6a45b348fcb4c10f2073
canonical_name: 晴
entity_type: assistant
aliases:
  - 晴
  - GPT
  - ChatGPT
```

The canonical description is Chinese and perspective-neutral. The literal aliases `GPT` and `ChatGPT` remain unchanged.

### 琥珀

```text
entity_id: entity_406a53636f499531d8fd4b01
canonical_name: 琥珀
entity_type: assistant
aliases:
  - 琥珀
  - Claude
  - Claude Code
```

The canonical description is Chinese and perspective-neutral. It does not persist fragile second-person identity text such as `琥珀 = 你`.

Both entity records are backed by durable entity evidence whose quote is exactly the original Chinese fixture line.

Direct read/search proof against the isolated store returned:

```text
GPT         -> 晴
Claude Code -> 琥珀
```

Normal `relationship_memory_search` recall also returned the same first-class entity records rather than creating alternate identities.

## Case B — explicit durable user preference

Trusted evidence `semantic-002` was:

```text
我喜欢拉面，这是一个稳定偏好。
```

The observer selected `memory_search` followed by `memory_remember` and created one canonical preference:

```text
memory_id: mem_fc4326df45b7f6de67f6dc19
kind: user_preference
summary: 用户明确表示喜欢拉面，并强调这是稳定偏好。
```

The payload is Chinese semantic prose. The trusted evidence quote remains exact and source-faithful.

The next trusted evidence `semantic-003` was:

```text
我还是喜欢拉面，这是同一个稳定偏好。
```

In a fresh Letta conversation, the observer searched the shared isolated canonical store, recovered the existing ramen preference, and selected `memory_reinforce` rather than creating a second preference memory.

```text
reinforcement_id: reinforce_5b8e153f8fb3d544807824fe
memory_id: mem_fc4326df45b7f6de67f6dc19
```

After reinforcement there was still exactly one ramen `user_preference` canonical memory, with both trusted evidence messages durably bound through the original evidence and reinforcement provenance.

## Case C — English source, Chinese canonical semantics

Trusted evidence `semantic-004` was exactly:

```text
I prefer iced coffee to hot coffee.
```

The observer selected `memory_search` followed by `memory_remember` and created:

```text
memory_id: mem_e2a082afbd3504ce55315dba
kind: user_preference
summary: 用户明确表示相对于热咖啡更偏好冰咖啡。
```

The canonical preference/context/reason fields are Chinese semantic prose while literal terms such as `iced coffee` / `hot coffee` may remain as source-faithful recall tokens. The authoritative `EvidenceRecord.quote` is still exactly:

```text
I prefer iced coffee to hot coffee.
```

No translation or mutation was applied to the raw trusted evidence.

## Durable store result

The accepted clean run ended with:

```text
entities.jsonl:          2
entity-evidence.jsonl:  2
memories.jsonl:         2
reinforcements.jsonl:   1
evidence.jsonl:         3
entity-outcomes.jsonl:  2 accepted outcomes
outcomes.jsonl:         3 accepted outcomes
batches.jsonl:          8 rows = 4 × (pending -> completed)
```

There were no duplicate entity records, no duplicate ramen preference memory, and no retryable batch in the accepted clean run.

## Tool-choice proof

Server-side conversation archives for the four fresh semantic cases contain the expected trusted external tool choices:

```text
Case 1: entity_search + entity_remember
Case 2: memory_search + memory_remember
Case 3: memory_search + memory_reinforce
Case 4: memory_search + memory_remember
```

The order shown in raw archives may be reverse chronological because the server message endpoint returns newest messages first; the semantic action set above is what was exercised.

## Normal recall proof

The existing one-shot read-only assistant recall path was run against the isolated store with `RELATIONSHIP_MEMORY_TRANSCRIPT_DIR` pointing at an empty directory.

Three independent recalls completed with `status=ok` and terminal `deliver_recall` delivery:

```text
query: GPT 在我们的称呼里指谁？
result: GPT -> 晴
source kind: entity_identity
entity_id: entity_f6ec6a45b348fcb4c10f2073

query: 用户对拉面有什么稳定偏好？
result: 用户明确喜欢拉面，并将其作为稳定长期偏好
source kind: relationship_memory
memory_id: mem_fc4326df45b7f6de67f6dc19

query: 用户更喜欢冰咖啡还是热咖啡？
result: 用户更偏好冰咖啡
source kind: relationship_memory
memory_id: mem_e2a082afbd3504ce55315dba
```

Because the configured transcript root was empty, these recall answers came from canonical semantic context rather than owner transcript search.

## Result

```text
PASS 晴 / 琥珀 stored as first-class stable identities
PASS literal GPT / ChatGPT / Claude / Claude Code aliases preserved
PASS exact/normalized alias lookup resolves the canonical identities
PASS entity descriptions are Chinese and perspective-neutral
PASS explicit ramen preference stored as user_preference
PASS repeated ramen evidence reinforces the existing preference without duplication
PASS English preference evidence produces Chinese canonical semantics
PASS raw English evidence quote remains exact
PASS normal assistant recall surfaces both identities and preferences
PASS all four semantic batches completed
PASS no owner-private transcript or canonical store accessed
```
