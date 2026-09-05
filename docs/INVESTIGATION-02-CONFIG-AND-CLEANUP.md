# Investigation 02 — editable configuration and first cleanup boundary

Read-only investigation against the fixed source baseline requested by `INVESTIGATION.md`. No runtime source, dependency, test, production setting, Letta object, model, embedding, checkpoint, or backfill execution was modified.

## Baseline and repository instructions

- Repository: `kannch8765/claude-subconscious-wip`
- Investigation/report branch: `investigation/02-config-and-cleanup`
- Branch head before this report: `0e46fa2beacd299ed353ffdde3ea8d391cf79ee6` (`docs: dispatch configuration and cleanup investigation`)
- Fixed source baseline: `e83e75956b468dc43491bcb8fafff8ac70d0e854`
- First structure report used as a starting map: `docs/INVESTIGATION-01-CURRENT-STRUCTURE-MAP.md` at commit `e11eb1392236a23b0c04947ca00f9b8a7964f7e6`
- No `AGENTS.md` exists at the source baseline. Repository-local instructions/config remain the files identified by Investigation 01 (`README.md`, `.claude-plugin/*`, `.mcp.json`, `hooks/hooks.json`, `package.json`).
- This report does not infer production environment values. No VPS or real Letta/model/embedding service was accessed.

## Executive answer

### 1. Does prompt/model adjustment really require editing source?

**Partly, but less than it appears.**

- The large managed **live prompt is already data**, stored as `agents[0].system` in `Subconscious.af`, not as a TypeScript string. The large **backfill observer prompt is likewise in `SubconsciousBackfill.af`**.
- The repository-default live and ordinary-backfill model/provider/embedding/context/parallel settings are also already serialized in those AgentFiles.
- Live managed agents already support explicit operator overrides for **model** (`LETTA_MODEL`) and **context** (`LETTA_CONTEXT_WINDOW`). Agent identity also has env/saved-config resolution. Therefore changing the live model does **not** inherently require source editing.
- However, the AgentFile format is an exported JSON bundle containing much more than human-edited policy, so editing a multi-kilobyte escaped `system` field is awkward. Some genuinely adjustable policy is still embedded in TypeScript: notably the sync foreground instruction in `sync_subcon.ts::syncMessage()`.
- Omen backfill runtime identity is genuinely source-hardcoded today in `backfill_agent_config.ts::OMEN_BACKFILL_VERIFIED_RUNTIME`.
- The experimental sync sibling currently reads the canonical live AgentFile values directly and does **not** apply `LETTA_MODEL` / `LETTA_CONTEXT_WINDOW`; therefore a live operator override can diverge from sync even though sync starts from the same canonical AgentFile.

So the problem is not “there is no configuration system”. It is that **configuration authority is split between AgentFiles, env, saved identity JSON, TypeScript prompt fragments, and verified runtime constants**, with inconsistent override behavior between lanes.

### 2. Recommended minimum configuration direction

Use a **thin runtime-loaded, repository-shipped configuration layer**, not a build-time template framework and not a replacement for the existing reconciliation code.

Recommended shape:

- human-editable Markdown files for the two large authored system prompts;
- one small typed JSON file (or equivalently a very small TS-free JSON document) for non-secret runtime profiles such as model/provider/embedding/context;
- keep code-owned invariants in TypeScript: tool inventory/permissions, required tags, schema contracts, ownership decisions, mutation locks, checkpoint rules, runtime verification, and fail-closed safety boundaries;
- keep AgentFiles as bootstrap/import artifacts until a deliberate migration proves they can be reduced or generated safely. In the first implementation, the loader can treat the external prompt/runtime files as managed reconciliation authority while the AgentFile continues to carry blocks/tool surface/import material.

This gives the user the desired “edit MD/JSON, then reconcile” workflow without adding a compiler, a broad templating engine, or a second deployment product.

### 3. Best first implementation slice; what to defer

**Best first slice:** separate **authored prompt/runtime-profile authority** from `Subconscious.af` / `SubconsciousBackfill.af` inside the existing `agent_config.ts` reconciliation seam, with strict parsing and fingerprint logging. Start with the two large system prompts plus live/backfill default runtime profiles. Preserve all existing post-PATCH verification.

**Immediately adjacent cleanup worth doing with or just after that slice:** collapse the two historical backfill entry files into one shared runner with an explicit runtime profile selection. Their baseline diff is only the Omen import plus one verified-runtime call. Keep Omen verification as a mandatory profile behavior rather than deleting it.

