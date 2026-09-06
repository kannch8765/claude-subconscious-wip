# 实施单 08：统一普通 PR 的离线 CI

仓库 kannch8765/claude-subconscious-wip；工作/回传分支 task/08-unified-pr-ci。
基准 f0d95b65e5b2521c9c07504748c5a4f8d929b08c。
报告 docs/IMPLEMENTATION-08-UNIFIED-PR-CI.md。
调查依据：investigation/07-ci-and-recall-status @ 348f6ce5f2a9f250a1d60c6a0a392d3446ddf613 的 docs/INVESTIGATION-07-CI-AND-RECALL-STATUS.md，只需 A 部分。

## 目标

普通 PR 自动获得稳定、可重复的测试与类型检查，不再为每个任务手工添加临时 workflow。定点读取适用仓库说明、workflows/package/testing 入口后实施；不通读全仓。

1. 提供 npm run test:ci（完整 Vitest，建议固定 maxWorkers=2，保留测试并发语义与断言）与真正硬失败的 npm run typecheck。
2. 添加正常 tsconfig.ci.json 或适合本仓库的类型检查配置。覆盖主要运行源码及测试，明确 include/exclude；不能只覆盖本单文件或排除有错文件来造绿灯。先核实基准三个既有诊断，允许最小类型收窄/类型正确性修复，保持运行行为。不用 noCheck、ts-ignore、宽泛 any 或诊断 baseline 白名单吞错误。若完整合理覆盖暴露较大独立问题，给出证据和小范围建议，不扩大业务重构或宣称全局通过。
3. 建立一个普通 PR→main 自动运行（含 synchronize/reopened 等正常更新事件）的离线 workflow：npm ci、test:ci、typecheck。选稳定、唯一 check 名，显式只读权限；无外部模型/Letta/embedding 凭据需求。不用 pull_request_target 执行 PR 代码，不加自动修改/commit 功能。以所有普通 PR 都有可见检查为优先，避免路径过滤导致 required check 永远 pending。
4. 复核旧 093AA/AG/AH/AN/AO 的触发、执行覆盖与 check 名；093AP 20× contention stress 保留独有价值，可继续作为窄路径/手动专项。专项触发应覆盖实际锁/并发实现及测试的相关路径，不能只认旧任务分支。Letta 自动化保持其独立职责，本单不新增付费触发、不改它的业务行为。
5. 只读确认 branch protection/rulesets/required status checks。protected:false 不能证明没有规则。无权限即记录 unknown；新 CI 可以先建立并验证，旧 check 在迁移依赖未查明前保留。确认覆盖和检查依赖后，可删除确定冗余的历史 workflow/gate，但不得修改/绕过仓库保护或 required checks。本单若无法安全收掉旧入口，明确列为待完成的迁移项，不称整理全完成。

## 验证与范围

- 正常依赖环境运行新命令，报告实际覆盖/测试数量和类型检查退出状态。资源限制与真实断言错误分开；不 blanket skip、不无限重试、不忽略退出码换绿灯。
- 允许创建或复用本分支的 draft PR 以验证新 CI。核对实际 run 的 commit/event、唯一 check 名，证明普通名字分支的 PR 和后续 push 都触发新检查。最终 head 必须有对应结果；较早临时实验成功不能代替。
- 通过必要的可逆探针或触发配置测试确认专项 stress 的相关/无关路径判断。若专项确有相关变更则实际运行验证；不要无意义重跑 20×。
- 临时探针清理后再确认最终 diff 与检查。文档写清本地标准命令和各检查职责。
- 不部署、不进入 VPS、不恢复 backfill、不调用真实服务、不合并 PR、不改变仓库访问/保护规则。
- 不处理 recall。本次之后将单独复核显式 recall 候选 656f9fcaa447a415c86c082ddb81e5f94c444459，不整条合入旧混合分支。

代码、测试/配置和报告 commit/push 回本分支。报告 concise，约 500–800 中文字：完成/剩余项、新旧检查映射、验证命令与 CI 链接、覆盖边界和保护规则查证结果。详细日志给链接，不复述背景；更新只补变化。
最后回传分支、exact head、PR 链接、报告路径、是否有阻断。
