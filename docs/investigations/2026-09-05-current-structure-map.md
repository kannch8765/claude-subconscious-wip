# claude-subconscious-wip 当前结构调查简报

> 调查范围：只读 GitHub；未进入 VPS，未修改现有代码，未启动服务/backfill，未调用模型或 embedding，未运行测试。

## 基准

- 仓库：`kannch8765/claude-subconscious-wip`
- 基准分支：`main`
- exact commit：`e83e75956b468dc43491bcb8fafff8ac70d0e854`
- commit：`Align backfill affective guidance with schema (#78)`
- tree：`dff6540c3ac17c86470e890ca8a8cdba1cf030de`
- 调查结束前重新读取 `main`，仍是上述 commit。
- exact tree 中未发现 `AGENTS.md`，也未发现仓库内 `CLAUDE.md`。本轮实际参考的仓库级说明/接线文件主要是 `README.md`、`package.json`、`.mcp.json`、`.claude-plugin/plugin.json`、`hooks/hooks.json` 与 `docs/`。其中 README/plugin metadata 仍保留上游 Letta 项目表述，不能据此推断 production 配置。
- GitHub 当前返回 `main` 为 `protected: false`，branch protection 中无 required status checks。尚未另行调查 repository rulesets 或外部 CI，因此不能据此断言不存在其他组织级约束。

## 1. 模块地图

