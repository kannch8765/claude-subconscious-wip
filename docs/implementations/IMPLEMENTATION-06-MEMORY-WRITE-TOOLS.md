# Implementation 06 — Schema-derived memory creation tools

本轮把模型侧统一 `memory_remember` 收敛为五个 kind-specific create tool：`memory_remember_personal_experience`、`memory_remember_shared_experience`、`memory_remember_relationship_event`、`memory_remember_inside_joke`、`memory_remember_user_preference`。kind 不再由模型传入；各工具只暴露该 kind 的 payload 字段，required / string / string-array / non-empty-array 约束均从 `MEMORY_KIND_DEFINITIONS` 生成，canonical validator 也读取同一份定义，避免字段表双写漂移。薄 dispatcher 仅补 `schema_version: 1` 与固定 kind，随后继续走原 `runtime.remember()`，因此 evidence/subject/batch 绑定、source_key/dedupe、锁、outcome、checkpoint 与错误恢复保持原路径。

tool catalog 由 `MEMORY_KINDS` 生成五个名称、schema、注册和 mutation 分类；sync 权限仍是显式 `memory_search + entity_search` allowlist，不会因新增 kind 自动获得写权限。live async 与 historical backfill 都从同一 catalog 取工具，旧 standalone `memory_remember` 不再同 turn 暴露；#79 的 `config/live-system.md` / `config/backfill-system.md`、两份 AgentFile system/bootstrap 与 live `tool_guidelines` 已同步。final native client-tool 回归同时检查 live 与 backfill 的实际 parameters，锁住 `relationship_event` 不得出现 `emotional_tone/why_memorable`。

迁移沿用现有恢复边界：native continuation 每次请求都重带当前 `client_tools`；clean paused backfill 可保留 checkpoint/conversation 继续，只有 `retryable_batch` 才在重试前旋转 conversation。live 旧 pending/失败调用仍由既有 retry-rotation marker 处理，因此没有新增无条件 rotation、agent rebind 或 batch replay。

验证：targeted Vitest（relationship-memory、native backfill/live、sync、runner、managed prompt）、完整 `npm test` 均通过；ES2022 + NodeNext + `node,vitest/globals` 的显式 `tsc --noEmit` 与基准对照无新增诊断，基准既有诊断未扩修；另执行 `git diff --check`。未登录 VPS、未读取/修改 production canonical store、未调用真实 Letta/模型/embedding，也未 merge/deploy。
