# Task 093AC — managed Subcon runtime config reconciliation

## Why 093M looked successful but drift returned

The accepted 093M synthetic canary documents a fresh isolated agent running `opencode-deepseek/deepseek-v4-flash`, local FastEmbed, and parallel tool calls. The 093M repository change to `Subconscious.af`, however, changed semantic prompt/description content only; the serialized runtime fields still described `zai/glm-5`, the old OpenAI embedding, and disabled parallel tool calls. In other words, the successful runtime settings lived in canary/live agent state, not in the repository AgentFile authority.

Task 093V later made `Subconscious.af` authoritative for the managed **system prompt** and reconciled only that field. The dedicated backfill path likewise imported the AgentFile and then reconciled tags/prompt. This explains the asymmetric behavior: prompt/tags converged, while a newly imported managed agent could revive stale model/embedding/context/parallel settings.

## Corrected authority chain

`Subconscious.af` now carries current AgentFile fields for the managed model handle, embedding handle, context-window limit, and parallel tool policy. The deprecated embedded `llm_config` / `embedding_config` snapshots are cleared rather than kept as a competing configuration copy. Import paths provide the canonical model/embedding as import-time overrides so stale/deprecated serialized provider details cannot prevent creation before reconciliation.

Both the normal managed-agent resolver and the dedicated historical-backfill resolver call the same `reconcileManagedAgentConfiguration` boundary after ownership is established. It compares system, model, embedding, context, and parallel-tool policy and PATCHes only drifted fields. Ordinary external `LETTA_AGENT_ID` values remain outside this mutation path. Existing explicit `LETTA_MODEL` and `LETTA_CONTEXT_WINDOW` operator overrides remain supported.

The default context limit is 400000: large enough to address the 093M-era semantic-tool compaction failure called out by the dispatch while remaining a bounded project default rather than an asserted provider maximum. Operators can override it explicitly.

## Regression proof

`managed_runtime_config.test.ts` starts from the observed stale combination (`zai/glm-5`, OpenAI embedding, 90000 context, parallel disabled) and requires one managed reconciliation PATCH to converge to the canonical AgentFile policy. It also proves model/context overrides remain respected. Dedicated-backfill tests model the same stale state and require the shared runtime reconciliation in addition to its purpose tag.