**Defer:** explicit recall repair; generalized gate removal; a shared base-prompt templating framework; mutation/index/checkpoint safety simplification; changing sync tool inventory. Sync is experimental and its different tool set is intentional.

---

## 1. Configuration map: authored value → effective runtime

### Compact map

| Lane | Prompt authority at baseline | Runtime settings authority / overrides | Reader and remote effect | Existing object vs new object | Important drift/unknown |
|---|---|---|---|---|---|
| Live async | `Subconscious.af` → `agents[0].system`; live memory/tool surface also read from same AgentFile | AgentFile defaults: `openai-proxy/mimo-v2.5`, local FastEmbed handle, `400000`, provider `openai`, parallel=true. Explicit `LETTA_MODEL` and `LETTA_CONTEXT_WINDOW` override managed model/context. Agent ID: `LETTA_AGENT_ID` → saved `~/.letta/claude-subconscious/config.json` → import | `session_start.ts` and `send_messages_to_letta.ts` call `getAgentId()`. Managed agents run `reconcileManagedAgentConfiguration()` and `reconcileManagedLiveAgentSurface()` before use | New managed object: import `Subconscious.af`, then reconcile. Saved/imported managed object: next `getAgentId()` reconciles. Origin-tagged env agent: reconciles. Ordinary external env agent: explicitly not mutated | Repository defaults do not prove production env overrides. Availability fallback is intentionally disabled after managed reconciliation. |
| Experimental sync | Same live `Subconscious.af` system via `getCanonicalManagedAgentConfig()` **plus** a TypeScript-authored per-turn policy wrapper from `sync_subcon.ts::syncMessage()` | `createToolStrippedSyncAgent()` uses canonical AgentFile model/embedding/context/provider/parallel directly. It copies current live managed block values but creates a tool-stripped sibling | Each sync invocation reads configured live agent ID read-only, snapshots live blocks, creates a hidden ephemeral sibling + conversation, then native worker executes sync relationship-recall-only tools | New ephemeral sibling every sync key/turn; no persistent sync agent is the source of truth. Cleanup/deferred cleanup is part of lifecycle | **Live `LETTA_MODEL` / `LETTA_CONTEXT_WINDOW` overrides are not applied here.** This may be intentional or accidental; repo has no lane-specific model config explaining it. Different tools are intentional and must not be “normalized”. |
| Ordinary relationship backfill | `SubconsciousBackfill.af` → `agents[0].system` | AgentFile defaults: `opencode-deepseek/deepseek-v4-flash`, local FastEmbed, `400000`, provider `deepseek`, parallel=true. `reconcileManagedAgentConfiguration()` still reads global `LETTA_MODEL`/`LETTA_CONTEXT_WINDOW`. Dedicated agent ID: CLI `--agent-id` → `LETTA_BACKFILL_AGENT_ID` → saved backfill config → import | `relationship_memory_backfill.ts` calls `getBackfillAgentId()`; that adds purpose tag and reconciles full canonical backfill runtime/prompt unless disabled by option | New: import `SubconsciousBackfill.af`, save dedicated ID, then reconcile. Existing: reconcile on each resolve | Global `LETTA_MODEL` can affect backfill because generic reconciler honors it. Whether production sets it is unknown. Saved `backfill-config.json` is identity state, not authored runtime config. |
| Omen relationship backfill | Same `SubconsciousBackfill.af` prompt | `getBackfillAgentId()` first reconciles canonical backfill runtime; then `configureVerifiedOmenBackfillRuntime()` force-PATCHes `openai-proxy/omen-alpha`, provider `openai`, local FastEmbed, `400000`, parallel=true and polls/validates effective state | `relationship_memory_backfill_omen.ts` is otherwise identical to ordinary backfill, with the one extra verified-runtime step | Reuses/resolves the same dedicated-agent mechanism; Omen profile is applied immediately before checkpoint binding/conversation execution | Omen invocation can perform **two runtime convergence steps**: canonical DeepSeek first, Omen second. This is maintenance noise and extra remote mutation, not a protection to delete. Profile identity is source-hardcoded. |
| Explicit recall | Investigation 01 maps it to `recall_mcp.ts` / `recall_runtime.ts` and Letta Code SDK | Uses configured existing agent boundary rather than the live native worker path | Separate MCP/runtime | Separate concern | User reports it currently unusable. This investigation does not diagnose it. Only note: do not delete it based on this status. |

