# Investigation 01 — current structure map

Read-only structure investigation of current `main` for later orchestration/cleanup work.

## Baseline

- Repository: `kannch8765/claude-subconscious-wip`
- Baseline branch: `main`
- Exact commit: `e83e75956b468dc43491bcb8fafff8ac70d0e854`
- Commit subject: `Align backfill affective guidance with schema (#78)`
- No `AGENTS.md` was found in the repository at this commit.
- Repository-local instructions/config observed: `README.md`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `hooks/hooks.json`, package scripts in `package.json`.
- Scope note: this report does **not** infer production configuration from repository defaults. No VPS/runtime inspection was performed.

## 1. Module map

| Module / responsibility | Main files / directories | What it does | Connected to |
|---|---|---|---|
| Claude hook/plugin surface | `hooks/hooks.json`, `hooks/silent-npx.cjs`, `scripts/session_start.ts`, `scripts/sync_letta_memory.ts`, `scripts/pretool_sync.ts`, `scripts/send_messages_to_letta.ts` | Wires `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and async `Stop`; resolves session/conversation state; injects queued whispers / optional memory-block diffs; starts async live processing | Letta agent config, native live worker, whisper queue, durable sync state |
| Async live turn | `scripts/send_messages_to_letta.ts`, `scripts/send_worker_native.ts` | Parses new Claude transcript messages, persists trusted assistant remember-intent before model dependency, builds live batch, spawns native Letta worker; native worker exposes trusted relationship tools and `deliver_whisper` | relationship-memory adapter/store/tools, Letta native client, MCP stdio tools (async mode only), whisper queue |
| Foreground sync Subcon lane | `scripts/sync_subcon.ts`, sync handling in `scripts/send_worker_native.ts`, marker consumption in `scripts/sync_letta_memory.ts`, `scripts/sync_letta_resources.ts`, `scripts/sync_client_tool_gate.ts` | Additive per-user-turn ephemeral Letta conversation; relationship-recall-only worker; returns when durable whisper/no-whisper checkpoint exists while worker completes cleanup asynchronously | native worker, whisper queue, `SUBCON_SYNC_EXPECTED_TURN_FILE`, Letta resource lifecycle |
| Explicit recall MCP/runtime | `.mcp.json`, `scripts/recall_mcp.ts`, `scripts/recall_runtime.ts`, `relationship-memory/src/recall/` | Separate explicit recall tool/runtime using Letta Code SDK; instructed to investigate canonical relationship memory + transcript evidence and deliver recall | `@letta-ai/letta-code-sdk`, relationship-memory recall core, transcript tools |
| Whisper transport / grounding | `scripts/subcon_whisper_queue.ts`, `scripts/grounded_whisper.ts`, `scripts/subcon_visibility_mirror.ts`, `scripts/retract_sync_whisper.ts` | Durable foreground whisper queue, turn partitioning, source-faithful historical quote rendering/identity anchor handling, visibility mirror | async live worker, sync worker, UserPromptSubmit/PreToolUse injection |
| Relationship-memory canonical domain | `relationship-memory/src/schema/`, `store/`, `adapter/`, `tools/`, `owner/`, `intent/`, `projection/`, `observability/` | Canonical append-only records, mutation lock, client-tool runtime, owner revisions/effective materialization, assistant remember-intent, projection/observability | live worker, observer/backfill, recall, admin |
| Retrieval / embedding / index | `relationship-memory/src/retrieval/index.ts` | Lexical + optional semantic retrieval; DashScope Qwen embedding provider; file-backed derivative vector index with lock/cooldown; sync rank-only path avoids refreshing missing document vectors | memory search tools, live recall/backfill depending on configured runtime |
| Historical backfill | `scripts/relationship_memory_backfill.ts`, `relationship-memory/src/backfill/index.ts`, `relationship-memory/src/backfill/snapshot.ts`, `scripts/relationship_observer_runner.ts`, `scripts/backfill_runtime_safety.ts`, `scripts/backfill_agent_config.ts`, `scripts/native_letta_backfill.ts` | Bounded JSONL transcript reader + checkpoint/integrity state; feeds batches to dedicated relationship observer through native Letta conversations; finalizes canonical batch | canonical store/tools, Letta native client, projection sync, runtime safety |
| Backfill variants / migration | `scripts/relationship_memory_backfill_omen.ts`, `scripts/legacy_semantic_backfill.ts`, `scripts/legacy_semantic_observer_runner.ts`, `relationship-memory/src/legacy/` | Omen-configured historical backfill variant plus older semantic/Ombre migration paths | backfill agent config, canonical memory migration/observer |
| Admin / control plane | `relationship-memory/src/admin/index.ts`, `relationship-memory/src/admin/http.ts`, `relationship-memory/src/owner/index.ts` | Read-model snapshot, effective-memory rows/summary, runtime/recent-run/cache observability, HTTP surface | owner control plane, observability, canonical store |
| Agent/runtime reconciliation | `scripts/agent_config.ts`, `scripts/backfill_agent_config.ts`, `scripts/managed_runtime_config.test.ts`, `scripts/agent_prompt_reconciliation.test.ts`, `scripts/live_agent_surface_reconciliation.test.ts` | Resolves/imports agents and reconciles model/context/tool/prompt/runtime settings for live/backfill surfaces | SessionStart/live worker/backfill |
| Packaging / automation | `.claude-plugin/`, `hooks/build.ps1`, `.github/workflows/*.yml` | Claude plugin metadata / Windows silent launcher build / GitHub workflows | plugin install and CI/automation |
| Tests | `scripts/*.test.ts`, `relationship-memory/tests/*.test.ts`, `npm test` | Unit/regression coverage for live, sync, agent config, MCP lifecycle, backfill, store concurrency, retrieval/index, admin, migration, sanitizer, observability | mostly filesystem/temp/mock surfaces; canary docs cover real runtime validation |

### Package scripts observed

`npm test` / `test:watch`; `sync`; `send`; `backfill`; `legacy-backfill`; transcript sanitizer/batch sanitizer; historical DarioTouch stripe single/batch.

There is **no package script for `sync_subcon.ts` or `relationship_memory_backfill_omen.ts`** at this commit.

### Deployment surface found in this repository

There is no general production deploy/systemd script in the current tree. Repository-local operational packaging is mainly `.claude-plugin/*`, `hooks/*`, and GitHub workflows. If production deploy scripts exist elsewhere, this repository alone cannot map them.

## 2. Main runtime paths

### A. Live message → whisper

#### Default repository hook path: async Stop lane

1. Claude plugin hook wiring: `hooks/hooks.json`
   - `SessionStart` → `scripts/session_start.ts` + `scripts/sync_letta_memory.ts`
   - `UserPromptSubmit` → `scripts/sync_letta_memory.ts`
   - `PreToolUse` → `scripts/pretool_sync.ts`
   - `Stop` → async `scripts/send_messages_to_letta.ts`
2. `send_messages_to_letta.ts`
   - reads Claude transcript JSONL;
   - loads durable sync state;
   - extracts and persists trusted assistant-originated remember intent **before** Letta/model dependency;
   - formats only newly unprocessed messages;
   - resolves Letta agent/conversation;
   - constructs the live `<claude_code_session_update>` including `<latest_user_message>` and the current trusted batch;
   - writes a payload file and starts `send_worker_native.ts` through `spawnSilentWorker()`.
3. `send_worker_native.ts::sendViaNativeClient()`
   - live transport is native `@letta-ai/letta-client` conversations;
   - async mode exposes relationship tools including `memory_search`, mutation tools, entity tools, and `deliver_whisper`; configured stdio MCP tools may also be appended after name-collision filtering;
   - a real user message requires at least one `memory_search` client-tool call (`requiredClientToolNames`);
   - `deliver_whisper` may run at most once and may select only one memory ID plus 1–3 snippet IDs previously returned by memory search;
   - selected evidence is rendered by `grounded_whisper.ts` and persisted through `queueSubconWhisper()`.
4. Foreground delivery
   - `scripts/sync_letta_memory.ts` (UserPromptSubmit) consumes queued entries; in default `LETTA_MODE=whisper` it is deliberately local and does not contact Letta on the foreground hot path.
   - `scripts/pretool_sync.ts` can surface ordinary async/legacy queued whispers mid-turn. Sync-turn-scoped entries are intentionally excluded there.
5. Canonical relationship-memory mutation
   - relationship mutation tools execute against the runtime/store under `RelationshipMemoryStore.withMutationBoundary()`.
   - canonical append targets include `memories.jsonl`, `evidence.jsonl`, `reinforcements.jsonl`, `entities.jsonl`, `entity-evidence.jsonl`, `owner-revisions.jsonl`, `assistant-intents.jsonl`, outcome files, and `batches.jsonl` as applicable.
   - canonical locking is under `<root>/.canonical-mutation.lock`.

#### Repository default / optional status

- `LETTA_MODE` defaults to `whisper` in `conversation_utils.ts::getMode()`. `full` additionally fetches/injects Letta memory-block diffs; `off` disables hook behavior.
- Semantic retrieval is **optional**, not repository-default: `createSemanticRetrieverFromEnvironment()` returns `undefined` unless `RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER` is set. When enabled, only `dashscope-qwen` is accepted and a key file is required.
- `sync_subcon.ts` is an **implemented additive foreground lane**, but `hooks/hooks.json` and `package.json` do not directly invoke it. `sync_letta_memory.ts` only consumes the `SUBCON_SYNC_EXPECTED_TURN_FILE` marker and matching queued whisper. Therefore repository code proves the implementation/consumer boundary, but **does not prove production enablement or identify the external caller**.

### B. Historical transcript → canonical relationship memory

#### Current package `backfill` path

1. CLI entry: `scripts/relationship_memory_backfill.ts` (`npm run backfill`)
   - requires exactly one of `--snapshot-manifest` / `--transcript`, plus `--state`;
   - runs `assertPrivilegedSnapshotRuntimeSafety()` before Letta work;
   - resolves immutable/snapshot transcript input;
   - requires `LETTA_API_KEY` and resolves a dedicated backfill agent;
   - binds checkpoint state to the agent/conversation, rotating conversation when a retryable batch requires it.
2. `relationship-memory/src/backfill/index.ts::runHistoricalBackfill()`
   - discovers transcript sources;
   - maintains atomic checkpoint + file identity/integrity state;
   - reads bounded record/byte batches;
   - converts processable transcript messages to trusted canonical evidence;
   - builds a deterministic `HistoricalBatch` and observer envelope;
   - advances checkpoint only after processor completion; malformed/oversized/retryable/runtime failures are fail-closed in state.
3. `scripts/relationship_observer_runner.ts::runRelationshipObserverBatch()`
   - creates relationship runtime over the canonical batch;
   - `beginBatch()` records pending batch state;
   - enforces an observer-agent server-tool boundary;
   - runs the observer through native Letta conversations with relationship client tools;
   - wraps canonical mutation tools in the store mutation boundary;
   - finalizes the batch durably and then attempts projection-block synchronization.
4. Canonical writes land in `relationship-memory/src/store/index.ts::RelationshipMemoryStore` append-only JSONL files under the configured relationship-memory root. Semantic index is a **derivative** file-backed index (`relationship-memory/src/retrieval/index.ts`), not the canonical store.

#### Backfill variants / status visible from repository

- `npm run backfill` → `relationship_memory_backfill.ts`: clearly the package-default historical relationship-memory backfill entry.
- `npm run legacy-backfill` → `legacy_semantic_backfill.ts`: explicitly retained legacy semantic migration path.
- `relationship_memory_backfill_omen.ts`: implemented near-parallel entry that calls `configureVerifiedOmenBackfillRuntime()` before the same observer/backfill core, but it has no package script here. Repository alone does not prove whether this is experimental, externally invoked, or intended to supersede the default entry.

## 3. Candidate follow-up investigations

### Candidate 1 — Foreground sync lane wiring and ownership **(recommended first)**

**Observed evidence**
- `scripts/sync_subcon.ts` describes itself as an additive lane and creates an ephemeral Letta conversation for the current foreground turn.
- `send_worker_native.ts` has explicit `mode: 'async' | 'sync'` branches, different tool inventory, checkpoint behavior, and resource cleanup.
- `sync_letta_memory.ts::expectedSyncTurnId()` consumes `SUBCON_SYNC_EXPECTED_TURN_FILE` and turn-scoped queue entries.
- Neither `hooks/hooks.json` nor `package.json` invokes `sync_subcon.ts` directly.

**Why worth checking**
- This is a real parallel live path with separate conversation/resource lifecycle and foreground delivery semantics. If its caller/gates drift, effects include duplicate recall, stale turn-scoped whispers, timeout/cancellation leaks, or a lane that is implemented but not actually reachable.

**Confirmed vs unknown**
- Confirmed: implementation exists; native worker has separate sync behavior; repository hook consumer exists.
- Unknown: who launches it in the deployed system; exact enable/gate condition; whether one or multiple external callers exist; whether async+sync are deliberately both active for the same turn in production.

**Small next investigation**
- Repository-only call-site/history trace for `sync_subcon.ts`, `SUBCON_SYNC_EXPECTED_TURN_FILE`, sync checkpoint filenames, and any PWA/runtime integration commit. Produce a one-page ownership diagram and enumerate every enable/disable gate without changing code.

### Candidate 2 — Current vs variant backfill entrypoints

**Observed evidence**
- `package.json` exposes `backfill` and `legacy-backfill`.
- `scripts/relationship_memory_backfill.ts` and `scripts/relationship_memory_backfill_omen.ts` are highly similar entrypoints over the same `runHistoricalBackfill()` + `runRelationshipObserverBatch()` core; Omen additionally calls `configureVerifiedOmenBackfillRuntime()`.
- `scripts/legacy_semantic_backfill.ts` / `legacy_semantic_observer_runner.ts` remain present.

**Why worth checking**
- Parallel operational entrypoints tend to duplicate safety/config/checkpoint assumptions. Drift could affect model selection, retry behavior, runtime reconciliation, or which lane an operator accidentally uses.

**Confirmed vs unknown**
- Confirmed: three distinct backfill-era paths exist; package default is the non-Omen relationship backfill; legacy has an explicit script.
- Unknown: intended lifecycle of Omen variant; whether external runbooks invoke it; whether duplicated CLI/runtime-safety code has already diverged semantically.

**Small next investigation**
- Diff only the two current relationship backfill entrypoints plus `backfill_agent_config.ts`; classify identical code, intentional model-specific delta, and accidental drift. Do not run backfill.

### Candidate 3 — Live native client vs explicit Letta Code SDK recall boundary

**Observed evidence**
- README and `send_worker_native.ts` state live transcript processing uses `@letta-ai/letta-client`.
- `.mcp.json` exposes `relationship-memory-recall` → `scripts/recall_mcp.ts` → `scripts/recall_runtime.ts`, and that runtime imports the Letta Code SDK path.
- `package.json` therefore retains both `@letta-ai/letta-client` and `@letta-ai/letta-code-sdk`.

**Why worth checking**
- Two Letta transports are legitimate if responsibilities stay separated, but config, timeout, tool lifecycle, and evidence semantics can quietly diverge. Dependency cleanup must not treat the SDK as dead merely because live no longer uses it.

**Confirmed vs unknown**
- Confirmed: live native transport and explicit SDK recall are separate implementations; SDK is still referenced.
- Unknown: current real caller/use frequency of explicit recall MCP; whether its retrieval semantics still match canonical live behavior; whether any old SDK live assumptions remain elsewhere.

**Small next investigation**
- Trace only `.mcp.json` recall registration → `recall_mcp.ts` → `recall_runtime.ts` → `relationship-memory/src/recall/`; compare tool/evidence/config boundaries with live `memory_search` without evaluating model quality.

### Candidate 4 — Agent/runtime reconciliation responsibility concentration

**Observed evidence**
- `scripts/agent_config.ts` is ~40 KB and is paired with `agent_prompt_reconciliation.test.ts`, `live_agent_surface_reconciliation.test.ts`, `managed_runtime_config.test.ts`.
- Backfill has a separate `backfill_agent_config.ts` and runtime verification path.
- Session start, live, sync resources, backfill, model/context/tool reconciliation all meet around these configuration helpers.

**Why worth checking**
- This is a high-change boundary after repeated model/context/tool fixes. Large config files can accumulate overlapping repair gates that are individually necessary but hard to reason about together.

**Confirmed vs unknown**
- Confirmed: reconciliation is heavily centralized for live while backfill has a sibling config module; dedicated regression tests exist.
- Unknown: whether checks are duplicated, order-dependent, or stale; whether all reconciliation branches remain reachable after the latest native-client architecture.

**Small next investigation**
- Make a decision table from `agent_config.ts` + `backfill_agent_config.ts`: input env/server state → PATCH/import/no-op actions → postconditions. Flag only overlapping or contradictory predicates.

### Candidate 5 — Documentation / CI residue and architecture drift

**Observed evidence**
- README “Live Subconscious Tools and Transport” correctly says native `@letta-ai/letta-client`, but a later Stop subsection still describes nonexistent `send_worker_sdk.ts`, Letta Code SDK live processing, and Read/Grep/Glob access.
- `.github/workflows/` contains `task-093aa/ag/ah/an/ao/ap-tests.yml` alongside `letta.yml` rather than one obvious consolidated CI workflow.

**Why worth checking**
- Stale architecture docs increase operator/debug risk; task-specific workflows may encode valuable regression gates or may be historical residue. Names alone are not enough to delete anything.

**Confirmed vs unknown**
- Confirmed: README contains mutually inconsistent live-worker descriptions; task-scoped workflows exist.
- Unknown: which workflow gates are still required/protected; whether task-specific CI overlaps exactly or covers distinct safety boundaries.

**Small next investigation**
- Read the six task workflows and map each command/test file to current `npm test` coverage; separately patch-plan README factual drift. No deletions until branch-protection/status-check usage is known.

## 4. Validation entrypoints for future changes

### Main local/offline entry

- `npm test` → `vitest run`
- `npm run test:watch` → `vitest`

The repository has broad Vitest coverage under two main groups.

**`scripts/*.test.ts`**
- agent/runtime config and prompt reconciliation;
- live agent surface / role split / entity grounding / async memory surfacing;
- native Letta backfill wrapper behavior;
- sync mode and worker lifecycle;
- stdio MCP client lifecycle;
- recall MCP entrypoint;
- whisper queue / grounded whisper / visibility mirror / voice contract;
- backfill runtime safety;
- conversation/transcript utilities and Letta URL/runtime-env contracts.

**`relationship-memory/tests/*.test.ts`**
- canonical store/domain behavior;
- concurrent writer safety;
- owner control plane + admin read model/HTTP;
- recall;
- semantic retrieval/context;
- historical backfill + snapshot;
- legacy Ombre/semantic migration;
- assistant-originated intent;
- transcript sanitizer/stripe utilities;
- observability and provider-usage accounting.

From the test structure/naming and the explicit injectable clients/providers in implementation code, these are intended primarily as local regression tests with temp files/fakes/mocks rather than paid end-to-end jobs. A future narrow change should run its directly related Vitest files first, then `npm test` if appropriate.

### Tests / validations that require external services or credentials

Repository docs under `docs/*CANARY*.md` and runtime evidence documents describe real canary/production-style validation. Those are not equivalent to offline Vitest and may require some combination of:

- reachable Letta service + `LETTA_API_KEY`;
- configured live/backfill agent;
- real transcript/snapshot inputs;
- relationship-memory root permissions;
- DashScope embedding credentials when semantic retrieval/index build is enabled;
- provider/model quota for live/backfill canaries.

The implementation paths `scripts/send_messages_to_letta.ts`, `scripts/sync_subcon.ts`, `scripts/relationship_memory_backfill.ts`, and real semantic index population can call external services; they should **not** be used as casual structural-validation commands.

### Semantic retrieval validation nuance

- With no `RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER`, semantic retriever creation is disabled and lexical behavior remains available.
- When enabled, the derivative index lives under `RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR` or `<root>-semantic-index` and can call DashScope Qwen embeddings.
- The retrieval implementation explicitly has a rank-only path where missing/mismatched document vectors become lexical-fallback signals rather than permission to rebuild vectors on foreground sync recall. Tests around semantic retrieval/index should preserve that distinction.

## Recommendation

**Investigate Candidate 1 (foreground sync lane wiring/ownership) first.**

Reason: it is the highest-leverage structural uncertainty found without needing production access. The repository clearly contains two live execution modes in the same native worker, separate sync resource lifecycle/checkpoints, and a foreground consumer for turn-scoped sync whispers — yet the repository’s own hooks/package scripts do not reveal who launches `sync_subcon.ts`. Before simplifying gates or merging paths elsewhere, the orchestrator needs to know whether this lane is externally wired, what exact condition enables it, and how it intentionally coexists with the normal Stop/async observer. That answer determines whether several nearby duplicate-looking gates are redundant or actually enforce a cross-repo failure boundary.

Evidence gap to preserve: **production enablement/caller cannot be proven from this repository alone**. The next task can stay repository-only by tracing historical call sites / companion runtime integration first; VPS inspection is not required for the first pass.
