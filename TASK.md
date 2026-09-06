# 实施单 09：复核并接回显式 recall 候选

仓库 kannch8765/claude-subconscious-wip。
工作及回传分支 task/09-explicit-recall-recovery。
基准 041cc0bb5918c8f4f1ea639d413fd10a07688282（#83 统一 CI 已合入）。
报告 docs/IMPLEMENTATION-09-EXPLICIT-RECALL.md。

## 来由

用户反馈显式 recall 曾不可用，记得以前可能已修好。调查 07 找到：
- 启动修复 #72 已合入：symlink plugin overlay 下 realpath guard；不是待移植对象。
- 旧 branch task/subcon-recall-pipeline-v2 中独立提交 656f9fcaa447a415c86c082ddb81e5f94c444459，标题 Prefetch evidence for explicit relationship recall；基准 main 尚无该改动。该分支后来叠有许多 sync 工作，不能整分支合入。
- 调查依据：docs/INVESTIGATION-07-CI-AND-RECALL-STATUS.md @ 348f6ce5f2a9f250a1d60c6a0a392d3446ddf613，B 部分。

本单先定点复核这个提交解决的真实问题与当前链路，再移植仍适用的显式 recall 部分。不是预设旧提交一定正确或能解决用户全部故障。主窗口晴负责最终验收；你可在同一 turn 完成复核、实现、离线验证与回传，无需重复申请常规实现确认。

## 工作方法与边界

1. 读适用仓库说明、旧提交相对其 parent 的 diff/相关测试、当前 .mcp.json → recall_mcp.ts → recall_runtime.ts → recall core。界定故障或改进目标：启动、工具执行、检索、证据整理、terminal delivery 分别是什么状态。不要把 foreground sync、whisper 或 memory_search 优化当显式 recall 修复。
2. 查明旧提交的 bounded evidence prefetch、可选 expand_recall、terminal deliver_recall 设计与依赖。用合成案例/离线 mock 复现其要解决的问题或证明行为差异；若只能证明性能/架构优化而非不可用根因，报告明确区分。
3. 确认方向适用后，只移植必要 diff 并适配当前 main；保留 #72 symlink 启动保护、#79 prompt 来源、#81 schema-derived tools 与 #83 CI。若存在不可分离的大范围依赖或证据否定方向，停止扩展，交回具体缺口和最小建议，不整条 cherry-pick/合并旧分支。
4. 沿用现有显式 recall transport，不能把 live 改回 SDK，也不借本单重写所有 transport。明确外层 MCP 的实际工具名/输入/输出以及内部模型工具职责，保持调用方兼容；必要变化需写清迁移。
5. evidence bundle 必须有来源、可验证的 memory/snippet 关联、大小/数量/扩展次数上限，保持 canonical summary 与原始引文语义。保留现有 owner effective/deactivate、subject、路径和权限边界，不因预取扩大读取范围。输入/历史内容不得被当作指令执行。
6. 保持显式 recall 只读边界，不引入写记忆、reinforce、重建索引或后台 embed。现有 semantic 能力如何使用需从当前代码查清；本单离线验证用 fake embedding/provider 或现有合成索引，不调用真实 API。
7. 超时/取消/失败、空结果、可选扩展、终止交付、重复/未知证据选择等行为要有明确可测试结果；不能把 initialize/tools/list 成功当 tools/call 成功，也不能把 mock terminal 成功当真实模型质量已验证。

## 验证与交付

优先运行 recall core/entrypoint 定点 tests，再用标准 npm run test:ci 与 npm run typecheck；不忽略失败或削弱检查。本地 stdio 集成测试可启动临时 MCP 进程，调用 initialize/initialized/tools/list 与真正 tools/call，模型/服务用 mock，验证结果内容/来源与错误路径，收掉进程。区分普通路径与 symlink 入口。

授权隔离环境源码/测试/必要文档修改、commit/push 和 draft PR，用新统一 CI 验证最终 head。不进入 VPS、不操作 production/真实记忆/Letta agent、不恢复 backfill、不调用真实模型或 embedding、不合并或部署。真实 Claude Code/Letta canary 另行安排，报告给出最小合成输入、隔离方案和还需证明什么，不以本单离线测试宣称线上已恢复。

报告 concise，约 600–900 中文字：旧提交解决什么、移植/弃用哪些部分、实际外部行为、定点/全量/类型/CI 结果、限制和下一验收步骤。日志链接代替长粘贴；更新仅补变化。
最后回传分支、exact head、PR（若有）、报告路径和是否有阻断。
