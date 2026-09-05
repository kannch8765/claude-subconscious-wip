# 实施单 04：收拢 backfill runner 与目标 runtime 收敛

从本文件开始，在同一分支实现、验证并回传。主窗口晴负责综合验收。

- 仓库：kannch8765/claude-subconscious-wip
- 分支：task/04-backfill-runner-convergence
- 基准 main：5f3638a4795ad96980c020a5ff6978e03ce89d37（#79，可编辑 prompt 已合并）
- 完成报告：docs/IMPLEMENTATION-04-BACKFILL-RUNNER.md
- 前期依据：investigation/02-config-and-cleanup @ 8dc02411f01e3dee85c414a78a566f11edb6283f，docs/INVESTIGATION-02-CONFIG-AND-CLEANUP.md。只读其中 backfill 相关部分即可，发现需以当前源码复核。
- 用户最新状态：Omen backfill 因额度暂停，仍是需要恢复的现役入口。暂停不是废弃，不自动恢复或消耗额度。

## 目标

普通与 Omen backfill 共用一份执行流程；启动时直接向选定的目标 runtime 收敛，消除先 canonical DeepSeek、再 Omen 的中间模型 PATCH。保留现有可用命令和恢复语义。

先定点核实两个入口、backfill_agent_config 及直接调用的 reconciler/测试，随后完成实现，无需再做一轮全仓调查。读取适用仓库说明，保留他人改动。

## 实现方向

1. 将 relationship_memory_backfill.ts 与 relationship_memory_backfill_omen.ts 的共享 CLI、preflight、输入解析、checkpoint、重试与 observer 调度收进共用 runner。保留原路径作为薄入口，使已有运行脚本无需改命令。模块 import 不应触发 CLI 执行。
2. 让目标 runtime 在第一次可能修改 agent 的操作前确定。普通入口保持现有默认/env 覆盖行为，Omen 保持明确的 verified runtime，不因全局 live model 覆盖而跑到别的模型。使用小而明确的内部选择，不新增通用 runtime JSON 或可注入任意绕过验证的回调。
3. 使用现有 reconciliation 机制尽量一次收敛目标。Omen 已匹配时可跳过 PATCH，但仍须验证 effective state；真正需要修改时保留 post-GET/poll 对 briefly stale state 的处理与有效 parallel_tool_calls 检查。验证失败必须阻止 conversation/batch 执行。
4. 检查新 agent import 是否也携带选定 runtime，避免把旧模型先 import 再改成 Omen。如果现有 API/import 格式限制了这种实现，给出具体证据与最小安全处理，不宣称已经消除所有中间状态。
5. 保留 #79 的 MD prompt 权威、同一次解析快照复用、新建与已有 agent 一致性，以及自定义 AgentFile、canary 自管 prompt 的适用语义。reconcileCanonicalPrompt 名称若需调整，逐一迁移仓内调用；保留外部可能使用的旧参数兼容，不顺手扩大 API 清理。
6. CLI 参数、退出状态、checkpoint 路径/格式/agent binding、retry conversation rotation、purpose/live-agent 隔离、权限和 semantic-index preflight、canonical locking 与 Omen 验证均保持原保护。profile 更换不自动抹掉或重新绑定 checkpoint。

基准没有证据支持将这些保护删掉。单独标记真正发现的问题；与本单无关的 legacy migration、sync/recall、model 配置外置留待后续。

## 验证重点

先用临时目录/mock clients 跑直接相关测试，证明：
- 原两个入口参数/执行/退出语义相同，安全 preflight 失败时没有 API/embedding 调用。
- 普通入口没有 Omen 操作；Omen 的新建和已有 agent 路径没有普通模型的中间 mutation。
- 匹配的 Omen 有有效状态验证且无多余 PATCH；发生漂移时修复并 post-verify；第二次解析无多余 runtime PATCH。
- stale GET、provider/context/parallel 不符或验证失败时，不进入 batch；保留既有超时边界。
- prompt-only 更新保持正确 runtime，MD import/bootstrap 保护继续通过。
- 原 checkpoint 可继续使用，agent mismatch 仍拒绝，retry rotation 和写入顺序不变。不使用真实 checkpoint 做实验。

补的是行为/顺序证据，不依赖“源码含某字符串”证明正确。正常依赖环境下跑相关 regression，再运行 npm test 和适用类型/静态检查；已知基准失败仅在再次出现时做必要对照，不能写成全绿，也不扩修无关测试。可利用适用的 GitHub CI。真实 Letta/model/embedding canary 留待另行安排。

## 权限与交付

本单授权隔离开发环境中的代码、测试、文档修改和 commit/push；不修改 VPS 安装目录/服务/生产 agent/数据，不恢复 backfill，不消耗模型或 embedding 额度，不 merge 或部署。优先 GitHub 与沙盒完成；遇环境限制报告具体缺口。

代码与完成报告提交回本分支。报告保持 concise，目标 500–800 中文字或等量英文，必要证据不省：
- 结论及关键改动；
- 测试命令、结果、CI 链接（若有）；
- 剩余风险/阻断与恢复兼容性；
- 值得 reviewer 定点看的文件/符号。
不复述任务单、旧报告、全部文件清单或原始日志。后续更新仅补新增结论。

最后回传分支名、exact commit、报告路径和两三句结论。遇到超出范围或权限阻断，带回证据，不自行扩大实施。
