# 实施单 06：从共同 kind 定义生成 memory 创建工具

在此分支完成实现、离线测试和简短报告，主窗口晴负责验收。

- 仓库：kannch8765/claude-subconscious-wip
- 分支：task/06-schema-derived-memory-tools
- 基准：57f5ba9998419642b70c35167b5f6aadb05bef8d
- 报告：docs/IMPLEMENTATION-06-MEMORY-WRITE-TOOLS.md
- 调查：investigation/05-memory-write-tools @ 33a5429939ba8aeda23b6108fa9cb3e058cf8ca6，docs/INVESTIGATION-05-MEMORY-WRITE-TOOLS.md。

## 目标与方向

用户批准将统一 memory_remember 的 model-facing 创建接口改为五种 kind 的薄工具，并从共同字段定义自动派生 schema/注册/dispatch，避免五套手工重复实现。全局接入使用该写入接口的 live async、普通/Omen backfill；sync 维持无 mutation 权限，owner revise/deactivate/restore、memory_reinforce 与 entity_remember 保持其独立职责。

实际 kind 为 personal_experience、shared_experience、relationship_event、inside_joke、user_preference。先定点复核 schema/validator、adapter、真实 native client tools 和权限注册路径；调查报告不替代源码。读取适用仓库说明，保留他人改动。

已有真实问题是 relationship_event 收到 personal_experience 专属 emotional_tone，被后端拒绝；新接口应让模型看到的字段与当前 canonical kind 规则一致。本单不宣称已经证明模型准确率提升。

## 实现要点

1. 收拢每种 kind 的允许字段、类型、required/optional 与现有约束为共同定义，供模型 schema 和 canonical validator 使用。优先复用现有设施；需要重构 validator 时保持现有合法输入、拒绝条件和错误语义。不要形成“新工具一套字段表、旧 validator 另一套字段表”。复杂跨字段/证据语义仍由后端验证，不勉强塞入 JSON schema。
2. 自动生成五个工具，例如 memory_remember_<kind>。名称和用途描述可显式维护，结构由定义派生；不建通用代码生成框架，不需要新编译步骤或配置服务。工具不让模型另传可覆盖的 kind；字段命名/嵌套选择以现有 provider 传递稳定性和清晰度决定，五工具保持一致。
3. 各工具只暴露对应 kind 的 payload 字段与必要公共输入，required 明确，additionalProperties 等边界完整。共用 dispatcher 将输入转成当前 MemoryProposalV1 并调用同一 runtime.remember()，不得自行造 subject/batch/evidence、改 source_key 或绕过 canonical mutation boundary。
4. 工具目录生成名称集合、注册与 dispatch 映射；角色权限由显式规则筛选。新增 kind 不应自动给只读 lane 写权限。逐一同步实际调用路径上的 allowlist、mutation 分类、工具冲突处理、prompt 与 inventory tests。报告称部分路径共享 runner，这一点请按真实代码核实，不能漏掉独立的 live native worker。
5. 模型同一轮只看到五个新创建工具，不同时暴露旧大工具。内部 runtime.remember API 不必改名。旧入口如需保留兼容，只能用于查实的调用方，注明范围；不能由兼容 fallback 绕过当前 allowed-tool gate。
6. #79 的 MD prompt 是权威，更新实际文案中的工具名和 kind 指引；检查工具清单、bootstrap/AgentFile surface、native 客户端最终发出的定义是否一致。五种区分描述仍需人工写清，不从字段名机械拼出所有语义。保持新工具说明简短。
7. 暂停 backfill 恢复、已有 live conversation 和 pending tool calls 的切换需要明确处理。先判断现有每轮工具刷新与会话恢复机制是否足够；若需要工具版本不兼容处理，采用最小、可测试的方案，不因每次启动无条件旋转会话。不能丢 checkpoint、静默吞掉旧写入、自动重绑 agent 或重放已完成 batch。需要运维切换时在报告写清步骤，本单不执行。

## 保持的行为

trusted evidence/subject/batch 绑定、锁、dedupe/幂等/source_key、outcome/checkpoint、memory_id 返回和 retryable/permanent error 语义保持。旧 canonical 数据仍可读取，无需重写记忆或重建 embedding。reinforce、owner 管理面、sync recall 权限保持原职责。

## 验证

使用合成 evidence、临时 store 与 mock clients：
- 五种定义生成的实际模型 schema 各自只含合法字段，类型/required/optional 与现有 validator 一致。截取最终 native 工具定义验证，不只测内部 helper；不假定 provider 支持 discriminator/oneOf。
- 五种有效调用与原 canonical proposal 落盘结果语义等价，含公共证据与返回值；相同输入重试不产生重复写入。
- 跨 kind 字段（特别是 relationship_event.emotional_tone）、缺 required、null、错误数组等继续拒绝且无 mutation。schema 不包含字段不等于 provider 一定不会发送，dispatcher/validator 仍要拒绝恶意/错误输入。
- live async 与普通/Omen backfill 暴露五工具且正确分类 mutation；sync 无创建工具；旧大工具不混入模型 inventory。
- 既有 evidence/权限/错误恢复回归保留；工具切换的旧会话/pending call/暂停 checkpoint 边界按实际设计测试。
- 字段规则改变时，schema 与 validator 同步，避免自证测试或只查源码字符串。

正常依赖环境下运行定点测试和 npm test；显式列出修改文件做真实 TypeScript 检查（沿用 ES2022/NodeNext、node/vitest types 参数），不能以缺 tsconfig 代替。基准失败如出现做必要对照，不扩修无关故障。可使用适用 GitHub CI。

## 权限和交付

授权隔离环境代码/测试/必要文档的实现与 commit/push。不开 VPS、不修改生产数据/服务/agent、不恢复 Omen、不调用真实 Letta/模型/embedding、不 merge 或部署。代码与报告交回同一分支。

报告 concise，约 600–900 中文字或等量英文：结论、共同定义与接入位置、验证结果、迁移/恢复要求和剩余风险。详细证据留路径/链接，不贴日志、复述旧背景或全部文件清单；更新只补变化。报告中区分已测试与未来模型实验待证。
最终回传分支、exact commit、报告路径及两三句结论。发现超出范围或权限阻断，带回具体证据，不自行扩大工程。
