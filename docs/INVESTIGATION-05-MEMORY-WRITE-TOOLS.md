# Investigation 05：memory write tools

## 结论

当前主要问题不是“agent 不会选工具”，而是 **`memory_remember` 的 model-facing schema 把五个 kind 的 payload 字段并成一个宽松大对象，真正的 kind 约束主要靠 description + 后端 validator**。已有真实 Omen backfill 证据：模型为 `relationship_event` 发送了只属于 `personal_experience` 的 `emotional_tone`，被 canonical validator 以 `unknown_payload_field` 拒绝后才重试；#78 修了 prompt 冲突，但大对象本身仍存在。

建议下一步 **先做离线 schema/dispatch 重构，不恢复 Omen、不做付费模型对比**。最小设计优先考虑“创建按 kind 拆薄工具、reinforce 保持独立”；不要把 revise/reinforce 混进 create。若担心一次增加 5 个工具，可先验证部分拆分，但从字段差异看五个 create kind 都有独立 required surface，长期统一大对象收益有限。

## 实际 kind / 写入入口

`relationship-memory/src/schema/index.ts` 的 canonical kind 共 5 个：

| kind | required payload | optional payload |
|---|---|---|
| `personal_experience` | `title`, `experience` | `time_text`, `places`, `themes`, `emotional_tone`, `why_memorable`, `recall_triggers` |
| `shared_experience` | `title`, `event`, `shared_meaning` | `symbols`, `recall_triggers` |
| `relationship_event` | `event`, `meaning` | `prior_context`, `resulting_change` |
| `inside_joke` | `name`, `meaning`, `trigger_phrases` | `origin`, `callbacks`, `tone` |
| `user_preference` | `topic`, `preference` | `context`, `reason`, `recall_triggers` |

模型可见 mutation 是 `memory_remember`、`memory_reinforce`、`entity_remember`（`relationship-memory/src/adapter/index.ts::buildRelationshipTools`）。`memory_reinforce` 只接 `memory_id + evidence_ids`，不含 kind/payload；owner 的 `revise/deactivate/restore` 在 `relationship-memory/src/owner/index.ts`，是管理控制面，不暴露给 observer agent。live async 与普通/Omen backfill 都经 `runRelationshipObserverBatch` 复用同一套 native client tools；sync 前台只做 recall/whisper gate，没有 canonical mutation surface。

## 四层是否一致

- **canonical schema / validator**：严格。`validateSemanticContent` 先按 kind 取 `payloadKeys[kind]`，拒绝 unknown payload、缺 required、null optional、错误数组等；evidence/subject/batch、锁、dedupe/outcome 均在 runtime/store 后端绑定。
- **model-facing tool schema**：`memoryRememberToolSchema()` 的 `payload.properties` 是五个 kind 字段的并集；kind-specific required/forbidden 只写在 `payload.description`。因此 JSON schema 本身不能阻止 `relationship_event.emotional_tone`。顶层 `oneOf` 只用于二选一 evidence 字段；现有回归还特别模拟 SDK 0.1.11 只稳定保留顶层 object/properties/required/additionalProperties/description，不能据此假定 provider 会可靠执行更复杂 discriminator/conditional schema。
- **runtime validator**：比 model-facing schema 更严格且最终权威。
- **prompt guidance**：#78 后已明确 `emotional_tone/why_memorable` 仅 personal、relationship_event 只允许四字段，但这仍是文案约束。

真实错误证据目前只找到 1 个模型案例：PR #78 记录 Omen 发送 `relationship_event.emotional_tone`，validator 拒绝后重试成功。仓内测试还覆盖 wrong-kind field 被拒绝、model-facing schema 为 payload superset；未找到第二个可确认的真实模型错 kind/漏必填案例，因此不要夸大失败率。

## 三种方向

1. **继续统一工具**：工具数最少、兼容成本最低；但字段清晰度最差，错误只能靠 prompt/validator 回馈。若要继续统一，至少应生成 kind-field matrix description 并加 schema-vs-validator drift test。
2. **每 kind 一个 create 工具**：例如 `memory_remember_user_preference(topic, preference, context?, reason?, recall_triggers?, ...common)` 与 `memory_remember_relationship_event(event, meaning, prior_context?, resulting_change?, ...common)`。模型看到的字段最清楚，能从 schema 层消除 cross-kind payload；代价是工具数 +4、prompt/allowlist/required-tool inventory/tests 要同步。
3. **部分拆分**：可先把最容易混淆且已出过错的 `personal_experience` / `relationship_event` 拆出，其他仍走 legacy unified；但会同时存在两套 create 心智模型，长期维护反而可能更绕，只适合作为短期实验。

若拆分，薄工具只负责把 kind 固定后组装当前 `MemoryProposalV1`，仍调用同一个 `runtime.remember()`，从而原样保留 trusted evidence/subject/batch 绑定、mutation lock、dedupe/source_key、checkpoint/outcome、`memory_id` 返回与 retryable/permanent error 语义。切换时应原子更新 `buildRelationshipTools`、`RELATIONSHIP_EXTERNAL/ALLOWED_CLIENT_TOOLS`、observer mutation allowlist、prompt、inventory/contract tests；不要让 agent 同时看到 legacy `memory_remember` 和新 5 工具。暂停中的 backfill 若恢复到新 surface，建议在 checkpoint 保留不变的前提下旋转 observer conversation，避免旧会话上下文继续引用旧工具名。

## 下一张最小单

离线实现/验证：生成 5 个 kind-specific create schemas + 统一 dispatcher 到 `runtime.remember()`，不改 store；新增静态测试证明每个工具只暴露本 kind 字段、错误 kind 字段在 model-facing schema 层即不存在、五工具组装结果与现有 canonical proposal 等价，并同步 allowlist/prompt。未来若要比较统一 vs 拆分，再用合成 evidence + 临时 store、同模型同 prompt/案例，统计工具选择正确率、字段错误与重试次数；本轮不调用模型。