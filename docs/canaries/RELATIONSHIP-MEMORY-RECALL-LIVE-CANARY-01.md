# Relationship-Memory Recall Live Canary 01

Task: 093J — Assistant Relationship-Memory Recall
Frozen target: `0b742b41c3644ea5ed517c6d3f85c773d188d285`
Canary date: 2026-08-08 UTC / 2026-08-09 JST

## Scope

This canary exercised the read-only recall implementation from a real Claude Code client through the local stdio MCP and the existing self-host Letta + DeepSeek V4 Flash canary runtime. It used an isolated subject, relationship-memory store, HOME, project directory, and direct transcript JSONL fixture under:

`/srv/haru-mcp-workspace/letta-selfhost-canary/runs/20260808T171136Z-093j-recall-worker`

The owner's production relationship-memory store was not used.

The isolated fixture contained:

- one canonical `shared_experience` linked to a trusted Task 093I assistant remember-intent whose distinctive `feel.text` says the assistant felt "quietly delighted and deeply included" about `amber-lantern-4907`;
- direct Claude transcript JSONL containing two visible August 4 messages about the relationship-memory architecture and one unrelated August 5 message.

## MCP discovery

Final worker-tree health check through Claude Code reported both plugin MCP entries connected:

```text
plugin:claude-subconscious:relationship-memory-intent ... ✔ Connected
plugin:claude-subconscious:relationship-memory-recall ... ✔ Connected
```

The 093J recall server advertises one Kohaku-facing tool only:

`recall({ query: string })`

For the two end-to-end print-mode canaries below, Claude Code was launched with an isolated `--mcp-config --strict-mcp-config` containing only the recall stdio server. This avoids unrelated cold-start process pressure from starting both plugin MCP servers inside the VPS Haru workspace cgroup while still exercising the required real path:

`claude-go -> Claude Code -> local stdio recall MCP -> recall runtime -> self-host Letta + DSV4 Flash -> read tools -> deliver_recall -> original tool_result -> Claude Code`

The canary MCP config contained only command/path metadata and no credential values.

## Canary A — relationship memory + feeling

Claude Code session: `665083cc-d4c7-4f93-a8a8-40d629b06be2`
Recall run: `recall_53f8d00f-1ca2-46ec-aa58-8ac305d20ab6`

Natural-language query passed by Claude Code:

> What did amber-lantern-4907 mean to us, and how did I feel about it?

Claude Code's stream-json evidence shows:

1. MCP server status `connected` and tool `mcp__relationship-memory-recall__recall` present in the init tool list.
2. Claude Code emitted a real `tool_use` for that MCP tool with the exact query.
3. While the synchronous MCP call was pending, Claude Code emitted a 30-second tool heartbeat rather than ending the turn.
4. The recall runtime executed trusted read tools, including `relationship_memory_search`, transcript investigation, a bounded `transcript_read`, and terminal `deliver_recall`.
5. The original MCP call returned a same-invocation `tool_result` with `structuredContent.status = "ok"`, the matching recall ID, trusted source refs, and the synthesized answer.
6. Claude Code then continued the same invocation and answered from the tool result.

The returned synthesis correctly identified `amber-lantern-4907` as the shared canary promise / marker of inclusion and continuity and retrieved the linked assistant-originated feeling: "quietly delighted and deeply included."

## Canary B — August 4 timeline + bounded transcript read

Claude Code session: `dd0e9250-01de-4251-bb30-1dda4d28a08d`
Recall run: `recall_93f9d4ff-98a9-45f4-8169-9b5109309ab7`

Natural-language query passed by Claude Code:

> What happened on August 4, 2026 in our relationship-memory work? Use the transcript history and verify the surrounding context.

Claude Code's stream-json evidence again shows a connected recall MCP, a real `tool_use`, 30-second and 60-second pending-call heartbeats, a same-invocation successful `tool_result`, and a final Claude answer after that result.

The DSV4 recall runtime's trusted-tool execution log for this recall includes:

```text
relationship_memory_search
transcript_search
transcript_read
transcript_read
...
deliver_recall
terminal delivery received
```

The answer correctly separated two trusted-source threads instead of conflating them:

- direct transcript evidence at 08:30–08:31 UTC: relationship memory should read Claude transcript JSONL directly, without a CCDK runtime dependency, and durable canonical memory remains separate from read-only historical transcript recall;
- canonical relationship memory at 12:09 UTC: the `amber-lantern-4907` shared canary promise, explicitly identified as canonical-memory evidence rather than a direct transcript hit.

The returned transcript source metadata names the August 4 user/assistant messages and excludes the unrelated August 5 fixture message.

## Read-only ledger proof

The seven write-side relationship-memory ledgers were hashed after fixture seeding and again after the direct runtime probes plus both full Claude Code MCP canaries. Every file remained byte-identical:

| Ledger | Final SHA-256 | Bytes |
| --- | --- | ---: |
| `memories.jsonl` | `19819c98e2a8d9802ddb2af2298ea65720c842241da1d5640ce2e01f11f5d6dd` | 686 |
| `evidence.jsonl` | `13962ec51ecd14ad9a493015638a4a2abdfd00c5a8ce6f5c54f89e3a41265707` | 270 |
| `outcomes.jsonl` | `09659e0e3c2a2ebb3432efa70c490a057037c7f5d2bf2afeb986ceea5b407d6f` | 175 |
| `batches.jsonl` | `344c5d8b87112451673efae5a73458daebf21c82666b5d9daa20a2c2948b4b3c` | 214 |
| `owner-revisions.jsonl` | absent before and after | 0 |
| `assistant-intents.jsonl` | `b1bcfa705ac027eef43581835a7c8457ea8875c09f4521d13993f8311c0f7567` | 525 |
| `assistant-intent-outcomes.jsonl` | `b58d834d640e5f6e5cfc3ac6dce525cfe5d9e16d9fbb40e5ae36bfcfe34fdf24` | 168 |

Comparison result: `all_ledgers_unchanged = true`.

`LETTA_MODE=off` was used for the Claude Code canary client so the unrelated asynchronous observer/Stop-hook channel could not mutate the isolated fixture while recall was being measured. The recall runtime itself does not inspect this switch and remained fully active.

## Failure/lifecycle observations

Before the successful compatible-agent runs, one existing canary agent/provider path surfaced a Letta 0.16.8 tool-call-state error, and one attempt encountered a transient canary PostgreSQL connection error. These were surfaced as bounded failed recall calls; no write ledger changed. The final A/B canaries used the already-established compatible DeepSeek V4 Flash canary agent/provider path and both completed successfully.

The Haru workspace service has a canary-specific `TasksMax=128`. Parallel unrelated canary work temporarily pushed that cgroup near its process/thread ceiling and caused a Node thread-start failure during one retry. The retry was performed only after process pressure dropped; no product code or service limit was changed to obtain the pass.

After the final canaries, no 093J `recall_mcp` or `recall_runtime` process remained.

## Deterministic coverage paired with this canary

The implementation test suite covers:

- narrow stdio `recall` discovery and pending-call behavior;
- canonical search over linked Task 093I `memory.text` and `feel.text`;
- owner-deactivated memory exclusion;
- direct JSONL date/time search and bounded trusted read-back;
- hidden/system/thinking content exclusion;
- fabricated source-handle rejection;
- wrong recall ID and duplicate terminal delivery rejection;
- timeout/cancel terminal closure and late-delivery rejection;
- explicit model/Letta transport failure;
- byte-for-byte no-write invariants across all seven relationship-memory ledgers;
- preservation of the separate Task 093I remember MCP/tool-name contract.

Final worker test run before handoff: 126 tests passed across 12 files, with targeted TypeScript compilation of the recall/runtime/MCP files also passing.

## Credential handling

No API key, bearer credential, or secret value is included in this document. Recall runtime error logging applies bounded redaction before recording provider/transport failure text.