### Live async details

`agent_config.ts` already has a meaningful authority model:

1. `getCanonicalManagedAgentConfig()` parses the bundled AgentFile and requires exactly one agent plus non-empty system/model/embedding/context/provider and `parallel_tool_calls === true`.
2. `getAgentId()` resolves identity from env, saved config, or import.
3. Saved/imported agents are considered managed. An env-selected agent is only reconciled when the origin tag proves it is managed; an ordinary external env agent receives zero managed PATCHes.
4. `reconcileManagedAgentConfiguration()` computes desired values from canonical AgentFile plus explicit model/context env overrides.
5. It PATCHes only drifted fields, with the important Letta 0.16.8 rule that model/context changes carry `model_settings.parallel_tool_calls=true` in the same request.
6. When model settings are patched, it re-GETs and verifies both `model_settings.parallel_tool_calls` and effective `llm_config.parallel_tool_calls`.
7. `reconcileManagedLiveAgentSurface()` separately converges canonical managed blocks/tools.
8. Model availability discovery is diagnostic for managed agents and is intentionally prevented from silently auto-selecting another model after reconciliation.

This is already a strong place to insert a nicer authored config source. Replacing this machinery would throw away protections the repository acquired through prior failures.

### When a live edit takes effect

For a managed live agent, changing canonical authored values does not require recreating the agent. `session_start.ts` and async `send_messages_to_letta.ts` both call `getAgentId()`, so the next such managed resolution can PATCH an existing agent into convergence. A new install/import uses the AgentFile at import time and then follows reconciliation.

A restart is not intrinsically required by the reconciliation code for the AgentFile itself because it performs synchronous file reads during resolution. The surrounding Claude hook/plugin process model may determine when a newly shipped file version becomes visible, but the source does not require rebuilding a Letta agent solely for prompt/model drift.

### Sync details

`sync_subcon.ts::syncMessage()` contains a sizeable behavior prompt in a template literal: semantic-query guidance, mandatory search, limited parallel search, whisper behavior, and the explicit rule that sync does not own canonical mutation. This content is highly adjustable policy but is not part of the AgentFile system prompt.

`sync_letta_resources.ts::createToolStrippedSyncAgent()` deliberately creates a sibling with:

- `system: canonical.system`;
- current live values for the canonical memory blocks where present;
- no server tools/tool rules/base tools;
- canonical model/embedding/context/provider/parallel from `Subconscious.af`;
- hidden + sleeptime disabled.

That makes the sync **tool difference clearly structural and intentional**, while its model inheritance policy is less clear. If the live managed agent is running under `LETTA_MODEL`, sync still uses the AgentFile model. A future config layer should make this explicit rather than accidentally “fixing” it: either `sync` inherits the effective live runtime, or it has its own named low-latency profile.

### Backfill details

`backfill_agent_config.ts` already separates dedicated-agent identity from the live agent and enforces the purpose tag. It also guards against using the live agent ID as the dedicated backfill ID.

`SubconsciousBackfill.af` is the canonical ordinary observer prompt/runtime. `getBackfillAgentId()` calls `reconcileDedicatedAgent()`, which currently performs both prompt and full runtime reconciliation through the generic managed-agent reconciler.

The option name `reconcileCanonicalPrompt` is therefore misleading: when true it reconciles much more than the prompt; when false it suppresses the full generic reconciliation. Existing tests demonstrate the option is used for a canary-owned prompt path, so it should not simply be removed, but the boundary should be renamed/split if touched.

Omen then calls a second, profile-specific runtime operation that always PATCHes and verifies the Omen state. The historical path commit message explicitly says to retain “Omen-specific runtime profile” and “verified runtime binding before execution”; that verification is a protection, not cleanup debris.

---

## 2. What should be editable data vs code-owned invariant

### Good candidates for editable repository data

1. **Large system prompt prose**
   - live `Subconscious.af` system text;
   - backfill `SubconsciousBackfill.af` system text.
2. **Lane-specific authored policy prose** where it is not structural protocol
   - sync search/recall guidance from `syncMessage()` is a good later candidate, while the XML envelope construction and escaped dynamic values should remain code.
3. **Non-secret runtime profile values**
   - model handle;
   - provider discriminator;
   - embedding handle;
   - context window;
   - possibly a named profile such as `live`, `backfill`, `omen-backfill`, and eventually an explicit `sync` profile if desired.

