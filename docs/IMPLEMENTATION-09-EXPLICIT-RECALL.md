# 实施 09：显式 recall recovery

## 结论

旧提交 `656f9fcaa447a415c86c082ddb81e5f94c444459` 不是显式 recall “完全不可用”的启动根因；symlink plugin overlay 下 MCP 无输出的问题已由 #72 修复并在当前 main 保留。该提交实际解决的是 recall 已能调用后，模型仍需自行串行执行 memory search → transcript search/read 的多轮往返：延迟更高，也更容易重复搜索或把查询带偏。本单因此只恢复其仍适用的 bundle-first 方向，没有合入旧 `task/subcon-recall-pipeline-v2` 后续的 foreground sync、whisper 或 receipt 工作。

## 移植后的行为

外层接口保持 `.mcp.json → recall_mcp.ts` 的 `recall({query})`，调用方和返回 `RecallResult` 不变；#72 realpath/symlink entrypoint 也未修改。内部 `recall_runtime.ts` 先从当前 owner-effective active canonical view 做现有 hybrid semantic/lexical 检索，再对同一 query 做可见 user/assistant transcript search，并只读取前三个 trusted hit 的前后各 2 条上下文。初始 bundle 上限为 8 条 relationship result、6 条 transcript hit、3 个 transcript window、序列化 128 KiB；每个 window 同时带原 hit 的 `hit_source_ref` 和 read `source_ref`，canonical summary 与 transcript 原文上下文均保留来源关联。

隔离 recall 模型不再直接拥有三种底层搜索工具，只看到一次可选 `expand_recall` 和终止 `deliver_recall`；expand 仍走同一受限检索且每次 recall 最多一次。`deliver_recall` 继续拒绝未知/伪造 source_ref，重复 ref 去重，timeout/cancel/late delivery 及空结果语义保持。历史 query、memory、transcript 内容在 prompt 中 XML escape，并明确标记为 data-only；其中类似 instruction/tool/XML 的文本不能作为指令执行。整个路径仍以 `ensureRoot=false` 只读打开 store，不写/reinforce memory、不重建索引或触发后台 embedding。

## 验证与限制

`39fa8e52f8af22bf77315f2866e0d60a763cb42b` 的统一离线 CI SUCCESS：`relationship-memory/tests/recall.test.ts` 15/15、`scripts/recall_mcp_entrypoint.test.ts` 2/2，其中包含 symlink 启动回归及真实 stdio initialize → initialized → tools/list → `tools/call`（注入离线 recall mock）；全量 51/51 files、446/446 tests，`npm run typecheck` 通过。CI：https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34018521134 。

这些结果证明离线 transport、bundle/provenance、边界和失败语义成立，不证明真实 Letta/Claude 模型质量、真实 semantic provider 命中率或线上延迟已经恢复。下一步应在独立合成 store/transcript 中做一次真实 Claude Code/Letta canary（例如查询“京都橙子蛋糕”），确认外层 `recall` 返回有 source_ref 的答案、模型最多一次 expand，并在结束后清理临时 conversation/process；不要使用 production 记忆数据。