| 模块 | 主要目录 / 入口 | 负责什么 | 主要连接 |
|---|---|---|---|
| Claude Code plugin / hook ingress | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/silent-npx.cjs`, `scripts/session_start.ts`, `scripts/sync_letta_memory.ts`, `scripts/pretool_sync.ts`, `scripts/send_messages_to_letta.ts` | 把 Claude Code SessionStart / UserPromptSubmit / PreToolUse / Stop 接到 Subcon；维护 session/conversation state；把 whisper 注回前台 | Claude Code ↔ Letta conversation ↔ whisper queue ↔ relationship memory |
| Live async observer | `scripts/send_messages_to_letta.ts`, `scripts/send_worker_native.ts`, `scripts/transcript_utils.ts`, `scripts/conversation_utils.ts` | Stop 后读取新增 transcript，构造 trusted canonical evidence，异步启动 native Letta turn；负责 live 长期记忆维护与可选 whisper | relationship-memory adapter/tools/store；native Letta client；stdio MCP；whisper queue |
| Sync foreground lane（实现存在） | `scripts/sync_subcon.ts`, `scripts/sync_letta_resources.ts`, `scripts/sync_client_tool_gate.ts`, `scripts/send_worker_native.ts` 的 `mode=sync` | 为当前前台 turn 建临时 Letta agent/conversation，只做 recall/entity grounding + whisper，不拥有 canonical mutation | 同一 native worker；relationship recall；sync checkpoint/queue |
| Whisper / foreground visibility | `scripts/subcon_whisper_queue.ts`, `scripts/grounded_whisper.ts`, `scripts/subcon_visibility_mirror.ts`, `scripts/retract_sync_whisper.ts` | durable whisper 选择/排队/ack；把历史 quote window 与可证明的 identity anchor 组合；另写 UI visibility mirror | live worker → UserPromptSubmit / PreToolUse → 前台/PWA visibility |
| Canonical relationship memory | `relationship-memory/src/{schema,store,tools,adapter,intent,owner,projection}` | schema、append-only canonical JSONL、mutation lock、记忆/实体 remember/reinforce/search、assistant remember intent、owner correction/effective view、Letta projection | live async、backfill、recall、admin、semantic retrieval |
| 主动 recall MCP | `.mcp.json`, `scripts/recall_mcp.ts`, `scripts/recall_runtime.ts`, `relationship-memory/src/recall/index.ts` | 前台 Claude 主动问一次自然语言问题；只读查 canonical memory + transcript，模型综合后 `deliver_recall` | Claude MCP → isolated Letta conversation → Letta Code SDK → read-only recall tools |
| Remember-intent MCP | `.mcp.json`, `scripts/remember_intent_mcp.ts`, `relationship-memory/src/intent/index.ts` | 前台记录“想记住什么/当时感受”的 transcript-visible intent；MCP 本身不直接写 canonical memory | tool_use transcript → Stop hook extraction → canonical processing |
| Embedding / semantic index | `relationship-memory/src/retrieval/index.ts`, `relationship-memory/src/tools/index.ts` | DashScope Qwen embedding、derivative `index.json`、lock/cooldown、lexical+semantic hybrid ranking | canonical memory/entity search；live async 与 sync recall 使用不同 semantic path |
| Historical transcript backfill | `scripts/relationship_memory_backfill.ts`, `scripts/relationship_observer_runner.ts`, `scripts/backfill_runtime_safety.ts`, `relationship-memory/src/backfill/{index,snapshot}.ts`, `scripts/backfill_agent_config.ts` | snapshot/transcript → checkpointed batches → dedicated observer → canonical writes；完成后 best-effort projection sync | transcript snapshot ↔ native Letta ↔ canonical store ↔ Letta projection blocks |
| Legacy / migration / specialized backfill | `relationship-memory/src/legacy/*`, `scripts/legacy_semantic_backfill.ts`, `scripts/legacy_semantic_observer_runner.ts`, `scripts/relationship_memory_backfill_omen.ts`, sanitizer/stripe scripts | Ombre 等 frozen legacy source 的语义迁移；另有 Omen runtime-profile historical runner；历史 transcript 清洗/stripe | canonical store、backfill agent、native Letta；均不是默认 live hook |
| Admin / observability | `relationship-memory/src/admin/{index,http}.ts`, `owner/*`, `observability/*` | relationship-memory effective read model + Letta runtime/recent runs/prompt cache/provider usage；导出 GET handler | canonical store + Letta read transport；本仓 exact tree 未发现独立 admin HTTP server 启动入口 |
| Packaging / ops / CI | `hooks/build.ps1`, `hooks/SilentLauncher.cs`, `.github/workflows/*` | Windows silent hook launcher 构建；GitHub Letta action；多组历史 task test workflow | plugin/runtime packaging、GitHub Actions |
| Tests | `scripts/*.test.ts`, `relationship-memory/tests/*.test.ts` | Vitest：live transport、config reconciliation、store/concurrency、semantic retrieval、backfill、admin、recall 等 | 主要使用 temp fs、fake provider/client/transport |

**部署脚本观察**：这个 exact tree 中没有发现 systemd/Docker/VPS deploy 目录或通用 production deploy script。仓库内的“部署/运行接线”主要是 Claude plugin hooks、Windows launcher build 与 GitHub Actions。production 发布脚本若存在，应在别处；本轮未知。

## 2. 两条主要运行路径

### A. Live 消息 → whisper

#### 仓库默认 hook 路径：异步 Stop lane

`hooks/hooks.json` 的默认接线是：

1. `SessionStart`
   - `scripts/session_start.ts`
   - `scripts/sync_letta_memory.ts`
2. `UserPromptSubmit`
   - `scripts/sync_letta_memory.ts`
3. `PreToolUse`
   - `scripts/pretool_sync.ts`
4. `Stop`（`async: true`）
   - `scripts/send_messages_to_letta.ts`

核心链路：

`Claude Stop`
→ `send_messages_to_letta.ts`
→ `readTranscript()` + session cursor
→ 先提取/持久化可信 assistant remember intent
→ 取得/创建 live Letta conversation
→ `buildCanonicalMessages()` + `makeBatchId()`
→ 写临时 worker payload
→ detached `send_worker_native.ts` (`mode=async`)
→ `createRuntime()` / `RelationshipMemoryStore.beginBatch()`
→ native `@letta-ai/letta-client` conversation
→ relationship client tools（真实 user message 时硬要求至少成功一次 `memory_search`）
→ 可执行 `memory_reinforce` / `memory_remember` / `entity_remember`
→ 可选 `deliver_whisper(memory_id, snippet_ids)`
→ `queueSubconWhisper()`
→ finalize canonical batch
→ 成功才推进 transcript cursor；retryable failure 保持 cursor 并写 conversation recovery marker。

async lane 还会通过 `openStdioMcpToolsFromEnvironment()` 加载可选 stdio MCP client tools；与 native relationship tool 同名时忽略 MCP 冲突项。

前台消费：

- `LETTA_MODE` 默认值由 `getMode()` 明确为 **`whisper`**。
- `whisper` 模式下，`sync_letta_memory.ts` 只读本地 whisper queue、mirror visibility、stdout 注入；**不会在前台 hot path 联系 Letta 或 fetch agent state**。
- `PreToolUse` 也可在一个 turn 进行中消费 async/legacy queue 项，因此后台 Stop worker 若中途完成，whisper 不一定要等到下一次 user prompt。
- `full` 是可选模式：除 whisper 外还 fetch Letta agent blocks，并注入首次完整 blocks / 后续 diff。
- `off` 禁用 hooks。

**重要写入位置**：

- session state：`<LETTA_HOME or cwd>/.letta/claude/conversations.json`、`session-<id>.json` 等。
- canonical memory root：`RELATIONSHIP_MEMORY_DIR`；未配置时 `~/.local/share/relationship-memory`。
- canonical append-only files 包括 `memories.jsonl`, `evidence.jsonl`, `reinforcements.jsonl`, `entities.jsonl`, `entity-evidence.jsonl`, outcomes/batches/assistant-intents/owner-revisions 等；mutation 通过 `.canonical-mutation.lock` 串行化。
- whisper/worker payload/日志由本地 queue/temp-state helper 管理。

#### 同步 foreground lane：实现存在，但默认接线未证实

`scripts/sync_subcon.ts` 是明确标注 additive 的同步 lane：为当前 prompt 创建临时 tool-stripped Letta sibling agent + conversation，启动同一个 `send_worker_native.ts` 的 `mode=sync`，等待 `whisper/no_whisper/failed/timeout` checkpoint。

在 worker 中 sync 模式只保留 `memory_search` / `entity_search`，再添加 `deliver_whisper`；不开放 canonical remember/reinforce/entity mutation，也禁用外部 stdio MCP。代码把 async Stop lane 定义为长期记忆写入的唯一 owner。

本轮在 `package.json` 与 `hooks/hooks.json` 中**没有找到 `sync_subcon.ts` 的默认 launcher**。因此：

- “实现存在”已确认；
- “仓库默认启用”没有证据；
- production / 外部 wrapper 是否调用它，本轮未知，不能从 repo 推断。

### B. Historical transcript → canonical memory

主入口是 `npm run backfill` → `scripts/relationship_memory_backfill.ts`，不是 live hook 自动路径。

链路：

`--snapshot-manifest` 或 `--transcript`
→ `assertPrivilegedSnapshotRuntimeSafety()`（privileged snapshot 情况下 fail closed 检查 canonical root effective writer access、semantic-index ownership、显式 subject/root/agent 等）
→ `resolveBackfillTranscriptInput()`
→ `loadBackfillState()`
→ `getBackfillAgentId()`（dedicated backfill agent）
→ 必要时创建/轮换 observer conversation
→ `runHistoricalBackfill()` 做 bounded/checkpointed batch
→ `runRelationshipObserverBatch()`
→ `createRuntime(canonicalMessages, ...)`
→ `RelationshipMemoryStore.beginBatch()`
→ native Letta conversation + local relationship tools
→ model 选择 remember/reinforce/entity operations
→ canonical JSONL mutation
→ `finalizeBatch()`
→ completed 时 `rebuildProjection()` 并 best-effort PATCH Letta core-memory projection blocks。

补充路径：

- `npm run legacy-backfill` → `legacy_semantic_backfill.ts`：处理 frozen legacy assistant source（含 manifest digest/provenance），与普通 transcript backfill 不是同一种 source contract。
- `scripts/relationship_memory_backfill_omen.ts`：与普通 historical runner 高度相似，但先 `configureVerifiedOmenBackfillRuntime()`；当前 `package.json` 没有对应 script，属于“实现存在、默认入口未发现”。
- sanitize / stripe 脚本是手动数据准备工具，不是自动 ingestion lane。

## 3. 最值得后续拆单调查的 5 个点

### 1) CI workflow 已经明显呈现 task-era 叠加形态（推荐先查）

**看到什么**

- `.github/workflows/task-093ag-tests.yml`
- `.github/workflows/task-093ah-tests.yml`
- `.github/workflows/task-093an-tests.yml`
- `.github/workflows/task-093ao-tests.yml`

这四份对普通 `pull_request -> main` 使用基本相同的 path 范围，并都执行 `npm ci` + **完整 `npm test`**。

`task-093aa-tests.yml` 也监听类似 PR paths，但 job 额外 `if` 到两个历史 task branch；普通 branch 会 skip。

`task-093ap-tests.yml` 则只针对 concurrent-writer 文件，额外跑 20 次 contention stress 后再跑全套。

exact tree 没有看到一份角色清晰的通用 `ci.yml`。当前 `main` branch protection 也没有 required status check。

**为什么值得查**

这是后续每一个整理 PR 的验证地基。现在既可能一个普通 PR 重复跑多次相同 full suite，也存在“哪些 check 真正必须通过”不清楚的问题；继续叠任务 workflow 会让验证面越来越难读。

**已确认 / 未确认**

- 已确认：上述 workflow 的实际 trigger/job 内容；当前 branch protection 无 required checks。
- 未确认：repository rulesets、外部 CI、近期 PR 的真实 check matrix 是否另有约束。

**下一小单**

只读检查 rulesets + 最近 3–5 个相关 PR 的 checks，把每个 workflow 的唯一职责、重复 full-suite 次数、真正 coverage 缺口列成一张表；先不改 YAML。

### 2) sync foreground 与 async Stop 两条 live lane 的真实启用/故障边界

**看到什么**

- 默认 hooks 明确接 async `send_messages_to_letta.ts`。
- `sync_subcon.ts` / `sync_letta_resources.ts` / worker `mode=sync` 是完整实现。
- sync 与 async 共用 `send_worker_native.ts` 和 whisper queue，但 sync 只读 canonical，async 才写长期记忆。
- queue 还有 exact turn partition / stale sync whisper 处理。

**为什么值得查**

这是最复杂的 live 生命周期交界：同一 user turn 可能有两次 recall、两套 Letta resource lifecycle，但必须保持单写入 owner、exact-turn whisper 与失败 cleanup。不清楚真实 caller 就很难安全清理 sync 相关 gate。

**已确认 / 未确认**

- 已确认：代码中的所有权边界与 repo 默认 hooks。
- 未确认：production/PWA/runtime 是否从仓库外调用 `sync_subcon.ts`；什么条件启用/回退。

**下一小单**

只在 GitHub 追 `sync_subcon`, `SUBCON_SYNC_EXPECTED_TURN_FILE`, sync checkpoint/queue symbols 和对应 runtime-evidence docs/相关 PR，画出“repo 内 caller + repo 外必须提供的 contract”；不进 VPS。

### 3) 两套 Letta transport 是按职责并存，还是仍有可收束的迁移残留

**看到什么**

- live/backfill 核心：`scripts/native_letta_backfill.ts` 直接 `import Letta from '@letta-ai/letta-client'`，`send_worker_native.ts` 与 observer 都复用 native conversation harness。
- 主动 recall：`scripts/recall_runtime.ts` 动态 import `@letta-ai/letta-code-sdk`，使用 `resumeSession()`。
- `package.json` 同时依赖两者。

**为什么值得查**

不能因为 SDK 名字“旧”就删：当前 recall 明确依赖 SDK 提供的 isolated read-only tool session。但双 transport 会带来 URL/config、agent/session lifecycle、tool contract、升级兼容两套边界。

**已确认 / 未确认**

- 已确认：live/backfill 与 recall 当前走不同 transport。
- 未确认：除此之外是否还有迁移残留 import；两套 transport 是否各有不可替代能力；agent/runtime reconciliation 是否重复。

**下一小单**

全仓只列两种 package 的 import/caller 与每个 caller 实际需要的 capability，再对照现有 tests/docs；不做替换。

### 4) semantic retrieval 的 fail-open / 成本边界分散在多个层

**看到什么**

- `createRuntime()` 尝试 `createSemanticRetrieverFromEnvironment()`，构造失败会回到无 semantic retriever。
- async `memorySearchHybrid()` 使用 `semanticRetriever.rank()`：可补齐缺失/变化 document vector，然后做 query embedding；异常后 lexical fallback。
- foreground `memorySearchRecallHybrid()` 只调用 `rankExisting()`，明确不 refresh document vectors，但已有缓存可用时仍需要 **query embedding**；异常也回 lexical。
- `retrieval/index.ts` 另外实现 provider lock、per-batch checkpoint、quota/throttle/provider cooldown。

**为什么值得查**

这是性能、召回质量、付费 API 与“坏配置是否静默降级”共同交界。逻辑本身有测试，但现在 policy 分散在 adapter/tools/retrieval 三层，很容易后续改一层破坏另一层假设。

**已确认 / 未确认**

- 已确认：sync 不补 document embeddings；async 可补；两者都可 lexical fallback；DashScope provider 默认 model 是 `text-embedding-v4` / 1024 dims（只有 provider 被显式启用时才生效）。
- 未确认：production 实际 env；哪些 fail-open 是刻意产品行为、哪些只是故障恢复遗留。

**下一小单**

只读做一张 semantic decision table：配置缺失 / key 文件错 / index miss / content hash mismatch / quota / throttle / query provider error × async/sync 的行为和 API 调用次数，对照现有 semantic tests 找未覆盖格子。

### 5) historical backfill runner 出现高度相似的 profile 变体，同时还有独立 legacy migration contract

**看到什么**

- `relationship_memory_backfill.ts` 与 `relationship_memory_backfill_omen.ts` 的 CLI、safety、checkpoint、conversation、batch processor 几乎同构；Omen 版多一步 `configureVerifiedOmenBackfillRuntime()`。
- Omen runner 当前没有 package script。
- `legacy_semantic_backfill.ts` 则不是简单模型变体：它绑定 frozen manifest、legacy source/provenance 和 terminal completion contract。

**为什么值得查**

普通/Omen runner 很像“profile 参数被复制成文件”；legacy runner 又确实有不同数据契约。若不区分这两类差异，整理时容易要么继续复制 runner，要么错误合并 legacy 语义。

**已确认 / 未确认**

- 已确认：standard/Omen 源码结构高度相似；legacy source contract 实质不同。
- 未确认：Omen 是临时评估 lane、预备替换还是长期支持 profile；是否还有外部调用它。

**下一小单**

对 standard vs Omen 做 exact diff + 查引入它的相关 PR/docs，只回答“真正不同的 runtime profile 参数有多少、能否由一个 runner 参数化”；legacy migration 不纳入重构候选。

### 一个额外观察（先不占候选名额）

`scripts/session_start.ts` 重新实现了 `getDurableStateDir/getConversationsFile/getSyncStateFile/saveSessionState` 一组 state-path/write helper，而 `scripts/conversation_utils.ts` 已有同名/同职责实现并继续演化出 lock/retry marker。现在看得到真实重复，但还没证明会造成 race；如果后续 live-lane 调查碰到 session state 漂移，这里应顺手列为子调查点，而不是直接删。

## 4. 后续改动靠什么验证

### 统一入口

- `npm test` → `vitest run`
- `npm run test:watch` → Vitest watch

多个 GitHub test workflows 在 **没有注入 Letta/DashScope secret** 的情况下直接执行 `npm test`，因此当前核心 test suite 明显是按“无外部模型服务也能跑”设计的。`npm ci` 本身仍需要包源/缓存，这里的“离线”指测试逻辑不依赖真实 Letta/付费模型服务。

### 重要测试分组

| 分组 | 代表测试 | 依赖判断 |
|---|---|---|
| canonical store / schema / tools / owner | `relationship-memory.test.ts`, `owner-control-plane.test.ts`, `assistant-originated-intent.test.ts`, `transcript-event-evidence.test.ts` | 离线；temp fs / fixture |
| concurrency / locking | `concurrent-writer-safety.test.ts` + child | 离线；本地 child process/filesystem；093AP 另有 20x stress workflow |
| semantic retrieval/index | `semantic-retrieval.test.ts`, `semantic-context.test.ts` | 离线；`FakeProvider` / fake retriever 明确记录 document/query calls，不需真实 DashScope |
| live native Letta harness | `native_letta_backfill.test.ts`, `live_*`, `sync_worker_lifecycle.test.ts`, `sync_subcon_mode.test.ts`, `sync_letta_resources.test.ts` | 离线；fake native client / dependency injection / local temp resources |
| whisper / visibility | `grounded_whisper.test.ts`, `subcon_whisper_queue.test.ts`, `subcon_visibility_mirror.test.ts`, `subcon_voice_contract.test.ts` | 离线 |
| MCP | `recall_mcp_entrypoint.test.ts`, `stdio_mcp_client.test.ts` | 离线协议/stdio 测试；真实 `recall_runtime.ts` 执行不是离线 |
| backfill / migration | `backfill.test.ts`, `backfill-snapshot.test.ts`, `backfill_runtime_safety.test.ts`, `relationship_observer_runner.test.ts`, `legacy-semantic-migration.test.ts`, `legacy-ombre-*`, sanitizer/stripe tests | 测试本身离线；真实 runner 需要服务/输入/写权限 |
| config / reconciliation | `agent_config.test.ts`, `agent_prompt_reconciliation.test.ts`, `backfill_agent_config.test.ts`, `managed_runtime_config.test.ts`, `live_agent_surface_reconciliation.test.ts`, dependency/API-url tests | 以 mock/contract 为主；真实 reconcile 会接 Letta |
| admin / observability | `admin-http.test.ts`, `admin-read-model.test.ts`, `runtime-observability.test.ts`, `prompt-cache-observability.test.ts`, `opencode-provider-usage.test.ts` | 离线 fake transport/read model |

### 真实外部依赖 / 不应当作普通离线验证运行的入口

- `session_start.ts`, `send_messages_to_letta.ts`, `send_worker_native.ts`, `sync_subcon.ts`：真实运行需要 `LETTA_API_KEY` + Letta endpoint/agent/config。
- `recall_runtime.ts`：需要 Letta，并启动 isolated SDK session。
- `npm run backfill` / `npm run legacy-backfill`：真实运行会调用 Letta/model并写 canonical/checkpoint/projection；privileged snapshot 还要求特定 FS 权限/ownership boundary。
- semantic provider 被启用时：需要 `RELATIONSHIP_MEMORY_EMBEDDING_API_KEY_FILE`；async search 可能产生 document embeddings，sync/existing-only 仍可能产生 query embedding，因此真实调用可能有配额/费用。
- `.github/workflows/letta.yml`：使用 GitHub `LETTA_API_KEY` secret 调 Letta Code Action；它是 GitHub automation，不是 Vitest 验证入口。
- sanitizer/stripe/backfill CLI 即使可在本地文件上运行也会修改数据/checkpoint；不应作为“只读验证”随手执行。

本轮没有执行任何上述测试或运行入口。

## 推荐先查哪一单

**先查 CI workflow / required-check 地图。**

理由不是它最“有趣”，而是它是后面所有清理任务的安全网，而且当前证据最硬、调查成本最低：同一 PR path 下已经存在多份 task 命名的 full-suite workflow，同时 main 没有 branch-protection required checks。先弄清哪些 workflow 只是历史任务壳、哪些 stress/特殊覆盖必须保留，后面无论查 sync lane、semantic fallback、Letta transport 还是 backfill duplication，都能知道一个小 PR 到底应该靠什么证明自己没有回归。

**证据缺口**：repository rulesets、外部 CI/机器人以及近期 PR 的实际 check matrix 本轮没有展开；下一单只需补这部分即可判断是否真的需要整理 CI，暂时不建议直接删除任何 workflow。
