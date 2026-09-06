# Live Subcon model-authored semantic search canary 01

Date: 2026-08-14 UTC/JST
PR: #56
Code under test: `02c309f4be8bcdda025fe5cbc40917ec3c768a28`

## Gate

For the real foreground message:

`今天又在喝咖啡><🐾`

verify that the live Subcon model itself issues at least one successfully completed relationship `memory_search`, and that its query is semantic rather than a mechanical copy of the full user message including emoji/punctuation.

## Real client path

The successful canary used the same long-lived Claude Code shape as the Claude-P runtime:

`claude-go -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages`

The Claude process stayed alive after the foreground result so the configured async Stop hook could run normally. The Stop hook automatically executed the PR code path:

`send_messages_to_letta.ts -> send_worker_native.ts -> native @letta-ai/letta-client conversation -> DeepSeek live Subcon -> memory_search client tool`

The Haru workspace had previously reproduced its known `spawn /usr/bin/node EAGAIN` pressure when all unrelated plugin MCP/SessionStart processes were enabled. For this behavior-only canary, an ephemeral harness disabled the unrelated recall/remember MCP servers and non-Stop hooks. The Stop hook and every source file on the path above were byte-identical to PR head `02c309f4...`; no product source was modified for the canary.

No relationship-memory embedding provider was enabled for the isolated empty canary store, so this run did not rebuild/backfill embeddings or consume embedding-provider quota.

## Evidence

The managed canary agent reconciled from the PR AgentFile and reported:

- model: `openai-proxy/deepseek-v4-flash`
- `parallel_tool_calls=true`
- canonical system prompt contains the model-authored semantic-search policy

The automatic Stop path produced a native live payload and spawned the worker. Worker log:

```text
Model relationship memory_search: query="猫 喝咖啡 日常習慣"
```

Counts for this isolated run:

```text
search_count=1
deterministic_prefetch_count=0
```

The corresponding Letta conversation persisted the client-tool result as:

```text
message_type=tool_return_message
status=success
tool_return={"results":[]}
```

Therefore the required search was not merely attempted: the `memory_search` client tool completed successfully.

## Gate result

PASS for the requested semantic-search behavior gate:

- at least one real model-authored relationship search completed successfully;
- the query was coffee-semantic (`猫 喝咖啡 日常習慣`), not the literal `今天又在喝咖啡><🐾`;
- there was no deterministic exact-message prefetch.

After that successful search return, the self-host Letta canary emitted `An error occurred during agent execution.` on the following model continuation. The worker correctly finalized the batch as `retryable_failure` and held the state cursor. This later provider/agent-execution failure is recorded here rather than being hidden or treated as a clean terminal turn; it did not invalidate the search gate above, and the retry safety boundary behaved as designed.

## Added deterministic regression

`native_letta_backfill.test.ts` now also verifies that merely issuing a required `memory_search` is insufficient: if the client-tool execution throws, it returns an error tool result and the native conversation still fails closed with the required search marked incomplete.

Targeted post-change test run:

```text
scripts/live_async_memory_surfacing.test.ts   4 passed
scripts/native_letta_backfill.test.ts         9 passed
2 files, 13 tests passed
```
