# IMPLEMENTATION 17：分支普查刷新与状态同步

## 范围

本单只更新 `docs/BRANCH-INVENTORY.md`、`STATUS.md`，并新增本报告。未删除任何 branch 或 tag；未修改代码、测试、workflow、脚本、配置或 package 元数据；未部署、未进入 VPS、未调用真实 Letta / model / embedding provider，也未触碰 production 记忆数据。

基准 main：`44139fd61057a4161130ce81a08a575bac34f41c`。

## 分支普查方法

普查开始时 GitHub MCP `list_branches` 完整分页返回 128 条远端分支（含 `main`）。工作分支 `task/17-inventory-refresh` 随后从该 main 创建，因此不纳入这个基准快照；这是为了避免让普查表自身提交不断改变被记录的 self head。

祖先判定采用 GitHub MCP `list_commits(sha=main, perPage=100)` 完整分页：共 6 页，前 5 页各 100 条，最后 1 页 42 条，总计 542 个 current-main commit。对每个 branch head 做 exact-SHA membership；命中即证明该 head 是当前 main 的祖先。这个证据优先于 PR 状态。

仅在 ancestry 未命中时，才用 PR exact-head 证据继续判定：merged PR => `已合入 main（squash/rebase）`；open PR => `活跃`；closed-unmerged PR => `已废弃`；均无 exact-head 证据 => `无法判定`。没有为了提高收敛率而推测。

该方法也纠正了“PR 状态较弱、祖先关系较强”的冲突，例如 `copilot/fix-105340539-1325012496-84990af1-172e-42e1-9a65-b85a97ea6a46 @ e0637b…` 与 `task/live-subcon-model-authored-semantic-search @ de29b6…` 虽存在 closed-unmerged PR，但 exact head 已在 main ancestry，因此按强证据判为已合入。

## 原 27 条“无法判定”的收敛

其中 6 条由 exact-head ancestry 收敛为 `已合入 main`：

- `docs/relationship-memory-owner-live-canary-01`
- `docs/relationship-memory-scaffold`
- `task/dario-runtime-provenance-gate`
- `task/093ad-ombre-relationship-memory-fill-lane`
- `task/093ag-native-letta-backfill-harness-reconciliation`
- `task/093ag-native-letta-source-concurrency`

其余 21 条仍无足够强证据，保留 `无法判定`；完整清单写在 `docs/BRANCH-INVENTORY.md`，没有猜测补齐。

## STATUS 同步

`STATUS.md` 已同步当前事实：

- Recall 任务 15/16 打点已进入 main；真实 canary 尚未执行，阻塞为 memory-agent 模型额度，embedding 额度可用。
- 多轮 `rank()` 路径仍缺少 `semantic_query_embedding_external` 分项；如 canary 需拆分本地扫描与外部 embedding 耗时，应走 bundle-first 路径。
- 任务 13 的 legacy `093A*` workflow 清理已完成，required check 记录为 `offline-ci`。
- 任务 14 的 `.write-index-v1/` sidecar 与任务 14B 的双 writer 交替实测已登记；同时明确小 N 成本、已有大 store 首写 rebuild 成本，以及混版本/raw-append writer 持续交替仍未测。
- 命名约定如实记录为曾被偏离：远端仍有 `copilot/*`、`investigation/*` 和同一任务的 `-clean` / `-final` 分支；后续新任务应回到 `task/NN-slug`，而不是宣称已经恢复遵守。

## 受保护路径 0 变更证据

本任务交付提交的 changed-path allowlist 仅为：

- `docs/BRANCH-INVENTORY.md`
- `STATUS.md`
- `docs/implementations/IMPLEMENTATION-17-INVENTORY-REFRESH.md`

与禁止修改集合 `src/**`、`scripts/**`、`hooks/**`、`config/**`、`.github/workflows/**`、`package.json`、`tsconfig*.json`、`.mcp.json`、测试文件及其他既有 docs 正文的交集为空，因此受保护路径变更行数为 0。Draft PR 创建后再以 GitHub PR changed-files 回读机械复核这一点。

## CI 验收

本单为零代码变更。最终验收以 Draft PR head 上的 `PR offline CI / offline-ci` check run 为准；最终回传提供 exact head、run 链接及回读的 `head_sha`。

## 剩余项

本单只登记、不实施：

- `rank()` 路径的 embedding 打点覆盖缺口。
- `hybridScore` 语义缺失回退（`-1`）在大批无向量文档场景下的排序行为无专项测试覆盖。
- whisper top-k 无多样性约束，MMR 为候选。
- `transcriptSearch` 全量扫描，一次 recall 最多两遍。
- Store sidecar 的混版本 writer / 不维护 sidecar 的 raw-append writer 持续交替性能未测。