### Keep code-owned

- required purpose/origin tags and managed-agent ownership checks;
- Agent ID syntax and dedicated-live separation;
- tool inventory, tool stripping, trusted client-tool exposure and collision behavior;
- memory/schema/tool argument contracts;
- XML escaping and bounded dynamic interpolation;
- `parallel_tool_calls` effective verification and provider/model metadata validation;
- Omen verified-runtime post-PATCH check;
- canonical mutation lock;
- checkpoint/agent binding and retry conversation rotation;
- privileged snapshot path/root/UID/effective writer preflight;
- semantic-index ownership safety;
- embedding provider/key/cooldown/lock protections;
- sync cleanup/deferred-cleanup lifecycle.

Those are executable behavior/safety boundaries, not operator preferences.

---

## 3. Minimum editable-config designs considered

### Option A — Keep editing AgentFiles + env only

**Pros:** zero new loader; reconciliation already works; packaging already includes the files.

**Cons:** poor authoring ergonomics for prompts; AgentFiles mix authored policy with exported Letta structure/IDs/messages/blocks/tools; Omen and sync policy remain source-hardcoded; authority remains hard to explain. It does not fully solve the user’s maintenance problem.

**Verdict:** viable short-term fallback, not the best cleanup target.

### Option B — Runtime-loaded Markdown + small typed JSON (**recommended**)

Example only, not a proposed final schema:

```text
config/
  live-system.md
  backfill-system.md
  runtime.json
```

```json
{
  "version": 1,
  "profiles": {
    "live": {
      "model": "openai-proxy/mimo-v2.5",
      "providerType": "openai",
      "embedding": "local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768",
      "contextWindow": 400000
    },
    "backfill": {
      "model": "opencode-deepseek/deepseek-v4-flash",
      "providerType": "deepseek",
      "embedding": "local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768",
      "contextWindow": 400000
    },
    "omen-backfill": {
      "model": "openai-proxy/omen-alpha",
      "providerType": "openai",
      "embedding": "local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768",
      "contextWindow": 400000
    }
  }
}
```

`parallel_tool_calls=true` should probably remain a code-enforced invariant at first rather than becoming a casual toggle because current recovery code specifically protects it from Letta configuration rebuilds.

**Pros:** easy to edit/review/diff; no build step; existing reconciliation can consume it; cleanly names Omen as a profile; suitable for deterministic fingerprinting.

**Cons:** introduces packaging/path/schema validation work; AgentFile import must be kept consistent until bootstrap responsibilities are deliberately separated.

**Verdict:** best fit if implemented narrowly.

### Option C — Build-time generation/embedding

Generate AgentFiles or TypeScript constants from MD/JSON during packaging.

**Pros:** one compiled artifact can remain internally self-contained; generated AgentFile may solve import consistency.

**Cons:** edits do not become effective until build/package; adds a compiler/generator and generated-file drift; harder local debugging; unnecessary for a small plugin whose existing code already reads files at runtime.

**Verdict:** defer. A generator may become useful later specifically to rebuild `.af` import artifacts, but should not be the first configuration architecture.

---

## 4. Loader/schema behavior needed for the recommended design

A new authored config layer should be deliberately stricter than the current identity-state JSON helpers.

### Schema and failure policy

- `version` required and exact-known.
- Required profiles have required non-empty model/provider/embedding and positive integer context.
- Unknown top-level/profile fields should fail (or at minimum fail tests and emit an explicit error); silent typo acceptance would make runtime authority ambiguous.
- Missing file, malformed JSON, missing prompt, empty prompt, invalid context, or unknown profile must **fail closed before any remote PATCH/import**.
- Never fall back silently from an invalid requested model to another model. The current managed-agent behavior already wisely disables availability auto-selection after canonical reconciliation; preserve that property.
- Do not put API keys or credential contents in this file. Existing env/key-file/provider credential channels remain authoritative.

### Override order

A simple explicit order is preferable:

1. lane-specific explicit CLI override where one already exists (agent identity, backfill input controls);
2. explicit operator env override where supported (`LETTA_MODEL`, `LETTA_CONTEXT_WINDOW`) — or replace these later only through a separate migration;
3. named repository runtime profile;
4. no heuristic model fallback for a managed lane.

