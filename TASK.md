# 实施单 03：让两份 system prompt 可以直接编辑 Markdown

收到这个分支名后，从本文件开始。你是实施窗口；主窗口晴负责最终讨论与验收。本单授权在此分支实现、离线验证并提交代码与完成报告，不授权合并或部署。

## 位置与背景

- 仓库：kannch8765/claude-subconscious-wip
- 实施及回传分支：task/03-editable-system-prompts
- 建分支源码基准：e83e75956b468dc43491bcb8fafff8ac70d0e854
- 完成报告：docs/IMPLEMENTATION-03-EDITABLE-SYSTEM-PROMPTS.md
- 调查依据：docs/INVESTIGATION-02-CONFIG-AND-CLEANUP.md，位于 investigation/02-config-and-cleanup 的 exact commit 8dc02411f01e3dee85c414a78a566f11edb6283f。请定点复核相关发现，不把调查报告当测试结果。
- 用户确认 VPS 上 Omen lane 正在运行。这是现役入口，本次工作完全留在隔离开发环境，不访问或更新 VPS，也不启动另一只真实 backfill。
- sync 仍在实验阶段，工具不同是有意设计；显式 recall 的不可用反馈另案处理。

先读适用仓库说明，确认分支和工作区，保留他人改动。基准之后如有重叠变更，说明差异并处理任务内兼容，不自动合并其他分支。

## 想获得的结果

用户以后可以直接编辑两份易读的 Markdown 来修改 managed live / backfill system prompt，不必编辑 AgentFile 内的长 JSON 字符串。第一轮迁移本身不改变 prompt 内容或任何模型/运行策略。

建议位置为 config/live-system.md 和 config/backfill-system.md；若仓库已有更自然的目录可沿用并解释。文件只包含实际 prompt，不添加说明标题或 front matter。

请先查清现有 canonical config、AgentFile import 和 reconciliation 的连接点，再以最小改动实现。沿用现有 reconciliation，不搭建通用配置或模板框架。

## 关键设计问题

### 一份可编辑内容，覆盖新建与已有 agent

从基准 Subconscious.af / SubconsciousBackfill.af 的 system 字符串无损提取两份 MD，作为 bundled managed system prompt 的唯一编辑来源。

- 已有 managed agent 的 reconciliation 从 MD 取 system。
- 新建/import 的 payload 在发出前也取得同一份 system，不能先用陈旧 prompt 建出 agent 再依赖后续 PATCH 修正。
- 找出共享 canonical helper 的其他消费者（包括 sync sibling），让它们仍收到与原来等价的 system；不改变 sync 自己的 per-turn policy。
- AgentFile 中 blocks/tools/runtime/bootstrap 信息继续承担原职责，不顺带迁移。
- 明确 .af 中 system 的剩余角色。若为兼容保留副本，它只能是非权威快照/派生物，应用内 import 与 reconcile 都不能悄悄回读它。说明直接向外部工具导入原始 .af 的语义和限制，不能宣称所有外部导入自动获得新 MD。
- 对显式传入的自定义 AgentFile、外部非 managed agent，以及 canary 自管 prompt 的路径，先查调用方并保持原有语义。不要用 bundled MD 无条件覆盖所有传入文件。

无需预设用哪种内存 payload/loader 形式；选能让来源最清楚、改动最少的方案。不要启动时改写仓库文件。

### 内容、加载与失败

- 初始有效 system 必须与迁移前精确相等，包括原有空白。验证非空可以用 trim 判断，但不要把 trim 后的文本当输出。
- 定义简单明确的 UTF-8/末尾换行策略；优先原样读取。避免隐式替换、通用插值或自动加标题。
- 模块相对路径定位，不能依赖 cwd。
- 在需要 bundled managed prompt 的路径中，缺失/不可读/空白文件应在 import/PATCH 等远端变更前明确失败，不能静默退回旧 prompt；外部 unmanaged 路径不应被新增的无关文件校验意外阻断。
- 同一次解析/导入与 reconciliation 使用一致的已读取内容；不要因为反复读取导致一次操作前后取到不同版本。
- 保留现有生效时机，避免永久缓存导致之后编辑 MD 不被下一次 managed resolution 发现。
- 只记录必要的非敏感诊断信息；不打印完整 prompt、凭据或用户数据，不为这单建立新的观测系统。

## 此次保持不变的边界

模型/provider/context/embedding 配置、env 优先级、managed ownership、purpose/origin tags、parallel-tool 修复和 post-GET 验证、tool surface、canonical store、checkpoint/index/cooldown、Omen runtime verification、backfill 入口与执行顺序保持原语义。

runtime JSON、backfill runner 收拢、DeepSeek→Omen 双收敛优化、sync profile 决策都留在后续小单。本单只处理 prompt 来源与必要的导入/测试/文档连接。

## 验证方向

请先检查测试外部依赖，使用隔离临时目录、mock client 和无生产凭据的环境。重点证明：

1. 两份初始加载结果与基准 .af system 精确相等。基准证据应独立于新 loader，不能让两边都从新 MD 读取形成自证；后续正常编辑 prompt 时也不应被永久“必须等于旧版”的测试锁死。
2. 修改一份测试 prompt 后，已有 managed agent 的 system PATCH 和新 import payload 使用相同新文本；另一角色不被误改。匹配后第二次 reconcile 无多余 PATCH。
3. 新建/import 不先发旧 system；失败的 prompt 加载不产生远端变更。
4. managed ownership、外部 env agent、自定义 AgentFile、canary prompt opt-out 语义保持；根据真实调用面覆盖，未适用项说明原因。
5. 更换 cwd 和 package/install-shaped fixture 后仍读取到正确文件；模拟缺失资源有明确错误。检查实际打包包含规则，不能只在源码树测试成功。
6. prompt-only 改动不顺带改变 model/provider/context/tool surface；既有相关 regression tests 仍通过。
7. 同一解析操作的一致性，以及后续解析可观察到文件更新。

运行直接相关离线测试，再在确认安全与资源可承受后运行完整 npm test；可运行已有类型/静态检查。报告准确记录命令、结果、未运行项及原因，区分既有失败与本次回归。不要删除/弱化旧测试以取得绿灯。

补一段简短用户文档：以后编辑哪里、何时生效、怎样验证与回退、发布包要带什么，以及原始 .af 直接导入的边界。

## 回传方式

在本分支 commit/push 实现、测试和完成报告，不新开另一条回传分支，不创建 PR、不 merge、不部署，不调用实际 Letta/模型/embedding。报告给出：
- 最终采用的内容来源与 import/reconcile 关系；
- 改动范围、兼容路径与 .af 副本处理；
- 基准等价证据、测试结果、打包检查；
- 已知限制与后续真实服务验证需求。

最后回主窗口只需：分支名、实现 exact commit、报告路径、最重要的两三句结论。报告本身不必包含自己的 commit hash。若遇到权限或超出本单的架构阻断，带回具体缺口，不自行扩大任务。
