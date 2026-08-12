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

## R1 follow-up — cross-provider operator override pairing

Reviewer R1 identified one remaining compatibility seam at implementation head `202c3fbcaa1ed5612b92f00a937cb57fda940e0a`: `LETTA_MODEL` could select a cross-provider model while managed reconciliation still compared and emitted the canonical DeepSeek `model_settings.provider_type`.

The repair treats the effective model and model-settings discriminator as one runtime choice. The canonical model still uses the provider discriminator authored in `Subconscious.af`. A non-canonical `LETTA_MODEL` override resolves its discriminator from Letta's own `/models` metadata; no static provider-name mapping is introduced. This matters because a handle prefix is not necessarily the discriminated provider type: on the canary server `openai-proxy/glm-5.2` reports `provider_type = openai`.

When a model change is required, managed reconciliation now carries `model`, the desired `context_window_limit`, and provider-valid `model_settings` in the same PATCH. The context value is deliberately included even when the pre-change agent already had the desired limit, because real Letta 0.16.8 evidence showed that a model PATCH can otherwise reset the effective context window to the new model's default.

The focused regression uses the genuinely cross-provider override `openai-proxy/glm-5.2`. Starting from canonical DeepSeek state, the first reconcile emits the override model plus `model_settings.provider_type = openai`, `parallel_tool_calls = true`, and canonical context. The second reconcile emits no PATCH. The override provider discriminator is re-resolved from Letta metadata rather than trusting potentially stale agent state, so a mismatched runtime discriminator remains repairable.

### Real Letta 0.16.8 R1 canary

Two disposable real-runtime scenarios passed without `LETTA_CONTEXT_WINDOW` being set:

1. Existing canonical DeepSeek agent -> `LETTA_MODEL=openai-proxy/glm-5.2`: the first managed reconcile converged in one PATCH to model `openai-proxy/glm-5.2`, `model_settings.provider_type = openai`, `parallel_tool_calls = true`, and effective context 400000. A second reconcile reported that the managed runtime already matched and emitted no corrective PATCH.
2. Fresh isolated HOME with `LETTA_MODEL=openai-proxy/glm-5.2`: `importDefaultAgent` succeeded, Letta materialized the matching OpenAI model-settings discriminator, and managed reconciliation preserved the override while applying effective context 400000.

A real `session_start.ts` run against the fresh GLM 5.2 override agent created a Letta conversation containing system, user, reasoning, and assistant messages. Letta logged an HTTP 200 LLM request through the configured OpenCode Go chat-completions endpoint. This confirms that the cross-provider pairing is not merely schema-valid; the resulting agent can execute a Subconscious session turn.

### R1 tests

Focused managed-agent regression set: 50/50 passed.

The final exact code was then exercised across all 34 repository test files. Because the tunnel backend service itself has a low task cgroup ceiling and can be evicted by one large Vitest invocation, the same suite was run in four sequential bounded batches with one Vitest worker; concurrency tests still spawned their own independent writer processes. Aggregate result: 34 test files passed, 282 tests passed.
