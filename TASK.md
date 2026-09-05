# 调查单 07：CI/test 入口与显式 recall 修复去向

仓库 kannch8765/claude-subconscious-wip；调查基准 f0d95b65e5b2521c9c07504748c5a4f8d929b08c（#81 已合并）。
工作与报告分支 investigation/07-ci-and-recall-status。
报告 docs/INVESTIGATION-07-CI-AND-RECALL-STATUS.md。

你是调查窗口。主窗口晴负责决策；本轮只读查证、报告 commit/push 回同一分支，不实施配置或代码变更。先读适用仓库说明，范围限定如下。

## A. 主线：以后每个 PR 怎样稳定验收

近期 #79–81 验收反复遇到旧任务分支专属 workflow、临时验收 workflow、不同环境 concurrency test 失败、手工 TypeScript 命令。查清：
- 当前 .github/workflows、package scripts、测试/类型配置的实际入口。表格列 workflow 触发条件、job/check 名、执行命令、独有覆盖或重复覆盖；区分测试、Letta 检查和其他自动化。
- 查 #79–81 的实际 CI runs/最终 head，确认哪些检查自动触发、哪些属于临时 workflow，不能由文件名推断。
- 只读查询 branch protection/rulesets/required status checks。无权限就记 unknown，不据此判定没有保护，不建议绕过检查。
- 提出最小统一方案：常规 PR 默认离线检查、确有必要的特定检查、稳定 npm test/typecheck 命令、旧 workflow 的保留/收拢条件。不要把可能消费外部服务的任务放进默认测试。
- 核实当前 TypeScript 既有诊断和 concurrency 不稳定的已有证据；先读报告和日志，只有具体缺口才做隔离、无凭据的必要复现，不重跑一切。区分真实错误、环境限制和偶发失败，不用 blanket skip、忽略退出码或无限 retry 换绿灯。
- 下一实施单如何验证新的触发条件确实能在普通 PR 生效，且不丢现有 required check/独有覆盖？

## B. 有界支线：显式 recall 是否已经修好但没合入

用户记得显式 recall 之前可能修好过，但不确定是否 merge；不要直接重做修复。
- 搜 GitHub branches、open/closed/merged PR、相关 commit 消息，围绕 .mcp.json → recall_mcp.ts → recall_runtime.ts 的显式 recall 工具。
- 严格区分显式 recall MCP、foreground sync 优化、普通 memory_search、whisper 注入与 recall_mcp_entrypoint 子进程测试；后几者的修复不代表显式 recall 功能修复。
- 最多列 3 个实际相关候选：PR/branch、exact head、修什么、已有验证、是否 merged、修复提交/等效改动是否已包含在本基准 main。
- 若有未合并候选，只看与本问题有关的 diff/验收记录，判断基于 #79–81 之后是否需要重新 review；不 cherry-pick、不 merge、不重建实现。
- 仓库只能证明代码合入状态，不能证明 VPS 已部署或真实 recall 可用。没有命中就列搜索范围和缺口，不能断言修复从未存在。
- 给一个明确结论：已合入待确认部署 / 存在未合入修复待验收 / 找到相邻但不同问题 / 证据不足；以及最小下一步。限定分支检索，遇到需要大规模功能排查就留下一单。

## 交付

报告 concise，正文目标 700–1000 中文字，必要映射表可另附；A、B 各先给结论，再给证据链接与一个下一步。无需复述背景、整段日志或源码。更新仅补变化。
不开 VPS、不调用真实 Letta/模型/embedding、不恢复 backfill、不修改 workflow/运行代码/仓库保护规则、不创建 PR、不合并。允许本地临时只读分析与必要离线验证。
结束只回传分支、报告 exact commit、路径、两三句结论。
