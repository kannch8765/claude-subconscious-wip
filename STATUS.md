# 项目状态

> 本文件是仓库内唯一活跃状态入口。历史实现细节、canary 与调查证据分别归档到 `docs/implementations/`、`docs/canaries/` 与相关历史分支；本页只写当前仍为真的状态。不确定项一律标记为“未确认”。

## 活跃工作线

### Recall

- 现在做到哪：任务 09 的 bundle-first explicit recall 已经通过离线验收并经 PR #84 合入。对应实现报告：`docs/implementations/IMPLEMENTATION-09-EXPLICIT-RECALL.md`。
- 当前阻塞：**真实 canary 尚未执行**。当前 owner 明确的阻塞原因是 memory agent（模型）额度不足；embedding 额度仍可用。这一额度状态不是任务 09 仓库报告中的历史记录，因此此处只作为当前 owner 状态记录，不把它倒写成历史事实。
- 下一步：memory agent（模型）额度恢复后，用隔离 synthetic store / transcript 做真实 service canary，核对真实 semantic-provider recall quality、模型行为与延迟；不得借此触碰 production 记忆数据。
- 指针：branch `task/09-explicit-recall-recovery`；PR #84；最新报告 `docs/implementations/IMPLEMENTATION-09-EXPLICIT-RECALL.md`。

### Whisper

- 现在做到哪：任务 10 已把同一 `memory_search` 命中的 canonical summary 放回 whisper，并保持 `deliver_whisper` 只能引用实际 surfaced 的同一 memory / snippet evidence；PR #85 已合入，offline CI、全量 Vitest 与 typecheck 在该 PR head 通过。
- 当前阻塞：运行态 / production canary **未确认**；PR #85 明确本身没有 deployment、production mutation、model call、embedding call 或 backfill。仓库当前没有独立 `IMPLEMENTATION-10-*.md` 报告，因此报告路径记为“未确认”，不猜测不存在的文件。
- 下一步：如需运行态验收，单独安排 canary / deployment 工单；本状态索引不代替运行态证据。
- 指针：branch `task/10-whisper-memory-summary`；PR #85；最新独立 implementation 报告：未确认（PR #85 为当前可验证交付记录）。

### Infra / CI

- 现在做到哪：任务 08 已通过 PR #83 合入统一 PR offline gate `PR offline CI / offline-ci`，覆盖 bounded full Vitest + TypeScript checking；任务 13 已完成旧 `093AA/AG/AH/AN/AO` CI workflow 的逐个清理。对应报告：`docs/implementations/IMPLEMENTATION-08-UNIFIED-PR-CI.md`、`docs/implementations/IMPLEMENTATION-13-LEGACY-CI-CLEANUP.md`。
- 当前保护规则：owner 于 2026-09-06 直接查看 GitHub settings 确认 `main` 已启用 branch protection，required status checks **只有** `offline-ci`；不含任何 `093A*` 的 `test`。本单未修改 branch protection / required checks 配置。
- 任务 08 legacy 迁移：已完成。任务 13 按一个 workflow 一个 PR 的顺序删除 `093AG`、`093AH`、`093AN`、`093AO`、`093AA`，每一步都在最终 head 上确认 `offline-ci` SUCCESS 后再合入。
- 观察项：任务 12 将 `hybridScore` 在语义分缺失时的回退值改为 `-1`，因此无向量文档会排到已知负相似度之后。backfill 进行中或 embedding provider 处于 cooldown 期间可能出现大批文档无向量；该情形下的排序行为目前无测试覆盖。
- 指针：任务 08 branch `task/08-unified-pr-ci`、PR #83；任务 13 报告 `docs/implementations/IMPLEMENTATION-13-LEGACY-CI-CLEANUP.md`。

## 已知阻塞项

- Recall 真实 canary：尚未执行；当前 owner 状态为 memory agent（模型）额度不足，embedding 额度仍可用。
- Whisper 运行态 / production canary：未确认；PR #85 只提供离线交付证据。

## 命名与流程约定

- `093*` 系列一律视为历史序列，不再新增新的 `093*` 任务编号。
- 新实现任务统一采用 `task/NN-slug` 分支命名。
- 新实现任务统一与 `docs/implementations/IMPLEMENTATION-NN-*.md` 成对交付。
- 状态不再分散追加到多个历史报告作为“当前状态”；当前状态统一更新本 `STATUS.md`，历史报告保持历史证据属性。
- 不确定的运行态、权限、ruleset、provider 状态统一写“未确认”，直到仓库内或外部授权证据可以直接验证。

## 分支现状指针

全部远端分支的任务 11 普查快照见 [`docs/BRANCH-INVENTORY.md`](docs/BRANCH-INVENTORY.md)。
