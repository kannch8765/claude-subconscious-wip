# Task 093AQ — Letta 0.16.8 model-settings import compatibility evidence

## Scope

This task fixes the fresh managed-agent import failure introduced when Task 093AC made `Subconscious.af` authoritative for model settings. The canonical AgentFile remains the runtime authority; no deployment-only or `/tmp` payload workaround is used by the product code.

Base: `92fa088d58b54d42e39a940f0d9cd2e24894cfc2`.

Runtime under test:

- Letta server: `0.16.8`
- Letta client: `1.12.1`
- Letta API: `http://127.0.0.1:8283/v1` on the isolated self-host canary

No production Subconscious agent or historical backfill agent was used for the canary.

## Reproduction

Importing the pre-fix canonical `Subconscious.af` with its existing model/embedding overrides returned HTTP 400 before agent creation:

`agents.0.model_settings: Unable to extract tag using discriminator 'provider_type'`

The live Letta 0.16.8 OpenAPI schema confirms that `AgentSchema.model_settings` is a discriminated union keyed by `provider_type`. The pre-fix canonical value was only `{ "parallel_tool_calls": true }`, so it was not a valid union member.

## Minimal compatibility result

Two transport experiments separated the failure mode:

1. Setting `model_settings` to `null` allowed import (HTTP 200), proving that this field was the blocking schema seam.
2. Keeping canonical model settings and adding `"provider_type": "deepseek"` also allowed import (HTTP 200).

The second result is the adopted fix because Letta itself materializes the imported `opencode-deepseek/deepseek-v4-flash` agent with `model_settings.provider_type = "deepseek"`. This makes the canonical AgentFile valid instead of introducing a version-specific stripping path.

`reconcileManagedAgentConfiguration` now also treats the model-settings provider discriminator as managed state. When it must repair provider/parallel drift, the PATCH contains a valid discriminator. Same-provider settings preserve existing extra settings; cross-provider drift uses only the canonical provider and parallel policy so provider-specific stale fields are not carried across.

## Real fresh-agent application-path canary

A fresh isolated HOME ran the actual `getAgentId()` path from the repaired worktree:

`no saved ID -> importDefaultAgent -> rename/tags -> reconcileManagedAgentConfiguration -> model availability check`

It succeeded. The created disposable agent resolved to:

- model: `opencode-deepseek/deepseek-v4-flash`
- embedding: `local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768`
- `model_settings.provider_type`: `deepseek`
- `model_settings.parallel_tool_calls`: `true`
- effective `llm_config.context_window`: `400000`
- tags include `origin:claude-subconcious` and `git-memory-enabled`

Letta 0.16.8 reports `context_window_limit` itself as null after the PATCH while the effective `llm_config.context_window` is 400000; the existing reconciliation fallback correctly reads the effective value and becomes idempotent on the next pass.

## Session and Claude-Go evidence

Running `session_start.ts` alone against the fresh canary completed in about 2.5 seconds and created a real Letta conversation containing system, user, reasoning, and assistant messages.

A normal tunnel-launched Claude-Go run exposed a separate harness resource limit: `haru-mcp-workspace.service` has `TasksMax=128`, and Claude plus the two parallel SessionStart `npx -> tsx` hook chains can transiently exhaust that cgroup. PostgreSQL logged `could not fork new process for connection: Resource temporarily unavailable`; this is not the AgentFile bug.

For end-to-end proof without changing product code, a disposable copy of the plugin serialized those two SessionStart commands and used reduced Node thread pools. Claude-Go then returned exactly `CLAUDE_GO_093AQ_FULL_CHAIN_OK`; SessionStart exited 0 in about 4.2 seconds, UserPromptSubmit exited 0, and the fresh Letta agent gained a new conversation with system/user/reasoning/assistant messages. The serialized hook copy exists only in the disposable canary directory and is not part of this branch.

## Tests

Focused managed-agent tests: 50/50 passed.

Full suite under the tunnel cgroup used one Vitest file worker plus reduced Node thread pools while leaving the concurrency tests themselves intact:

`NODE_OPTIONS='--v8-pool-size=1' UV_THREADPOOL_SIZE=1 vitest run --maxWorkers=1`

Result: 34 test files passed, 282 tests passed.

An unconstrained full-suite run hit the same cgroup `pthread_create`/EAGAIN limit in child Node processes used by the concurrent-writer tests; rerunning under the bounded harness passed those tests without code changes.