Because Omen is intended to be a verified named runtime, it should not accidentally inherit a global live model override. The implementation task should decide whether global `LETTA_MODEL` remains applicable to ordinary backfill; the current code does apply it through the generic reconciler. This report does not assume production relies on that behavior.

### Prompt rendering

Do not introduce a general string-substitution engine for the large system prompts unless a real dynamic requirement appears. The current `Subconscious.af` and `SubconsciousBackfill.af` system strings are static. Loading raw UTF-8 Markdown and trimming only a defined terminal newline policy is safer than interpolation.

Dynamic sync data is different: `syncMessage()` must continue to escape XML (`escapeXmlContent`) and bound context before insertion. If its policy prose moves to a file later, keep a code-owned envelope such as:

```text
<subcon_sync_foreground_turn>
  [escaped dynamic fields]
  [verbatim authored policy fragment]
</subcon_sync_foreground_turn>
```

The loader must not feed unescaped user/context text through prompt-file substitution.

### Paths / packaging

Current canonical AgentFiles are located relative to the module via `fileURLToPath(import.meta.url)` + `path.join(__dirname, '..', ...)`, which is robust against arbitrary cwd. New repository-shipped config should use the same module-relative strategy, not `process.cwd()`.

The plugin metadata has no explicit file allow-list at this baseline, so repository-root/config files appear compatible with the current packaging shape; actual release/install packaging still needs a packaged-artifact test before relying on that inference.

### Provenance and rollback

On resolution/reconciliation, log non-sensitive provenance such as:

```text
managed_config version=1 profile=live prompt_sha256=<12+ hex> runtime_sha256=<12+ hex>
```

Do not log secrets or entire prompt contents. A stored/reported fingerprint lets operators identify exactly what was intended without inspecting remote values manually.

Rollback then becomes ordinary repository rollback: restore the prior MD/JSON and let the next managed reconciliation converge the existing agent. Keep the existing no-op second reconcile property so rollback does not produce perpetual PATCHes.

---

## 5. First nearby cleanup candidates

### Candidate A — unify the two current relationship-memory backfill entrypoints

Evidence at baseline: `relationship_memory_backfill.ts` and `relationship_memory_backfill_omen.ts` differ only by:

1. importing `configureVerifiedOmenBackfillRuntime`;
2. calling it immediately after `getBackfillAgentId()`.

Everything else — CLI parsing, privileged runtime preflight, transcript/snapshot resolution, checkpoint binding, retry conversation rotation, observer processor, canonical root, batching, failure exit — is duplicated byte-for-byte.

**Classification:** duplicate flow with a necessary model-specific difference.

**Keep:** all shared safety/checkpoint logic; a mandatory Omen verified runtime gate.

**Cleanup:** one shared runner taking a code-validated/named runtime profile or optional pre-run runtime binder. Package/script naming can remain separate wrappers if operational compatibility requires it.

**Validation:** CLI parsing parity; privileged preflight occurs before API use in both profiles; state agent mismatch behavior; fresh-conversation retry; processor arguments; ordinary profile makes no Omen PATCH; Omen profile verifies before conversation/batch execution.

### Candidate B — split backfill prompt reconciliation from runtime-profile reconciliation

Today `reconcileDedicatedAgent(reconcileCanonicalPrompt=true)` calls `reconcileManagedAgentConfiguration(...SubconsciousBackfill.af)`, which reconciles **system + model + embedding + context + model settings**, not just the prompt. Then the Omen entry applies a different verified runtime.

Therefore Omen can converge:

```text
existing state → canonical DeepSeek backfill runtime → verified Omen runtime
```

on one invocation.

The option `reconcileCanonicalPrompt` also understates its effect.

**Classification:** confusing boundary / redundant remote mutation; not a reason to remove runtime verification.

**Keep:** purpose tag, exact system prompt verification when desired, canonical ordinary backfill runtime, Omen verified runtime post-check.

**Cleanup:** separate `reconcileBackfillPromptAndIdentity()` from selected runtime-profile convergence, or let one resolver accept the desired runtime profile and perform one atomic convergence.

**Validation:** Omen reaches verified profile without an intermediate canonical-model PATCH; ordinary backfill remains canonical; second same-profile reconcile is zero runtime PATCH; switching profiles is explicit and verified; canary path that owns its prompt keeps its existing opt-out semantics.

### Candidate C — make sync model authority explicit, not implicitly canonical

