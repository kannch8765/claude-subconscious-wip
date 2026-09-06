# Pre-merge acceptance 06 — Schema-derived memory creation tools

验收对象为 `task/06-schema-derived-memory-tools` 的实现 commit `39ef94c7cf0bdce4468aace012e1ec6298ae928b`，行为基准为 `57f5ba9998419642b70c35167b5f6aadb05bef8d`；draft PR 为 #81。完整 PR 净 diff 已复核，验收阶段仅额外保留 `scripts/task06_premerge_acceptance.test.ts` 与本报告，临时验收 workflow 已删除。结论：**未发现合并阻断**。

共同 `MEMORY_KIND_DEFINITIONS` 重构后，13 组固定 fixture 在基准与当前 `validateProposal()` 上逐字 differential 一致：覆盖五个合法 kind、跨 kind `relationship_event.emotional_tone`、缺 required、optional=null、空 required array、重复 array/participant、未知顶层字段与 forbidden authority 字段。真实 runtime 回归确认错误字段得到 `permanently_rejected/unknown_payload_field` 后 canonical memory 与 evidence 均为 0 写入，原拒绝 code/reason 保持。

五个 `memory_remember_<kind>` dispatcher 会覆盖输入中的伪造 `kind/schema_version`，固定 kind 后继续调用原 `runtime.remember()`；生成工具与直接调用旧 runtime 路径得到相同 `memory_id/source_key/dedupe_key`，重复调用为 duplicate。live async 与 historical backfill 的最终 native `client_tools` 均实际包含五工具且无旧 `memory_remember`；mutation boundary 统一走现有 runtime/store。sync allowlist 仍精确为 `memory_search + entity_search`，无 create/reinforce/entity mutation 权限。

恢复行为已改为可执行证据而非工具刷新推断：旧 conversation 返回 pending `memory_remember` approval request 时，新 surface 明确 fail-closed，cursor 不前进并写 retry marker；marker 过 grace 后通过真实 `getOrCreateConversation()` 路径旋转 conversation，同一 held batch 在新 conversation 完成并推进 cursor。clean paused backfill 则确认 `backfillStateNeedsFreshConversation=false`，保持原 conversation，并在该 conversation 上实际执行新的 `memory_remember_user_preference` 后完成并落盘。这里的兼容语义是“失败后安全旋转重试”，不是继续执行已经移除的旧 tool call。

验证：`npx vitest run scripts/task06_premerge_acceptance.test.ts` → 1 file / **6 tests PASS**；PR CI 的 `npm test` → **51 files / 442 tests PASS**。validator baseline differential → **13/13 exact match**。显式 `tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --types node,vitest/globals --skipLibCheck ...`：基准 **3 diagnostics**，当前 **3 diagnostics**，**0 new**；既有项为 `scripts/agent_config.ts:318` 一条及 `scripts/sync_letta_resources.ts:166,170` 两条。`git diff --check 57f5ba9998419642b70c35167b5f6aadb05bef8d...HEAD` PASS。

未登录 VPS，未访问/修改 production canonical store 或 agent，未调用真实 Letta/model/embedding，未恢复 backfill，未 merge/deploy。
