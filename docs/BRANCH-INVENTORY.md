# 远端分支普查

本表是任务 11 的远端分支快照。基准 main：`83bfc7114de3e33d3cb072700dc2fd3af36f3c31`。任务 11 自身分支不计入该历史快照。

判定规则：

- **已合入 main**：当前分支 head 与一个已 merged PR 的 head SHA 精确一致，或为 `main` 本身。
- **已废弃**：当前分支 head 与一个 closed、unmerged PR 的 head SHA 精确一致，且没有更强的相反证据。
- **活跃**：当前分支 head 与仍 open PR 的 head SHA 精确一致，或为 `main`。
- **无法判定**：现有 GitHub MCP 可验证事实不足以支持以上任一判定。不会根据名字、日期、相似功能或“看起来旧”推测。

> “建议删除”仅表示后续清理候选；本任务不删除任何 branch 或 tag。

| 分支 | Head SHA | 判定 | 判定依据 | 建议删除 |
| --- | --- | --- | --- | --- |
| `backfill-affective-field-guidance` | `577f59b15cdd7bb8093525f2cb58035f2cd98370` | 已合入 main | PR #78 merged，PR head 与当前 branch head 精确一致 | 是 |
| `ci/relationship-memory-01` | `9f1b11625f7cea68b0cc4f6e0556ed9f345cbe80` | 无法判定 | 未取得与当前 head 精确匹配的 merged/open/closed PR 证据 | 否 |
| `ci/relationship-memory-02` | `e2f7131388c077f74d10f73c8db43be1ee1a1ac5` | 无法判定 | 未取得与当前 head 精确匹配的 merged/open/closed PR 证据 | 否 |
| `copilot/fix-105340539-1325012496-84990af1-172e-42e1-9a65-b85a97ea6a46` | `e0637b76574452abb3e5286b0a12321f42c50383` | 已废弃 | PR #54 closed、未 merge，PR head 与当前 branch head 精确一致 | 是 |
| `copilot/noop` | `c9b1a2b3939dd33fbd15b137cbca3fc3de390cec` | 已废弃 | PR #50 closed、未 merge，PR head 与当前 branch head 精确一致 | 是 |
| `copilot/noop-again` | `960fc58bac70fac7cea71fe1b205182805db5f34` | 已废弃 | PR #82 closed、未 merge，PR head 与当前 branch head 精确一致 | 是 |
| `copilot/tasksubcon-whisper-seed-consumption` | `8fef39caeb09b33abe24aff210d51a71de016e29` | 已废弃 | PR #65 closed、未 merge，PR head 与当前 branch head 精确一致 | 是 |
| `docs/relationship-memory-historical-source-01` | `b1d29365ca4a49e0a7bb675764c93357c15308f9` | 无法判定 | 未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `docs/relationship-memory-owner-live-canary-01` | `73beb36ed908f35722c0d2cb55cce431803847fb` | 无法判定 | 未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `docs/relationship-memory-scaffold` | `68e567eb59d9b75a3236f4d38d9600ebe6f1c28a` | 无法判定 | 未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `evidence/relationship-memory-historical-backfill-owner-canary-01-02` | `a109fa097ac0c19e24df535667a75c187ba6cf3a` | 已合入 main | PR #14 base 为该 exact SHA，且后续 merged history 证明该提交已在 main 历史链上；保守记已合入 | 是 |
| `evidence/relationship-memory-post-publication-live-canary-01` | `e157e8c23a7bdfea1d4973d889d9200038f99762` | 已合入 main | PR #3 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/effective-parallel-reconciliation` | `f6d979bd2a001b9d55bef86e250715287fdf54f5` | 已合入 main | PR #57 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/live-retryable-conversation-rotation` | `7c607da87944ea5b2093ce2cd25d6b99e7145a83` | 已合入 main | PR #62 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/owner-revision-optional-field-clearing` | `b8bf3dfedfdb836fc64e714583841d7e51c18159` | 已合入 main | PR #76 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/recall-mcp-symlink-entrypoint` | `7f9979101df2c2bf9ab3024f771d8013eb2a46dc` | 已合入 main | PR #72 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/relationship-memory-observer-contract-01` | `92f80c80b18eda3fbf3503b8363486ec3402f14a` | 已合入 main | PR #2 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/subcon-admin-snapshot-performance` | `84be48000b1bd822820f3f9e8c5eca55ba756e1e` | 已合入 main | PR #75 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/093ar-batch-attempt-boundary` | `513186d0a79cc1a672ba4d6f38d56d93fda76003` | 已合入 main | PR #60 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/093ar-legacy-reinforce-retry` | `eefbc5e650462d15926ca80a206834b85781e424` | 已合入 main | PR #59 merged，PR head 与当前 branch head 精确一致 | 是 |
| `fix/093ar-legacy-second-reinforce` | `4aa5af96cbc7759366e0077ea598132df7206e2f` | 已合入 main | PR #61 merged，PR head 与当前 branch head 精确一致 | 是 |
| `investigation/current-structure-map-e83e759` | `0334328e193c7b656609d8bf368d63ae16a9258a` | 无法判定 | 调查分支；未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `investigation/structure-map-e83e759` | `e11eb1392236a23b0c04947ca00f9b8a7964f7e6` | 无法判定 | 调查分支；未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `investigation/02-config-and-cleanup` | `8dc02411f01e3dee85c414a78a566f11edb6283f` | 无法判定 | 调查分支；未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `investigation/05-memory-write-tools` | `33a5429939ba8aeda23b6108fa9cb3e058cf8ca6` | 无法判定 | 调查分支；未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `investigation/07-ci-and-recall-status` | `348f6ce5f2a9f250a1d60c6a0a392d3446ddf613` | 无法判定 | 调查分支；报告存在，但未取得当前 head 已合入/废弃的可验证事实 | 否 |
| `main` | `83bfc7114de3e33d3cb072700dc2fd3af36f3c31` | 活跃 | 仓库默认主线，本次普查基准 | 否 |
| `review/relationship-memory-01-r1` | `741db9e1ee65e966c40037c4cdc105d6741095b6` | 无法判定 | review 分支；未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `review/relationship-memory-01-r2` | `af600d6587fa3b839a4752e5beb0600666783a7a` | 无法判定 | review 分支；未取得与当前 head 精确匹配的 PR 证据 | 否 |
| `scaffold/relationship-memory-01` | `63c7a8ac65e5c13bdf6e28590eb471fcdf323887` | 已合入 main | PR #1 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/dario-runtime-provenance-gate` | `8a2a52ee89a16b7cbecd914b8de917469408b406` | 无法判定 | 当前 head 是 PR #58 的 base SHA；不足以仅据此判定分支本身已合入/废弃 | 否 |
| `task/live-subcon-entity-identity-grounding` | `208ca3d1702bd3ca9f8e9e9c69a5c3c0571eb8f7` | 已合入 main | PR #64 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/live-subcon-mimo-go` | `b5cb5bcc884f4af79a266b7ffba08b65628e609c` | 已合入 main | PR #69 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/live-subcon-model-authored-semantic-search` | `de29b6203996537a1367719e4b69491a3111cb45` | 已废弃 | PR #53 closed、未 merge，PR head 与当前 branch head 精确一致 | 是 |
| `task/live-subcon-model-authored-semantic-search-final` | `e7047552670ba7711aeee45fd712157b44e87736` | 无法判定 | PR #56 merged head 已演进为 `70b6827…`，不等于当前 branch head；无足够事实判定当前 ref | 否 |
| `task/live-subcon-native-transport-restoration` | `e54913dbebf1f320a8b959bdfc4b8c4ad2ae9dba` | 已合入 main | PR #51 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/live-subcon-stdio-mcp-client-tool-bridge` | `b255f70bdf033363b13be047f88171776e4131af` | 已合入 main | PR #63 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/memory-search-materialization` | `dfa9f6bb263e0726e7195985831c29aefc359005` | 已合入 main | PR #70 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/omen-alpha-backfill-canary` | `95f4485e16b1411e55060411654bbf65d516e263` | 无法判定 | 无与当前 head 精确匹配的 merged/open/closed PR 证据 | 否 |
| `task/omen-alpha-backfill-canary-v2` | `ff2d95596f071370bf2b5feb593a8d50039fcefd` | 已合入 main | PR #77 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/ox-alpha-backfill` | `1c9b75317bad7b88416a0210431fd4cdd15403be` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/ox-alpha-backfill-option` | `9fd9eef86ae1efbea966e429a3ccc908b2cf244d` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/subcon-async-memory-surfacing` | `c8a69d07aac160188010659dd50b26eb5e8c272b` | 已合入 main | PR #47 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/subcon-deterministic-first-memory-search` | `3f71665411d66e6ad6e8608a53850b58b98ce9ba` | 已合入 main | PR #48 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/subcon-live-backfill-role-split` | `e9f844f72ca7c92b26374e295d85c6eeae830b01` | 无法判定 | PR #46 merged 的 head 是 `851ff129…`，不等于当前 branch head | 否 |
| `task/subcon-llm-context-observability` | `6ae8ba47c6a82d97462eba2abf6015eb40a83d6c` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/subcon-memory-context-window` | `0a439421269ec3759ec8398f4b98ac46a6edc0e2` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/subcon-recall-pipeline-v2` | `6a47a0b454ccc13d0954d5ef16833849b01f8700` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/subcon-sdk-runturn-approval-recovery` | `bcf0198e6763f75dc1cc64ae7e5fbb4dbf1aaf21` | 已合入 main | PR #49 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/subcon-semantic-index-quota-safety` | `ce2b1851200c63fbfd010a58243412d1f1ffa947` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/subcon-semantic-v4-cooldown-quota-safety` | `86db79c4ed23f4e825e96198f05e3f5baf532058` | 已合入 main | PR #52 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/subcon-sync-mode` | `c74facc2696e7085fa85a8904aae16cf361910b7` | 已合入 main | PR #67 merged，PR head 与当前 branch head 精确一致；PR #68 later closed unmerged but does not undo #67 merge fact | 是 |
| `task/subcon-whisper-seed-consumption` | `b2ae654d81c0c49d4facdb2ff53ecf450cd2ea7c` | 已合入 main | PR #66 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/sync-recall-anchor-shadow` | `e5db34658f34f1ad46d80c5a9472068e3e46b8b7` | 活跃 | PR #74 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/sync-recall-blocking-canary` | `711c289fc08a81d85044ec3637584ba5296d55a0` | 活跃 | PR #73 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/sync-recall-rerank-shadow` | `d493b4c2d3a8bd2764b3110a0bcef156877ab536` | 活跃 | PR #71 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/03-editable-system-prompts` | `968bc5985302a18acb0dc3b4d0a17b38556d5cf3` | 已合入 main | PR #79 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/04-backfill-runner-convergence` | `092f490f5e2e318b4ac723a4de1b1001e0bfb0fb` | 已合入 main | PR #80 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/06-schema-derived-memory-tools` | `87dc75775c6ce5bb1ec088a71a51c6e2a5cc30bf` | 已合入 main | PR #81 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/08-unified-pr-ci` | `6e1166b0cc4571b680bab9d15235ea5a03cf29ff` | 已合入 main | PR #83 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/09-explicit-recall-recovery` | `ff8c3057b6afc770fa1b47a7ed83cc18c7bcc9c2` | 已合入 main | PR #84 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/10-whisper-memory-summary` | `85f9c7c80f9c0f6d658d754df2b4120cfe768944` | 已合入 main | PR #85 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093aa-contract-correction-source-vs-canonical-subject` | `6a01c90849e5add9e450da9bca3fef7083a93a6f` | 已合入 main | PR #31 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093aa-legacy-identity-fidelity-correction` | `59b7cda0e9964b3cb4d91d542ca4ea5434421c36` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/093aa-ombre-legacy-semantic-migration-runner` | `711b99d97f51cdd08d6afa25dc1ae67bf10bba1a` | 已合入 main | PR #29 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ab-ombre-legacy-canonical-subject-reconciliation` | `eef2f9fd0787c8f34fd4203310706e324a76f566` | 活跃 | PR #30 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093ac-subcon-canonical-af-runtime-config-reconciliation` | `b01dd3d2d5fae11ecc8bd1f3d79f13c6604d7488` | 已合入 main | PR #32 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ad-ombre-relationship-memory-fill-lane` | `b6edf15c3ee14a5b4ea48c1608596a9eb5cc0466` | 无法判定 | 无与当前 head 精确匹配的 PR 证据 | 否 |
| `task/093ae-legacy-semantic-zero-mutation-auto-retry` | `25f7d5628dea7591d270a26e4c32f9f0a95a781c` | 无法判定 | PR #33 merged 的 head 是 clean 分支 `af559014…`，不等于此 ref | 否 |
| `task/093ae-legacy-semantic-zero-mutation-auto-retry-clean` | `af55901464462d823036c39d4db760957bf9ff7c` | 已合入 main | PR #33 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ag-native-letta-backfill-harness-reconciliation` | `703505c23af949535ae598139f980d337f9095b6` | 无法判定 | 与 `task/093ag-native-letta-source-concurrency` 同 SHA，但没有足够 PR/祖先事实判定其状态 | 否 |
| `task/093ag-native-letta-source-concurrency` | `703505c23af949535ae598139f980d337f9095b6` | 无法判定 | 与另一 093AG 分支同 SHA；同 SHA 本身不能证明已合入/废弃 | 否 |
| `task/093ah-realtime-subcon-native-letta-client-adoption` | `f435af715d3568a45c119a14aa7f51d1af20628d` | 已合入 main | PR #34 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ai-kohaku-subconscious-whisper-perspective` | `fafdaf6e2bf4fa5d2a769c3e854d4a3d10fcc01b` | 已合入 main | PR #41 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ai-native-client-tool-recovery-semantics` | `df226367ae5ed5447a004ec7e3861d959d86c2bc` | 活跃 | PR #35 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093aj-native-conversation-active-run-recovery` | `37374640674728a1becab501694d0433d88bd63a` | 活跃 | PR #36 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093ak-native-duplicate-run-stream-recovery` | `f21da34d7898e3f2c3c4050edef0eeeab1316b62` | 活跃 | PR #37 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093al-native-stream-keepalive-timeout-safety` | `df974512ec19942a6aa21b4fa1820d0f2042f04e` | 活跃 | PR #38 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093am-native-stream-connect-timeout-headroom` | `7f6b9076c2a5f08a57ebea9477f1c8706727d496` | 活跃 | PR #39 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093an-native-otid-transient-server-recovery` | `746d30d96cbf9060d73ad82f7594d911f02fafe6` | 活跃 | PR #40 open，PR head 与当前 branch head 精确一致 | 否 |
| `task/093an-transcript-wrapper-sanitizer` | `bf19e4bf41957dbe5cfe9ee6efa6b5335ca59dba` | 已合入 main | PR #43 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ao-historical-dariotouch-pair-stripe` | `8dd1b4a77ab06e07af5aa09b3bd9af498091a044` | 已合入 main | PR #44 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ap-concurrent-writer-lock-contention-test-stability` | `11c288f36751891171df31e10498f5173dfb8805` | 已合入 main | PR #42 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093aq-letta-0168-agentfile-import-compat` | `f48c18b6471214a2732301e5d2a91b461c63ed6b` | 已合入 main | PR #45 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093ar-live-safe-transcript-batch-backfill` | `fa0862bbd6a8c772ff4722c26fe344a73a0b4859` | 已合入 main | PR #58 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093c-relationship-memory-owner-control-plane-abstraction` | `545a5066ee52f37ab6d5ce38c2114819c867e7cd` | 已合入 main | PR #4 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093d-subconscious-agent-runtime-observability-abstraction` | `afd743fb94ff95ca09d088334cb5cf73f83a5d69` | 已合入 main | PR #5 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093e-subconscious-prompt-cache-effectiveness-abstraction` | `57a9198007fd189970a5a6782043557a3967bfc9` | 已合入 main | PR #6 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093f-subconscious-admin-read-model-composition` | `f65d3a5f05a724415e74ef8817b223a3a9f3b6fb` | 已合入 main | PR #7 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093g-opencode-provider-usage-adapter` | `72433f51d98a6c92f18330165d9fd4cc1b2a1dc1` | 已合入 main | PR #8 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093h-subconscious-admin-http-boundary` | `9d885048cd7f63cd8cd2d0b8cc212375327d43e1` | 已合入 main | PR #9 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093i-assistant-originated-remember-intent` | `8a5433a4d5150ceae545f617bb0e614660b2a6cb` | 已合入 main | PR #10 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093j-assistant-relationship-memory-recall` | `a787f72afb627e7a4cc574072b3849d6d93ecc64` | 已合入 main | PR #11 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093k-relationship-memory-historical-backfill-foundation` | `48bd1956549c2290f8ae1e1620e87f0dee79b27a` | 已合入 main | PR #12 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093l-relationship-memory-reinforcement-linking-foundation` | `582a4c9427e36825a82909ea75ba9312c377c308` | 已合入 main | PR #13 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093m-relationship-memory-semantic-context-foundation` | `94cb49bbc6e64e9dbeae168038f2e281b29118b9` | 已合入 main | PR #14 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093n-backfill-snapshot-authority-boundary` | `5795ea422cd69480142392187f10bcba4fc9eaa8` | 已合入 main | PR #15 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093o-relationship-memory-semantic-retrieval-foundation` | `710d72dc50668c2466f9927f7d7d4f305e3d3088` | 已合入 main | PR #16 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093p-reinforcement-evidence-idempotency` | `ed6cb0a08fc9bb492d0ea8277ccf54690d4008a1` | 已合入 main | PR #17 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093q-relationship-observer-builtin-tool-boundary` | `04319c3aa0c2a7b5b69d1ba5eab4038be7d19bdd` | 已合入 main | PR #18 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093r-letta-code-0183-sdk-init-reliability` | `75458741aaec66346a1cf4d048d7b6552ade0e25` | 已合入 main | PR #19 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093s-letta-code-autoupdater-boundary` | `a7c45c88f918f9cdc0f7abe8cf89b1cd116ecc39` | 已合入 main | PR #21 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093t-relationship-observer-external-tools-only` | `0fef933fb1e0ed45b56754599de4d7a753954dd5` | 已合入 main | PR #22 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093u-relationship-memory-transcript-event-evidence-foundation` | `fc9b07af095ed49e3cf4914d5eb3df098c1c07e0` | 已合入 main | PR #23 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093v-adopted-agent-system-prompt-reconciliation` | `992193fee42d77c840086bd2bfa79c3d1fd87816` | 已合入 main | PR #24 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093w-dedicated-backfill-agent-concurrent-writer-safety` | `f06f7c2a6168d9401bc54d9596ad5818a03c8f84` | 已合入 main | PR #25 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093x-ombre-brain-legacy-memory-backfill-foundation` | `46c1145af655e7a615fbcaae7aeb059d896f79da` | 已合入 main | PR #26 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093y-ombre-yaml-block-list-compatibility` | `09198988201694199d762cc0a5a387bb9e250d94` | 已合入 main | PR #27 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/093z-ombre-source-filename-utc-compatibility` | `f1ae8068b9b34d0debfe63911a561f1a2795f85f` | 已合入 main | PR #28 merged，PR head 与当前 branch head 精确一致 | 是 |
| `task/096a-subcon-recall-stream-pwa-visibility` | `6ca0255fc7ab7997f5434e5190d7e3c70ca93132` | 已合入 main | PR #20 merged，PR head 与当前 branch head 精确一致 | 是 |