The sync lane intentionally has a different tool surface, but there is no equally explicit policy explaining why it ignores live `LETTA_MODEL`/context overrides. It copies live block values while taking model/context from canonical AgentFile.

**Classification:** unknown / likely configuration drift. Do **not** change behavior solely from static inspection.

**Keep:** tool-stripped relationship-recall-only design and cleanup boundaries.

**Next decision:** choose one documented behavior:

- `sync` inherits the effective managed live runtime; or
- `sync` selects a separate named fast profile.

A config migration should encode that decision rather than quietly inheriting whichever value is easiest to access.

---

## 6. Gate classification for the code read in this investigation

| Gate / behavior | Classification | Recommendation |
|---|---|---|
| Managed origin-tag ownership check before mutating env-selected live agent | Necessary protection | Keep code-owned |
| Required live/backfill tags + dedicated backfill purpose tag | Necessary protection/identity | Keep |
| Live vs dedicated backfill agent inequality | Necessary protection | Keep |
| Canonical system/runtime reconciliation for managed agents | Necessary authority boundary | Keep, change input source only |
| Effective `parallel_tool_calls` re-verification after model/context rebuild | Necessary Letta 0.16.8 protection | Keep |
| Managed model availability fallback disabled | Necessary cost/config safety | Keep |
| Omen post-PATCH verified runtime polling | Necessary model-specific safety | Keep; integrate into profile convergence |
| `reconcileCanonicalPrompt` option | Historical/canary compatibility, misleadingly named | Preserve semantics until call sites are migrated; split/rename boundary |
| Sync server-tool stripping / async-only stdio MCP tools | Intentional experimental lane behavior | Keep; not cleanup target |
| Privileged snapshot subject/root/index/agent/checkpoint preflight | Necessary protection | Keep |
| Canonical store writer effective-access checks | Necessary protection | Keep |
| Shared semantic-index ownership check | Necessary protection | Keep |
| Backfill checkpoint agent binding + retry conversation rotation | Necessary correctness protection | Keep |
| Two almost identical backfill entry files | Duplicate implementation | Consolidate |
| Omen canonical-runtime reconcile immediately followed by Omen runtime PATCH | Suspected redundant mutation | Consolidate into one selected-profile reconciliation |
| Sync ignoring live env model/context override | Unknown | Document/decide before changing |

No gate in this bounded read set is safely classified as “dead, delete now” merely from lack of package-script registration.

---

## 7. Existing tests that protect the migration seam

Static inspection found existing unit/regression coverage around the exact areas a config migration should preserve:

- `agent_config.test.ts`: agent ID validation, model metadata lookup/config building, env context override behavior.
- `agent_prompt_reconciliation.test.ts`: stale managed system patched exactly once from canonical source; managed reconciliation not undone by model availability fallback; canonical AgentFile compiled block snapshots.
- `backfill_agent_config.test.ts`: canonical backfill prompt content, canary path that skips canonical prompt reconciliation, verified DeepSeek/Omen runtime profiles, briefly stale GET handling, purpose tags, dedicated agent config reuse.
- `managed_runtime_config.test.ts` / `live_agent_surface_reconciliation.test.ts` (identified in Investigation 01 and current scripts tree): runtime/surface reconciliation boundaries.
- `backfill_runtime_safety.test.ts`: privileged backfill preflight.

These were **not executed in this investigation**; statements above are source-level observations only.

---

## 8. Required migration validation plan

### Fully offline / mock-safe

1. **Prompt byte/render equivalence**
   - extracted `live-system.md` reads to exactly the current canonical system string under a defined newline rule;
   - same for backfill;
   - no XML/user interpolation involved in static prompts.
2. **Config schema + precedence**
   - valid defaults;
   - env model/context override behavior where retained;
   - unknown field, malformed JSON, absent file, empty prompt, invalid profile/context/provider fail before fetch/PATCH;
   - no silent model fallback.
3. **Managed reconciliation**
   - stale existing agent receives expected prompt/runtime PATCH;
   - matching agent receives zero PATCH on second reconcile;
   - provider + parallel settings ride the same model/context PATCH and effective parallel flags are reverified.
4. **Omen convergence**
   - selected Omen profile gets one intended runtime convergence path rather than DeepSeek-then-Omen;
   - post-GET verification remains mandatory;
   - ordinary backfill does not accidentally use Omen.
5. **Backfill runner consolidation**
   - both profile wrappers share identical argument/preflight/checkpoint/batch behavior;
   - Omen binder executes after safety/identity resolution and before batch execution.
