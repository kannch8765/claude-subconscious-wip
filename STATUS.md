# 项目状态

状态基准：`main @ 83bfc7114de3e33d3cb072700dc2fd3af36f3c31`。本文件只记录当前可由仓库证据或本任务明确 owner 状态声明支撑的事实；不能确认的内容写“未确认”。

## 活跃工作线

### Recall

- 现在做到哪：显式 relationship recall 的 bundle-first recovery 已由 PR #84 合入。`docs/implementations/IMPLEMENTATION-09-EXPLICIT-RECALL.md` 的合并前定点验收记录了 128 KiB 初始/expand 真超预算、UTF-8 截断、来源约束、总 timeout/cancel、read-only `rankExisting()` 和 deliver_recall 证据边界的离线回归；最终补强回归在干净 runner 上通过。
- 当前阻塞：真实 canary 尚未执行。owner 在任务 11 中明确当前阻塞原因为 embedding 额度不足；PR #84 / IMPLEMENTATION-09 只证明“真实服务 canary 尚未执行”，仓库此前没有独立额度状态报告，因此额度状态的历史仓库证据为未确认。
- 下一步：额度允许后，按 IMPLEMENTATION-09 的限制使用独立合成 store/transcript 做真实服务 canary；不使用 production 记忆数据。
- 对应：branch `task/09-explicit-recall-recovery`；PR #84；最新报告 `docs/implementations/IMPLEMENTATION-09-EXPLICIT-RECALL.md`。

### Whisper

- 现在做到哪：PR #85 已合入 canonical memory summary → historical evidence 的 whisper rendering，且 final-head `offline-ci` 与全量 Vitest / typecheck 通过。PR 明确未执行 deployment、production mutation、model call、embedding call 或 backfill。
- 当前阻塞：运行态 / production canary 状态未确认；PR #85 没有提交独立 `IMPLEMENTATION-10` 报告。
- 下一步：如需把运行态状态从“未确认”提升为已验证，需要另开 canary / deployment 工单；本状态索引单不执行。
- 对应：branch `task/10-whisper-memory-summary`；PR #85；最新报告路径：未确认（仓库中无独立 `IMPLEMENTATION-10-*.md`，当前最新验收证据为 PR #85 本身）。

### Infra / CI

- 现在做到哪：PR #83 已合入统一普通 PR offline gate `PR offline CI / offline-ci`，包含 bounded full Vitest 与硬 TypeScript typecheck；旧 093AA/AG/AH/AN/AO/AP workflows 仍保留。
- 当前阻塞：branch protection / ruleset / required status checks 的真实配置未确认，因此 08 的 required-check 迁移与旧 workflow 收拢仍挂起。GitHub branch 列表只显示 `main protected:false`，不能替代 ruleset / required-check 配置证据。
- 下一步：先取得真实 branch protection / ruleset / required-check 配置，再单独迁移 required check、逐项决定旧 workflow 是否下线。
- 对应：branch `task/08-unified-pr-ci`；PR #83；最新报告 `docs/implementations/IMPLEMENTATION-08-UNIFIED-PR-CI.md`。

## 已知阻塞项

- Recall 真实 canary：尚未执行；owner 当前声明阻塞为 embedding 额度不足。历史仓库报告只证明 canary 未执行，额度状态此前未单独落库。
- Branch protection / ruleset / required checks：未确认。08 的 required-check 迁移因此挂起；不能用 branch API 的 `protected:false` 推断“没有保护规则”。
- Whisper 运行态 / production canary：未确认；#85 仅完成离线验证并明确没有部署或真实服务调用。

## 命名与流程约定

- `093*` 系列一律视为历史序列，不再新增。
- 新任务统一使用 `task/NN-slug` 分支名。
- 新实现任务与 `docs/implementations/IMPLEMENTATION-NN-*.md` 成对交付。
- 状态入口统一为仓库根 `STATUS.md`；历史实现、canary/evidence 与 spec 继续保留为证据，不承担“当前状态入口”职责。

## 分支现状指针

完整远端分支普查见 [`docs/BRANCH-INVENTORY.md`](docs/BRANCH-INVENTORY.md)。无法判定的分支保留原状，本单不删除任何 branch 或 tag。
