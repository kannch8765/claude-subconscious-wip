# 实施 09：显式 recall recovery

## 结论

旧提交 `656f9fcaa447a415c86c082ddb81e5f94c444459` 不是显式 recall “完全不可用”的启动根因；symlink plugin overlay 下 MCP 无输出的问题已由 #72 修复并在当前 main 保留。该提交实际解决的是 recall 已能调用后，模型仍需自行串行执行 memory search → transcript search/read 的多轮往返：延迟更高，也更容易重复搜索或把查询带偏。本单因此只恢复其仍适用的 bundle-first 方向，没有合入旧 `task/subcon-recall-pipeline-v2` 后续的 foreground sync、whisper 或 receipt 工作。

## 移植后的行为

外层接口保持 `.mcp.json → recall_mcp.ts` 的 `recall({query})`，调用方和返回 `RecallResult` 不变；#72 realpath/symlink entrypoint 也未修改。内部 `recall_runtime.ts` 先从当前 owner-effective active canonical view 做现有 hybrid semantic/lexical 检索，再对同一 query 做可见 user/assistant transcript search，并只读取前三个 trusted hit 的前后各 2 条上下文。初始 bundle 上限为 8 条 relationship result、6 条 transcript hit、3 个 transcript window、序列化 128 KiB；每个 window 同时带原 hit 的 `hit_source_ref` 和 read `source_ref`，canonical summary 与 transcript 原文上下文均保留来源关联。

隔离 recall 模型不再直接拥有三种底层搜索工具，只看到一次可选 `expand_recall` 和终止 `deliver_recall`；expand 仍走同一受限检索且每次 recall 最多一次。`deliver_recall` 继续拒绝未知/伪造 source_ref，重复 ref 去重，timeout/cancel/late delivery 及空结果语义保持。历史 query、memory、transcript 内容在 prompt 中 XML escape，并明确标记为 data-only；其中类似 instruction/tool/XML 的文本不能作为指令执行。整个路径仍以 `ensureRoot=false` 只读打开 store，不写/reinforce memory、不重建索引或触发后台 embedding。

## 验证与限制

`39fa8e52f8af22bf77315f2866e0d60a763cb42b` 的统一离线 CI SUCCESS：`relationship-memory/tests/recall.test.ts` 15/15、`scripts/recall_mcp_entrypoint.test.ts` 2/2，其中包含 symlink 启动回归及真实 stdio initialize → initialized → tools/list → `tools/call`（注入离线 recall mock）；全量 51/51 files、446/446 tests，`npm run typecheck` 通过。CI：https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34018521134 。

这些结果证明离线 transport、bundle/provenance、边界和失败语义成立，不证明真实 Letta/Claude 模型质量、真实 semantic provider 命中率或线上延迟已经恢复。下一步应在独立合成 store/transcript 中做一次真实 Claude Code/Letta canary（例如查询“京都橙子蛋糕”），确认外层 `recall` 返回有 source_ref 的答案、模型最多一次 expand，并在结束后清理临时 conversation/process；不要使用 production 记忆数据。
## 合并前定点验收补充（2026-09-06）

验收发现并补了三处原 head 缺口。其一，128 KiB 原实现是序列化超限直接失败，并非截断；现改为按 UTF-8 字节安全收缩超长证据（含中文），必要时再按低优先级尾部裁剪，并在每次收缩后重算 transcript hit/window 与 `source_refs` 关联。新增超长中文单条回归确认初始 bundle 实际 `<=128 KiB`、截断标记存在且 `hit_source_ref`/read `source_ref` 仍对应；同一逻辑也由 `expandEvidenceBundle()` 复用。其二，旧 `deliver_recall` 只检查 ref 是否曾被 session 注册，因此“预先搜到但未进入实际 bundle”的 ref 仍可能通过；现 bundle 模式维护实际交付给模型的 evidence-ref union，未知 ref 或未交付 ref 都拒绝，初始 bundle 与一次 expand 的已交付 ref 均可引用。其三，hybrid 预取原调用 `SemanticRetriever.rank()`，会为缺失/变更文档生成 embedding 并写 derivative index，违反本单只读意图；现改为 `rankExisting()`，只消费已有文档向量，不刷新/写索引，也不生成 document embedding。FileBacked `rankExisting()` 仍会对非空查询调用一次 `embedQuery(query)`；因此显式 recall 仍有 query embedding 外部调用，这一点不能表述成“完全无 embedding 调用”。

补充离线回归还覆盖：总 deadline 在初始 evidence prefetch 尚未返回时即可 timeout 且晚到结果不能 delivery；外部取消发生在唯一一次 expand 尚未返回时立即得到 cancelled，晚到 expansion 不能继续；既有模型执行 timeout/cancel/late-delivery 回归继续保留。最终验收应以本补丁后的 exact head 与统一 PR offline CI 为准；未调用真实 Letta、模型或 embedding provider。