6. **Sync configuration** (only if included in a later slice)
   - expected chosen inheritance/profile semantics;
   - tool inventory remains stripped and relationship-recall-only;
   - prompt fragment rendering preserves escaping and bounded context.
7. **Packaging**
   - run tests from a different cwd;
   - copy/install a package-shaped fixture and prove module-relative prompt/runtime files are present and readable;
   - missing packaged config fails clearly.
8. **Fingerprint**
   - deterministic for same bytes/profile;
   - changes when authored prompt/runtime changes;
   - no credential material included.

### Requires later explicit real-service authorization

- existing production-like managed live agent receives the intended prompt/profile and remains on the expected model/provider/context;
- second real reconcile performs no extra PATCH;
- a real imported new agent gets the same effective authority as an existing managed agent;
- Omen runtime’s provider-specific effective state is accepted and verified against the actual Letta version;
- if sync profile semantics change, a real ephemeral sibling is created with the expected effective model/context and still cleans up;
- package/release installation path on the actual host sees the shipped config files.

No such real-service validation was attempted here.

---

## 9. Suggested implementation tickets, in order (maximum 3)

### Ticket 1 — Extract authored managed prompt/runtime config behind existing reconciler

**Scope:** add module-relative loader for `live-system.md`, `backfill-system.md`, and a versioned non-secret runtime JSON; make `getCanonicalManagedAgentConfig()` / backfill profile selection consume it while leaving AgentFile surface/bootstrap responsibilities intact.

**Behavior conditions:** external env-agent ownership remains protected; `LETTA_MODEL`/context precedence is explicitly preserved or separately migrated; parallel/provider validation stays code-owned; malformed/missing config fails before remote mutation; no auto fallback.

**Offline tests:** equivalence with baseline prompt/runtime, strict schema failures, precedence, no-op second reconcile, existing-agent update, package-shaped path fixture.

**Risk:** dual authority during transition if AgentFile and extracted config disagree. Mitigate with an explicit test asserting import artifact fields either match the authored profile or are intentionally overridden immediately and safely.

### Ticket 2 — Consolidate backfill runner + selected runtime profile convergence

**Scope:** remove byte-for-byte duplicate backfill orchestration and route ordinary/Omen through a shared runner; split prompt/identity reconciliation from runtime-profile application so Omen does not need canonical-DeepSeek then Omen convergence.

**Behavior conditions:** privileged preflight, mutation permissions, semantic-index ownership, checkpoint binding, retry rotation, purpose tag, Omen verified post-check all remain mandatory.

**Offline tests:** runner parity and ordering; zero unnecessary intermediate runtime PATCH; second same-profile convergence no-op if implementation supports conditional PATCH; failed Omen verification blocks before batch processing.

**Risk:** ordering regressions around safety/checkpoint/runtime binding. Make call-order assertions explicit.

### Ticket 3 — Decide and encode sync profile authority

**Scope:** only after Tickets 1–2 settle config vocabulary, choose whether sync inherits effective live runtime or has its own named low-latency profile; optionally move only the static sync policy prose out of the template literal.

**Behavior conditions:** do not merge sync tool surface with async; no canonical mutation in sync; mandatory relationship search remains; XML escaping, bounded context, checkpoint and ephemeral resource cleanup unchanged.

**Offline tests:** effective profile selection, prompt wrapper equivalence, tool-set regression and cleanup lifecycle tests.

**Risk:** latency/behavior change in an experimental path; requires later isolated real-service canary before production adoption.

---

## Final recommendation to orchestrator

The repository does **not** need a large new configuration framework. Its strongest existing seam is already `agent_config.ts` + managed reconciliation; the cleanup should make the authored inputs humane and explicit while preserving that machinery.

The most valuable concrete cleanup discovered nearby is the backfill profile boundary: ordinary and Omen entrypoints are effectively one runner, and Omen currently passes through canonical backfill reconciliation before being force-bound to Omen. Consolidating that into one selected, verified profile removes real duplication and remote churn without weakening safety.

Do not spend the first cleanup pass deleting gates. In this bounded area, the apparent complexity mostly encodes real failure boundaries (managed ownership, effective parallel settings, dedicated-agent identity, writer permissions, semantic-index ownership, checkpoint binding, Omen verification). The safe win is **authority consolidation**, not protection removal.
