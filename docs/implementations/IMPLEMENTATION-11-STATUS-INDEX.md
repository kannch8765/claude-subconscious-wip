# 实施 11：状态索引化与仓库导航清理

## 范围与基准

- 基准：`main @ 83bfc7114de3e33d3cb072700dc2fd3af36f3c31`。
- 交付分支：`task/11-status-index`。
- 本单只整理状态索引、docs 路径与分支普查；不修改运行时行为，不删除 branch/tag，不部署，不进入 VPS，不调用真实 Letta / model / embedding provider，不触碰 production 记忆数据。
- 验证 head：本报告所在的最终 PR `HEAD`。由于 Git commit SHA 包含本报告正文，报告内不能预先写入自身最终 SHA 而不再次改变 SHA；最终 exact SHA 以 PR head / 本单回传为准，CI 必须运行在该同一 `HEAD`。

## 交付

### STATUS.md

新增根目录 `STATUS.md`，作为唯一活跃状态入口。三条工作线均基于现有 PR / 报告：
- recall：PR #84 + `docs/implementations/IMPLEMENTATION-09-EXPLICIT-RECALL.md`；离线验收通过，真实 canary 尚未执行。owner 在任务 11 明确当前阻塞为 embedding 额度不足；此前仓库报告没有独立记录额度状态，因此该历史证据缺口也在 STATUS 中明示。
- whisper：PR #85 已合入且 offline CI / Vitest / typecheck 通过；PR 明确没有 deployment / production mutation / model / embedding / backfill。仓库无独立 IMPLEMENTATION-10 报告，因此报告路径写“未确认”而不猜测。
- infra/CI：PR #83 + `docs/implementations/IMPLEMENTATION-08-UNIFIED-PR-CI.md`；统一 offline gate 已合入。合并前 owner 已为 `main` 启用 branch protection，并把 GitHub Actions `offline-ci` 设为 required status check；GitHub MCP 分支列表随后回报 `main` 为 `protected: true`。

### docs 分层

既有文档先仅移动路径；合并前 owner 另行授权修复 5 处因搬迁产生的旧路径互引：
- `docs/implementations/`：全部 `IMPLEMENTATION-*.md`。
- `docs/canaries/`：全部 `*-CANARY-*.md`、`*-RUNTIME-EVIDENCE.md`、`*-IMPORT-EVIDENCE.md`。
- `docs/specs/`：`RELATIONSHIP-MEMORY-SCAFFOLD.md`、`TASK-096A-SUBCON-VISIBILITY-CONTRACT.md`、`EDITABLE-SYSTEM-PROMPTS.md`、`SUBCON-CANONICAL-RUNTIME-CONFIG-RECONCILIATION-093AC.md`、`PREMERGE-ACCEPTANCE-*.md`。

22 份既有文档先以原文件 blob/content SHA 与移动后正文逐字一致完成搬迁；随后 owner 在合并前明确授权仅修复 5 处因搬迁产生的旧路径互引。除这 5 处路径字符串外，其余既有正文保持不变。

### 分支普查

新增 `docs/BRANCH-INVENTORY.md`。普查快照覆盖任务 11 创建前已经存在的 110 条远端分支：
- 已合入 main：67
- 活跃：11
- 已废弃：5
- 无法判定：27

“已合入”只在当前 branch head 与已 merged PR head 精确一致，或有等价明确 main 基准证据时使用；“活跃”只用仍 open PR / main 本身；“已废弃”只用 closed-unmerged PR 且当前 head 与 PR head 精确一致；其余全部保守写“无法判定”。

## 引用检查与修复

README 与当前 `.github/workflows/**` 未发现对本次移动文件旧路径的引用，因此无需修改。

发现两组位于“既有 docs 正文”中的旧路径互引：
1. `docs/implementations/IMPLEMENTATION-03-EDITABLE-SYSTEM-PROMPTS.md` 内 4 处旧的 `docs/EDITABLE-SYSTEM-PROMPTS.md`；
2. `docs/canaries/RELATIONSHIP-MEMORY-HISTORICAL-BACKFILL-OWNER-CANARY-02.md` 内 1 处旧的 `docs/RELATIONSHIP-MEMORY-HISTORICAL-BACKFILL-OWNER-CANARY-01.md`。

owner 在合并前明确授权“旧路径互引允许修改”。因此这 5 处仅做导航路径替换：前者改为 `docs/specs/EDITABLE-SYSTEM-PROMPTS.md`，后者改为 `docs/canaries/RELATIONSHIP-MEMORY-HISTORICAL-BACKFILL-OWNER-CANARY-01.md`；未改写其他历史正文。

## 硬性范围证据

最终 PR diff 必须满足：
- `scripts/**`：0
- `relationship-memory/**`：0
- `hooks/**`：0
- `config/**`：0
- `.github/workflows/**`：0
- `package.json`：0
- `.mcp.json`：0

除新增 `STATUS.md`、`docs/BRANCH-INVENTORY.md`、本报告外，既有 docs 的变更应为路径移动；唯一正文例外是 owner 合并前授权的两份文档共 5 处旧路径引用替换。

## 验证

最终 head 必须满足：
- `npm run typecheck` PASS；
- `PR offline CI / offline-ci` SUCCESS；
- bounded full Vitest 全绿；
- 硬性范围路径 diff 为 0；
- docs 搬迁除已授权的 5 处旧路径引用替换外无正文变化。

CI run：以 Draft PR 上“本报告所在最终 HEAD”的 `PR offline CI / offline-ci` check 为准；最终回传同时给出对应 run 链接与 exact head，二者必须一致。

## 合并前状态更新

- owner 已在 GitHub 为 `main` 配置 branch protection：要求 PR 合入，并把 GitHub Actions `offline-ci` 加为 required status check；approval 与“branch 必须 up to date”未启用。
- GitHub MCP 分支列表随后回报 `main` 为 `protected: true`。这解除任务 08 中“真实 required-check 配置未确认”的 blocker；legacy workflow 清理仍留给后续小任务。

## 剩余项

- recall 真实 canary：未执行；owner 当前声明因 embedding 额度不足。
- whisper 运行态 / production canary：未确认。
- 无法判定分支共 27 条：
  - `ci/relationship-memory-01`
  - `ci/relationship-memory-02`
  - `docs/relationship-memory-historical-source-01`
  - `docs/relationship-memory-owner-live-canary-01`
  - `docs/relationship-memory-scaffold`
  - `investigation/current-structure-map-e83e759`
  - `investigation/structure-map-e83e759`
  - `investigation/02-config-and-cleanup`
  - `investigation/05-memory-write-tools`
  - `investigation/07-ci-and-recall-status`
  - `review/relationship-memory-01-r1`
  - `review/relationship-memory-01-r2`
  - `task/dario-runtime-provenance-gate`
  - `task/live-subcon-model-authored-semantic-search-final`
  - `task/omen-alpha-backfill-canary`
  - `task/ox-alpha-backfill`
  - `task/ox-alpha-backfill-option`
  - `task/subcon-live-backfill-role-split`
  - `task/subcon-llm-context-observability`
  - `task/subcon-memory-context-window`
  - `task/subcon-recall-pipeline-v2`
  - `task/subcon-semantic-index-quota-safety`
  - `task/093aa-legacy-identity-fidelity-correction`
  - `task/093ad-ombre-relationship-memory-fill-lane`
  - `task/093ae-legacy-semantic-zero-mutation-auto-retry`
  - `task/093ag-native-letta-backfill-harness-reconciliation`
  - `task/093ag-native-letta-source-concurrency`
