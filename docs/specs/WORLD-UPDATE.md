# World update: a knowledge patch memory kind

Status: design draft, 2026-11-28. Target: the own harness (#146) first. The Letta path is not changed.

## 1. What it is

The foreground agent's world knowledge stops at its training cutoff. After that, office holders change, companies list or
merge, products ship. A `world_update` memory is a **knowledge patch**: a fact about the outside world that the user (or a
tool result) states and that is newer than what the agent may believe.

- Examples (made up): "Country X's prime minister is now B, not A"; "Example Corp is now publicly listed".
- **Not** about the user. The user's own life, plans and status stay in the five relationship kinds.
- Newer facts on the same topic **supersede** older ones automatically. Nothing is overwritten or deleted.

## 2. Data model

One **anchor** per topic, plus an append-only list of **revisions**.

```
world_update memory (anchor, stable memory_id)
  topic: "prime minister of Country X"
  ├─ r1  fact "A"   as_of 2025-…   source user
  └─ r2  fact "B"   as_of 2026-…   source user      ← head
```

**Anchor** = a canonical memory of kind `world_update`.
- Payload: `topic` (required), `fact` (required: the fact at creation; the effective view shows the head's fact), `domain` (optional, e.g. politics / company / product).
- `observed_at` keeps its meaning (time of first evidence). It is not the fact's valid time.

**Revision** = one row in a new append-only file `world-revisions.jsonl`:

| field | meaning |
|---|---|
| `revision_id` | stable id from `(memory_id, fact, as_of, source evidence)` |
| `memory_id` | the anchor |
| `fact` | the fact as stated |
| `as_of` | when this fact started to hold, as far as the evidence says (date; falls back to the evidence time) |
| `source` | `user` or `tool`, derived by the runtime from the cited evidence kinds, never taken from the model |
| `evidence_ids` | the cited transcript events |
| `batch_id`, `recorded_at` | as for other writes |

**Two dates per fact:**
- `as_of`: when this revision started to hold. It changes only with a new revision.
- `last_confirmed`: the latest evidence that the head is still true. A later mention of the same fact moves it forward; it never creates a revision.

**Head** = the latest revision recorded. There is no special handling for mentions of the past: the agent already knows
pre-cutoff facts, and the prompt only asks for new facts (see §5).

`last_confirmed` = the latest `captured_at` over the head's own evidence and every evidence row reinforced onto the anchor
after the head was recorded. It is derived in the projection, not stored.

## 3. Writes (async pass only)

| situation | call | effect |
|---|---|---|
| a new topic | `memory_remember`, kind `world_update` | anchor + revision r1, in one mutation boundary |
| the same fact again | `memory_reinforce` on the anchor | evidence attached; `last_confirmed` moves forward; no revision |
| the fact changed | **new** `memory_world_update(memory_id, fact, as_of?, evidence_ids)` | a new revision, which becomes the head when its `as_of` is latest |

- Sameness of topic is the model's call, the same way reinforce decides "same episode": search `kind=world_update` first, update when found, remember when not.
- `memory_world_update` on a non-`world_update` memory → `permanently_rejected`, new code `not_world_update`.
- A `fact` equal to the head's (normalized) → `duplicate`, with a hint to use `memory_reinforce`.
- **Evidence:** only `user_text` and `tool_result`. `assistant_text`, `assistant_tool_use`, `self_note` and `meta_text` are rejected for this kind (new code `untrusted_world_source`, whole call, before any write, like `not_citable_evidence`). The agent's own beliefs are never a source.
- `source` = `tool` when any cited event is a `tool_result`, else `user`.
- Idempotency, `.canonical-mutation.lock` and the write order follow the existing remember / reinforce paths.
- An anchor created or given a new revision in a pass becomes session-known, like a newly remembered memory: Kohaku just heard the fact, so it is not whispered back to her in that session.

## 4. Relations

| between | allowed | why |
|---|---|---|
| world ↔ world | `related`, `unrelated`, `same_meaning` | `same_meaning` = two anchors for one topic made by mistake. The merge unions both revision lists in one chain, ordered by `as_of`. |
| world ↔ any other kind | `related`, `unrelated` only | different axis; a merge or `changed_over_time` would break the revision chain |
| revision ↔ revision | not a relation | revisions live inside one anchor; the chain is the supersede history |

`changed_over_time`, `conflict` and `context_dependent` with a `world_update` member are refused in
`suggest_memory_relation` validation (new code `invalid_world_relation`).

## 5. Search and whisper

- Search and the effective view show the anchor with the **head only**: `topic`, `fact`, `as_of`, `last_confirmed`, `source`, and a revision count. History is not shown.
- Index text = topic + head fact. A new head re-queues the anchor for embedding (`pending_embed`, as for new memories).
- Whisper rendering for this kind is the **timeline** of the anchor, oldest first, no quotes needed. Storage is unchanged; only the text Kohaku gets shows the chain:

  ```
  （知识补丁）<topic>
  · <as_of r1> 起：<fact r1>
  · <as_of r2> 起：<fact r2>　← 最新（截至 <last_confirmed>）
  ```

  The dates tell Kohaku how fresh each step is, so a whisper of the current head is fine even in a turn where the user states a newer fact (async then writes the new revision). The timeline starts at the first patch; pre-cutoff knowledge is not stored.
- Session-known, the known-skip and the sync-lane mask work as for any memory.
- **Prompt principle:** say what to record, in positive terms only: a new fact about the world that the user tells Kohaku or that a tool result shows. No list of things not to do; the runtime guards (§3) stay silent in the prompt, because naming a mistake the model would not think of invites it.
- Prompt (harness): JOB 1 adds "a knowledge patch when its topic comes up and Kohaku might otherwise use outdated knowledge". JOB 2 adds the three write rows above. The EVIDENCE rule "tool-returned claims are not world truth" gets one exception: a tool result may support a `world_update`, and it is stored as `source: tool`.

## 6. Code to touch

- `relationship-memory/src/schema/index.ts`: `MEMORY_KINDS`, `MEMORY_KIND_DEFINITIONS`, `semanticProseFields` (summary and `fact` in Chinese, names as in the source), revision record type, new rejection codes.
- `relationship-memory/src/store/`: `world-revisions.jsonl` (append-only, same write-index rules as other files).
- `relationship-memory/src/tools/index.ts`: remember (anchor + r1), reinforce (world evidence rule), `memory_world_update`, relation validation.
- Projection / effective view and recall: head + `last_confirmed`, index text, `pending_embed` on a new head.
- `harness/pass.ts`, `harness/sync_pass.ts`, `harness/view.ts`: tool, prompt, whisper rendering.
- ⚠️ **Letta exposure:** kind-specific create tools are generated from `MEMORY_KIND_DEFINITIONS`, so adding the kind would also give the Letta agent a `memory_remember_world_update` tool. v1 keeps it out of the Letta tool inventory (`assertRelationshipClientToolInventory` pins the list), and `config/*.md`, the `.af` prompts and `legacy/semantic.ts` stay unchanged.

## 7. Tests (synthetic fixtures only)

- remember → anchor + r1; search shows the head with `as_of = last_confirmed`.
- reinforce with the same fact two weeks later → no revision, `last_confirmed` moves, `as_of` unchanged.
- world_update with a new fact → r2 is the head; r1 is kept; search shows only r2.
- same fact through world_update → `duplicate`.
- `assistant_text` / `self_note` as evidence → `untrusted_world_source`, nothing written; `tool_result` → `source: tool`.
- relation validation per the table; `same_meaning` merge of two anchors → one chain ordered by `as_of`.
- a new head re-queues embedding; whisper renders the timeline (all revisions, oldest first, `last_confirmed` on the head).
- an anchor updated in a pass is session-known afterwards.
- the Letta tool inventory is unchanged.

## 8. Open

- **Tool trust.** A web result can be wrong. v1 stores `source: tool` and does not show it in the whisper.
- **Staleness: not planned.** Updates are lazy: an unused patch may go stale, and the next mention updates it. The whisper's dates already show how old a step is.
- **Letta path.** Only if the harness does not replace it.
