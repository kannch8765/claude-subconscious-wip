# Implementation 04 — Backfill runner convergence

结论：普通与 Omen historical backfill 已收敛到 `relationship_memory_backfill_runner.ts`；原两个 CLI 路径保留为薄入口且 import 不再触发执行。checkpoint 绑定、retry conversation rotation、snapshot/canonical/semantic-index preflight 与 observer 调度沿用原流程，没有恢复或调用真实 backfill。

关键改动：`getBackfillAgentId` 新增窄化的 `default | omen` runtime 选择。普通路径继续接受既有 `LETTA_MODEL` / context override；Omen 从 agent import 或已有 agent 的第一次 runtime reconcile 就使用 verified Omen model/provider/context/embedding，并忽略 live runtime override，消除 DeepSeek→Omen 中间切换。Omen verifier 现在先读 effective state；完全匹配时 0 PATCH，漂移时才 PATCH，并轮询验证 model、embedding、context、provider_type 及 model_settings/llm_config 两处 parallel flag。新建 Omen agent 的 import FormData 也直接携带 Omen model。

验证：相关回归 `npx vitest run scripts/backfill_agent_config.test.ts scripts/relationship_memory_backfill_runner.test.ts scripts/backfill_runtime_safety.test.ts scripts/agent_prompt_reconciliation.test.ts` 为 38/38 PASS；新增行为证据覆盖 Omen 新建/已有 agent 不经过普通模型、匹配 0 PATCH、stale GET、live override 隔离、CLI import 无副作用，以及 privileged preflight 失败前无 Letta API。`npm test` 为 422/426 PASS；仅跨进程 concurrency 两组在该 VPS 环境失败，同一 untouched base `d2cd390` 对照同两组为 1/9 PASS（8 fail），故未扩修。仓库无 tsconfig，`npx tsc --noEmit` 仅打印 help，无适用 typecheck target。`git diff --check` PASS。

Reviewer 建议定点看：`scripts/relationship_memory_backfill_runner.ts` 的执行顺序；`scripts/backfill_agent_config.ts` 的 `canonicalForBackfillRuntime`、`configureVerifiedBackfillRuntime` 与 import model override；`scripts/agent_config.ts` 新增的 `useOperatorRuntimeOverrides` 兼容参数。恢复兼容性保持：旧 CLI、checkpoint 格式/agent binding 与 profile 切换不自动重绑均未改变。
