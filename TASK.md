# 调查单 05：memory kind 与写入工具的设计

- 仓库：kannch8765/claude-subconscious-wip
- 调查与报告分支：investigation/05-memory-write-tools
- 源码基准：57f5ba9998419642b70c35167b5f6aadb05bef8d（#80 已合并）
- 报告：docs/INVESTIGATION-05-MEMORY-WRITE-TOOLS.md

你是调查窗口，读本文件后定点查证，把报告 commit/push 回同一分支。主窗口晴负责设计判断。本轮授权只读调查与报告提交，不实现工具变更。

## 用户问题

用户观察 memory 写入可能是一个大工具让 agent 选择 kind，而不同 kind 字段不同，想知道是否应改成每种 memory kind 一个工具。这个观察待源码确认，不预设现在只有一个工具，也不预设拆分更好。

目标是让 agent 更容易选对操作、填写正确字段、保存想保存的记忆，同时让实现好维护。先查当前设计及已有错误证据，再比较方案。

## 定点调查

1. 从 relationship-memory 的 schema/tools/adapter 与实际 native client tools 注册位置出发，找出所有与 memory 创建、更新、reinforce 有关的公开写入入口。列出实际 memory kind 和各自必填/可选/禁止字段，辨明 kind 与写入操作的关系（新建、修订、强化不一定是一回事）。不要依据旧迁移目录的分类推断当前 kind。
2. 对照 canonical schema、agent 实际收到的 tool JSON schema/description、运行时 validator、prompt guidance。这四层是否一致？kind 特有字段是否被一个宽松的大对象抹平？哪些规则只写在文案里？给出具体符号/字段证据。
3. 区分 live async、普通/Omen backfill 和其他确实相关调用者的工具暴露；sync 若无 mutation 只确认边界即可。不要将 canonical validator 当成实际传给模型的 schema，也不要把 Letta server tools 与 native client tools 混为一谈。
4. 找已有测试、fixtures、仓内运行报告中的真实错误或纠正记录：错 kind、漏必填、无关字段、validator 拒绝/重试、错误被静默丢弃等。只选 2–3 个有证据案例；没有就明确“缺实际模型失败证据”。必要时追溯相关 schema/prompt 近期改动（包括 #78），不复盘全部 PR。不要读取生产私密记忆或原始聊天。
5. 比较三种合理方向：保留统一工具但改善按 kind 区分的 schema/描述；按 kind 拆分薄工具并共用底层 validator/store；若差异只集中于部分 kind，采用部分拆分。判断维度包括模型看到的字段清晰度、选工具负担、schema/tool 数量与文本规模、错误反馈/重试、维护和兼容成本。支持 oneOf/discriminator 等能力必须基于实际调用链或已验证协议能力，不能假定所有 provider 支持。可静态统计 schema 文本大小，但不能据此宣称准确率或延迟提升。

## 推荐需要回答

- 当前最主要问题究竟在工具选择、字段表达、prompt 冲突，还是尚无证据？
- 每 kind 一个工具是否值得？优先给最小方案，允许结论是“先不拆”。
- 用实际 kind 给出最多两个精简 tool schema 示例或改前/改后调用示例，展示字段差异；不是完整实现。
- 如果拆工具，如何共用已有 canonical 写入路径，保持 evidence/subject/batch 绑定、权限、锁、幂等/去重、checkpoint、返回 memory_id 与错误恢复等既有语义？注册/allowlist/required tool 检查/prompt/测试有哪些需同步位置？
- 别名兼容或切换是否会让 agent 同时看到重复写入工具？已有或暂停 backfill 的恢复路径会受什么影响？用户因额度暂停 Omen，不能为评估恢复它。
- 下一张最小实施/验证单应是什么？区分离线 schema/dispatch 验证与未来隔离模型对比。若建议模型对比，应使用合成数据和临时 store，保持同模型同 prompt/案例等控制条件，记录选型正确率、字段错误及重试；本单不执行付费调用。

## 工作边界与报告

只读 GitHub/沙盒内相关代码及已有仓内证据，可做不会访问真实服务的必要静态检查。适用仓库说明先读。不开 VPS、不调用 Letta/model/embedding、不写真实 memory、不改运行源码/测试/依赖、不 merge 或部署。报告中不暴露凭据、私密原文或用户数据。

报告 concise：建议正文 600–1000 中文字或等量英文，关键字段表可额外附短表。先给结论，再给实际 kind/字段与工具映射、证据、方案比较和一个下一步建议。明确事实/推断/未知；引用路径与符号，详细日志留链接，不贴源码大段、不复述任务背景。更新仅补变化。

结束回传分支、报告 exact commit、路径及两三句结论。
