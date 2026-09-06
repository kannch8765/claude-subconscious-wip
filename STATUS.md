# 项目状态

> 本文件是仓库内唯一活跃状态入口。历史实现细节、canary 与调查证据分别归档到 `docs/implementations/`、`docs/canaries/` 与相关历史分支；本页只写当前仍为真的状态。不确定项一律标记为“未确认”。

## 活跃工作线

### Recall

- 任务 09 的 bundle-first explicit recall 已通过离线验收并合入；任务 15 / 16 的显式 recall 分段打点与多轮 timing context 覆盖也已进入 main。对应报告：`docs/implementations/IMPLEMENTATION-09-EXPLICIT-RECALL.md`、`docs/implementations/IMPLEMENTATION-15-RECALL-INSTRUMENTATION.md`、`docs/implementations/IMPLEMENTATION-16-RECALL-TIMING-COVERAGE.md`。
- **真实 canary 尚未执行。** 当前阻塞是 memory agent（模型）额度；embedding 额度可用。
- 已知限制：多轮工具路径中的 `rank()` 调用仍缺少 `semantic_query_embedding_external` 分项。任务 16 已登记这一覆盖缺口；因此若 canary 需要把本地扫描耗时与外部 query-embedding 调用耗时拆开，应走 bundle-first 路径。
- 仍待处理：`transcriptSearch` 目前全量扫描 transcript；一次 explicit recall 在 bundle-first + expand 路径上最多可能扫描两遍。

### Whisper

- 任务 10 已把同一 `memory_search` 命中的 canonical summary 放回 whisper，并保持 `deliver_whisper` 只能引用实际 surfaced 的同一 memory / snippet evidence；PR #85 已合入。
- 已知待处理：whisper top-k 目前没有多样性约束；MMR 是候选方向，但尚未安排实现。
- 运行态 / production canary：未确认；当前状态索引不把离线证据扩写成运行态结论。

### Infra / CI

- 任务 08 已建立统一 PR gate `PR offline CI / offline-ci`；任务 13 已完成 legacy `093AA/093AG/093AH/093AN/093AO` workflow 清理。required status check 当前为 `offline-ci`。
- 对应报告：`docs/implementations/IMPLEMENTATION-08-UNIFIED-PR-CI.md`、`docs/implementations/IMPLEMENTATION-13-LEGACY-CI-CLEANUP.md`。
- 任务 12 已修复 CJK lexical scoring 与重复实现；仍有一项测试覆盖缺口：`hybridScore` 在语义分缺失时回退为 `-1`，但“大批文档无向量”场景下的整体排序行为尚无专门测试。

### Store 写入性能

- 任务 14 已把 store 写入去重/存在性检查从反复全文件扫描改为 `.write-index-v1/` sidecar 索引。报告：`docs/implementations/IMPLEMENTATION-14-STORE-WRITE-PATH.md`。
- 任务 14B 的同版本双 writer 交替基准已完成：交替写入不会反复触发全量 rebuild；rebuild 计数恒为 2，且两次都来自空 store 初始化。报告：`docs/implementations/IMPLEMENTATION-14B-WRITE-INDEX-BENCHMARK.md`。
- 已知成本：小 N（约 400–500 条以下）时，新实现比旧实现更慢；已有大 store 在首次由新实现写入时，会做一次按记录数写 marker 文件的 sidecar rebuild。
- 未测场景：混版本 writer，或一个 writer 持续 raw append 而不维护 sidecar、另一个 writer 持续使用新实现时的长期性能。

## 已知阻塞项

- Recall 真实 canary：尚未执行；当前阻塞为 memory agent（模型）额度，embedding 额度可用。
- Whisper 运行态 / production canary：未确认。

## 已登记但尚未安排

- `rank()` 路径的 query embedding 打点覆盖缺口：多轮工具路径缺少 `semantic_query_embedding_external` 分项。
- `hybridScore` 语义缺失回退（`-1`）在大批无向量文档场景下的排序行为无测试覆盖。
- whisper top-k 无多样性约束；MMR 为候选。
- `transcriptSearch` 全量扫描；一次 recall 最多两遍。
- Store sidecar 的混版本 writer / raw-append writer 持续交替性能尚未测量。

## 命名与流程约定

- 任务 11 约定新实现任务采用 `task/NN-slug`，并与 `docs/implementations/IMPLEMENTATION-NN-*.md` 成对交付。
- 该约定在实际执行中**没有被持续遵守**：当前远端仍存在 `copilot/*`、`investigation/*`，同一任务也出现过多条 `-clean` / `-final` 分支（例如任务 12），任务 14/15 也出现了 Copilot 命名分支。
- 后续新任务应回到 `task/NN-slug`；任务 17 使用 `task/17-inventory-refresh`。这是一项后续约定，不把历史偏离写成“已经恢复遵守”。
- `093*` 系列继续视为历史序列，不新增新的 `093*` 任务编号。
- 状态只在本 `STATUS.md` 维护；历史报告保持历史证据属性。无法由仓库或 owner 授权事实直接确认的运行态、provider、ruleset 状态写“未确认”。

## 分支现状指针

任务 17 的远端分支刷新见 [`docs/BRANCH-INVENTORY.md`](docs/BRANCH-INVENTORY.md)。基准 main：`44139fd61057a4161130ce81a08a575bac34f41c`。
