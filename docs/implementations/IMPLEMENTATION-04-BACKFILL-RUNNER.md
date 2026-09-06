# Implementation 04 — Backfill runner convergence

结论：普通与 Omen historical backfill 已收敛到 `relationship_memory_backfill_runner.ts`；原两个 CLI 路径保留为薄入口且 import 不再触发执行。checkpoint 绑定、retry conversation rotation、snapshot/canonical/semantic-index preflight 与 observer 调度沿用原流程，没有恢复或调用真实 backfill。

关键改动：`getBackfillAgentId` 新增窄化的 `default | omen` runtime 选择。普通路径继续接受既有 `LETTA_MODEL` / context override；Omen 从 agent import 或已有 agent 的第一次 runtime reconcile 就使用 verified Omen model/provider/context/embedding，并忽略 live runtime override，消除 DeepSeek→Omen 中间切换。Omen verifier 现在先读 effective state；完全匹配时 0 PATCH，漂移时才 PATCH，并轮询验证 model、embedding、context、provider_type 及 model_settings/llm_config 两处 parallel flag。新建 Omen agent 的 import FormData 也直接携带 Omen model。

验证：相关回归 `npx vitest run scripts/backfill_agent_config.test.ts scripts/relationship_memory_backfill_runner.test.ts scripts/backfill_runtime_safety.test.ts scripts/agent_prompt_reconciliation.test.ts` 为 38/38 PASS；新增行为证据覆盖 Omen 新建/已有 agent 不经过普通模型、匹配 0 PATCH、stale GET、live override 隔离、CLI import 无副作用，以及 privileged preflight 失败前无 Letta API。`npm test` 为 422/426 PASS；仅跨进程 concurrency 两组在该 VPS 环境失败，同一 untouched base `d2cd390` 对照同两组为 1/9 PASS（8 fail），故未扩修。仓库无 tsconfig，`npx tsc --noEmit` 仅打印 help，无适用 typecheck target。`git diff --check` PASS。

Reviewer 建议定点看：`scripts/relationship_memory_backfill_runner.ts` 的执行顺序；`scripts/backfill_agent_config.ts` 的 `canonicalForBackfillRuntime`、`configureVerifiedBackfillRuntime` 与 import model override；`scripts/agent_config.ts` 新增的 `useOperatorRuntimeOverrides` 兼容参数。恢复兼容性保持：旧 CLI、checkpoint 格式/agent binding 与 profile 切换不自动重绑均未改变。

## Merge acceptance follow-up — 2026-09-05

定点验收补了两处证据缺口：新增共享 runner 级测试，直接固定 `preflight → checkpoint load → agent reconcile/verify → checkpoint binding/retry rotation → batch` 边界，覆盖旧 checkpoint 绑定、retryable checkpoint 换 conversation、checkpoint agent mismatch fail-closed，以及 Omen verification failure 时零 batch；另补 ordinary backfill 默认继续接受 operator context override，live 默认 override 行为继续由既有 managed-runtime 回归覆盖。

Review 同时发现 verifier 对 model/embedding/context 原先只取 top-level-or-effective fallback，可能漏掉 top-level 已匹配但 `llm_config` 仍漂移的状态。现改为所有已出现的 runtime 表示都必须匹配；缺少某一种表示仍兼容，但 top-level/effective 同时存在且任一漂移就不会走 0 PATCH。回归确认 stale effective `llm_config` 会触发修复，而真正 fully matching Omen 仍为 0 PATCH。

Focused acceptance suite（shared runner、runtime safety、backfill agent config、managed live runtime、prompt reconcile、historical checkpoint engine）为 **66/66 PASS**。完整 `npm test` 在清理本轮遗留 test child 后为 **428/432 PASS**；仅 `concurrent-writer-safety` 与 `legacy-ombre-concurrency` 各 2 个 child-process failure。untouched parent `d2cd390bc11aefad3e94e829fac082711e5a049a` 单跑同两组同为 **5/9 PASS、4 fail**，失败类型一致。

按上一单参数执行真实显式 TypeScript 检查：`--target ES2022 --module NodeNext --moduleResolution NodeNext --types node,vitest/globals --skipLibCheck`，并显式列出本单修改/新增 TypeScript 文件。Acceptance 过程中发现并修正 6 个本单测试字面量类型错误；最终 candidate 只剩 `scripts/agent_config.ts(318,113) TS2339`，parent 用同参数和共同文件列表精确也是同一 TS2339，因此本单新增 TypeScript error 为 0；不能表述为仓库全绿 typecheck。

GitHub Actions 对该 branch 当前 **无 workflow run**，且无 PR；branch 中现存 push workflows 仅点名旧 `task/093*` 分支，因此本单没有可声称为 green 的 GitHub CI。代码级定点验收结论：**PASS / 可合并**，但 CI 状态应记录为 no-run 而非 green。未合并、未部署、未恢复 backfill。
