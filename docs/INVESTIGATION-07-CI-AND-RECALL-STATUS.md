# Investigation 07 — CI/test 入口与显式 recall 修复去向

基准：`f0d95b65e5b2521c9c07504748c5a4f8d929b08c`。无 `AGENTS.md`；本轮仅 GitHub/离线只读查证，未碰 VPS、Letta、模型、embedding、backfill 或仓库规则。

## A. CI / test：结论

当前没有真正统一的普通 PR CI。基准树只有 7 个 workflow：`letta.yml` 加 6 个历史 task workflow；其中 093AG/AH/AN/AO 对 `scripts/**`/`relationship-memory/**` 等路径都跑同一个 `npm ci && npm test`，093AA 还额外按旧 branch name 做 job-level `if`，所以普通 PR 会出现“workflow 触发但 check skipped”。093AP 只有并发锁相关文件变化才跑 20 次 contention stress + `npm test`。`letta.yml` 是 Letta 自动化，不是离线测试，而且 PR 事件只监听 `opened,labeled`，后续 synchronize 不会稳定重验。

| workflow / check | 触发 | 命令 | 角色 |
|---|---|---|---|
| Letta Code / `letta` | issue/PR opened,labeled + comments | Letta action | 外部服务自动化，非默认验收 |
| Task 093AA / `test` | PR→main + broad paths；旧 branch-name `if` | `npm test` | 历史任务门，普通分支可 skip |
| 093AG/AH/AN/AO / `test` | PR→main + broad paths；部分旧 branch push | `npm test` | 四份重复离线 suite |
| 093AP / `test` | 两个并发测试文件或旧 branch push | 20× focused Vitest + `npm test` | 独有 contention stress |

`package.json` 只有 `test = vitest run`，没有 `typecheck` / `test:ci`；仓库也无 `tsconfig.json`。#81 的 premerge 报告证明当前显式 NodeNext `tsc --noEmit` 仍有 3 条既有诊断：`scripts/agent_config.ts:318`、`scripts/sync_letta_resources.ts:166,170`，基准/当前均为 3、0 new。不要把“相对 baseline 无新增”长期当成 typecheck；下一实现单应先收掉这 3 条或建立正常 `tsconfig.ci.json`，再提供硬失败的 `npm run typecheck`。

#79 final head `968bc598…`、#80 `092f490f…` 都实际得到 093AG/AH/AN/AO 四个 success + 093AA skipped；#81 final head `87dc7577…` 同样如此。#81 另有两个 push-only 临时 workflow：`task-06-apply.yml`（曾自动 apply/test/typecheck/commit，最终成功 run [33977692605](https://github.com/kannch8765/claude-subconscious-wip/actions/runs/33977692605)）和 `task-06-premerge-acceptance.yml`（最终成功 run [33979718636](https://github.com/kannch8765/claude-subconscious-wip/actions/runs/33979718636)）；两者在最终 PR head 前已删除，不能当以后普通 PR 的 CI。完整验收记录见 [`PREMERGE-ACCEPTANCE-06-MEMORY-WRITE-TOOLS.md`](https://github.com/kannch8765/claude-subconscious-wip/blob/f0d95b65e5b2521c9c07504748c5a4f8d929b08c/docs/PREMERGE-ACCEPTANCE-06-MEMORY-WRITE-TOOLS.md)。

并发证据需要区分两类：历史 093AP 的 lock-contention 测试已专门稳定化，PR #42 exact head `11c288f…` 的 20× stress + full suite 成功；另一方面 #71 记录过受限机器上无 worker 上限的完整 Vitest 因 `pthread_create/spawn EAGAIN` 失败，同代码 `--maxWorkers=2` 全绿，这是环境资源限制，不是业务断言失败。最近 #79–81 GitHub-hosted runner 的普通 `npm test` 均通过，未见当前代码层面的同类失败证据。

branch API 对 `main` 返回 `protected:false`；当前 GitHub MCP 没有 rulesets/required-check 查询端点，因此 ruleset 与 required status checks **unknown**，不能据此断言“无保护”。

**最小统一方案：**新增一个普通 PR 默认离线 workflow，稳定执行 `npm ci`、`npm run test:ci`（建议 Vitest 固定 `--maxWorkers=2`）和真正硬失败的 `npm run typecheck`；Letta/真实 provider/embedding 检查留在手动或明确 opt-in 的专用 workflow。093AG/AH/AN/AO 在新 CI 覆盖验证后收拢；093AA 的 branch-name gate 淘汰；093AP 的 20× stress 保留为窄路径或手动专项，不塞进所有 PR。下一实施单先开一个普通名字的测试 PR，分别触碰 `scripts/**` 与并发测试文件，确认 unified check 自动出现、专项 check 只在对应路径出现；在 required-check 状态仍 unknown 时，不先删除旧 check，先并跑一轮并记录实际 check 名，再决定迁移。

## B. 显式 recall：结论

结论是：**启动修复已合入，但还存在一个真正的显式 recall 未合入候选，需要基于当前 main 重新验收；不能拿 foreground sync/whisper 修复代替。**

最多三个相关候选：

1. [PR #11](https://github.com/kannch8765/claude-subconscious-wip/pull/11) / `task/093j-assistant-relationship-memory-recall`，exact head `a787f72a…`：建立 `.mcp.json → recall_mcp.ts → recall_runtime.ts` 的显式 recall 主链，12 files / 128 tests、targeted TS、live canary；已 merge，当前 main 包含。
2. [PR #72](https://github.com/kannch8765/claude-subconscious-wip/pull/72) / `fix/recall-mcp-symlink-entrypoint`，exact head `7f997910…`：修 Claude-P symlink plugin overlay 下 `recall_mcp.ts` 入口 guard 静默退出；13/13 focused PASS，symlinked stdio probe 能返回 initialize/tools/list；merge commit `d9a17e28…` 已在当前 main，当前 `recall_mcp.ts` 仍保留 `realpathSync` guard。
3. `task/subcon-recall-pipeline-v2` 当前 head `6a47a0b4…` 中的单独提交 [`656f9fc…`](https://github.com/kannch8765/claude-subconscious-wip/commit/656f9fcaa447a415c86c082ddb81e5f94c444459) `Prefetch evidence for explicit relationship recall`：让脚本先从 canonical memory + transcript 生成 bounded evidence bundle，模型只剩一次可选 `expand_recall` + terminal `deliver_recall`，并加 focused unit coverage。该改动没有出现在基准 main 的 `recall_runtime.ts`；后续同 branch 又叠了大量 foreground recall v2/sync 工作，且未找到该提交对应独立 PR/最终验收，因此不能整 branch 接受。

这只最像“以前修好过但没 merge”的记忆。最小下一步不是重做：从当前 main 开一个小实现单，只重审/移植 `656f9fc…` 与显式 recall 直接相关的 diff，先跑 `relationship-memory/tests/recall.test.ts` + `scripts/recall_mcp_entrypoint.test.ts`，再做隔离 stdio/Claude Code canary；若语义仍成立再单独 PR。仓库只能证明代码合入状态，不能证明 VPS 已部署或真实 recall 当前可用。