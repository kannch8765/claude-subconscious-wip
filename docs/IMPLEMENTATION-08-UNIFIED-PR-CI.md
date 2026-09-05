# 实施 08：统一普通 PR 的离线 CI

## 结论

已建立普通 PR → `main` 的统一离线检查 `PR offline CI / offline-ci`。它无路径过滤、仅 `contents: read`，在 opened / synchronize / reopened / ready_for_review 上执行 `npm ci`、`npm run test:ci` 与 `npm run typecheck`；不需要 Letta、模型或 embedding 凭据。`test:ci` 固定 Vitest `--maxWorkers=2`，`tsconfig.ci.json` 覆盖 `scripts/**/*.ts`、relationship-memory 运行源码与测试，`tsc` 失败即阻断。

首次全覆盖 typecheck 除调查中的 3 条旧诊断外，又暴露 5 条测试 fixture/union 诊断；均以字段补齐、union narrowing、测试断言收窄或外部 JSON string narrowing 做最小修复，没有排除文件、诊断白名单、`ts-ignore` 或业务重构。代码 head `5a4aa7f7216002607b94b5d3df69fc0d725045d6` 的统一 CI 为 SUCCESS：51/51 test files、442/442 tests PASS，typecheck 0 diagnostics。验证 run：https://github.com/kannch8765/claude-subconscious-wip/actions/runs/33989098614 。

## 新旧检查映射与剩余项

093AA 仍会在普通 PR 上创建名为 `test` 的 skipped check；093AG/AH/AN/AO 都是宽路径触发、重复 `npm test` 的 `test` check。它们暂未删除：现有 MCP 无 branch-protection/ruleset/required-status-check 读取能力，而 `main protected:false` 不足以证明无 required 依赖，因此依 TASK 保守并跑，待有 Administration read 证据后再迁移。Letta Code 的 `letta` 独立职责未改。

093AP 保留专项价值，并把 PR 路径扩到真实锁实现 `relationship-memory/src/store/**` 及并发测试；本 PR 因修改该 workflow 实际执行 20× contention stress 并 SUCCESS：https://github.com/kannch8765/claude-subconscious-wip/actions/runs/33989098621 。作为无关路径对照，普通 PR #79 没有 093AP check。标准离线命令为 `npm ci && npm run test:ci && npm run typecheck`。本单未部署、未进入 VPS、未调用真实服务，也未处理 recall。
