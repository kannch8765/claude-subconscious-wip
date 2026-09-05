# Implementation 03 — editable managed system prompts

## Result

Implemented a narrow runtime-loaded prompt layer for the two repository-managed agents:

- `config/live-system.md` — authoritative bundled managed live system prompt.
- `config/backfill-system.md` — authoritative bundled managed backfill system prompt.

`Subconscious.af` and `SubconsciousBackfill.af` remain the bootstrap/surface/runtime artifacts for blocks, tools, model, embedding, context and serialized compatibility data. Their embedded `system` values are retained as non-authoritative snapshots; this implementation does not rewrite repository files at runtime.

The existing reconciliation path is preserved. Managed live/backfill resolution now replaces only the system-prompt authority with the Markdown file while leaving model/provider/context/embedding/parallel-tool behavior and surface reconciliation unchanged.

## Import and reconciliation relationship

`getCanonicalManagedAgentConfig()` still parses the AgentFile for runtime settings. For the exact bundled live/backfill AgentFile paths it overlays `system` from the matching Markdown file. An explicitly supplied custom AgentFile does not get this overlay and keeps its own serialized `system` unless a caller explicitly provides a prompt file.

New managed imports call `buildManagedAgentImportPayload()` before the remote `/agents/import` POST. That helper creates an in-memory AgentFile payload with:

1. `agents[0].system` set to the already-resolved managed Markdown snapshot; and
2. the AgentFile's derived system-role bootstrap message prefix updated from the serialized snapshot to that same text, while preserving the remainder of the bootstrap message (memory/projection data).

The on-disk `.af` is not rewritten. The same already-read canonical object is then passed into post-import reconciliation, so one managed resolution cannot upload one prompt version and reconcile against a second file read.

For existing saved managed agents, the prompt is resolved before any remote mutation and that snapshot is reused for reconciliation. For origin-tagged `LETTA_AGENT_ID`, ownership is probed read-only first; only a managed result causes the bundled prompt to be loaded. Ordinary external env-selected agents therefore do not depend on the new files.

Backfill keeps its existing canary/self-managed prompt opt-out: `reconcileCanonicalPrompt:false` does not load the bundled Markdown for an explicitly supplied/existing canary agent. A new repository-managed backfill import always requires the bundled prompt because the import itself is managed.

The experimental sync sibling still calls `getCanonicalManagedAgentConfig()` and therefore receives the live Markdown system prompt exactly as it previously received the live AgentFile system. Its per-turn sync policy and tool-stripped surface were not changed.

## Prompt loading policy

- UTF-8 text is read verbatim with `fs.readFileSync(..., 'utf8')`.
- Whitespace is preserved exactly; `trim()` is used only to reject empty/whitespace-only files.
- No interpolation, headings, front matter, newline normalization, or templating is applied.
- Paths are resolved from `import.meta.url` / the module directory, not `cwd`.
- There is no permanent prompt cache. A later managed resolution reads the file again.
- Missing, unreadable, or blank bundled prompt resources fail explicitly before a managed import/configuration PATCH.
- Diagnostics name the prompt file but do not log prompt contents.

## Compatibility boundaries

Preserved:

- managed ownership and origin/purpose tags;
- ordinary external `LETTA_AGENT_ID` zero-managed-mutation behavior;
- explicit custom AgentFile system semantics;
- canary prompt opt-out semantics;
- model/provider/context/embedding configuration and env precedence;
- effective `parallel_tool_calls` repair and post-GET verification;
- live blocks/tools reconciliation;
- Omen verified runtime binding;
- backfill order, checkpoint/index/cooldown/canonical store behavior;
- sync sibling tool difference and per-turn policy.

The raw bundled `.af` files still contain their migration-time prompt snapshots. If an external tool imports one of those files directly, outside this application's managed import path, it will use the serialized `.af` snapshot rather than `config/*.md`. This is intentional and documented in `docs/EDITABLE-SYSTEM-PROMPTS.md`.

## Baseline equivalence evidence

One-time migration verification was performed directly against the fixed baseline AgentFiles, independently of the new loader. The extracted Markdown text exactly matched the baseline `agents[0].system` strings:

- live: length 6710 chars, SHA-256 `a168fe5cec5fb41d941bb9662ee3dcebce3057d2e5e8977610f595d2baa02429`
- backfill: length 7251 chars, SHA-256 `c4c5daa2ac0f72e0e739519ebb1c22d6654ddce6b557ce9e2ecf3aa262da8317`

This equality check is intentionally not a permanent test: future legitimate edits to `config/*.md` must not be forced to keep matching the old `.af` snapshots.

Existing prompt contract tests were adjusted where their authored system-policy assertions still read `.af`, so live/backfill prompt behavior is checked against the Markdown authority while AgentFile block/bootstrap snapshot checks remain on the AgentFile.

## Validation performed

### Static/syntax check

```text
tsc --noEmit --noCheck --target ES2022 --module NodeNext --moduleResolution NodeNext \
  scripts/managed_system_prompt.ts \
  scripts/agent_config.ts \
  scripts/backfill_agent_config.ts \
  scripts/managed_system_prompt.test.ts \
  scripts/agent_prompt_reconciliation.test.ts \
  scripts/backfill_agent_config.test.ts \
  scripts/subcon_voice_contract.test.ts
```

Result: PASS.

`--noCheck` was used only because the isolated execution environment did not have the repository's Node/Vitest type dependencies installed; this still parses/transpiles all modified TypeScript.

### Offline behavioral harness

The modified source was transpiled into an install-shaped temporary directory containing the two AgentFiles and `config/`. A no-credential/no-network Node harness verified:

- current live/backfill Markdown text is initially equal to the baseline AgentFile system strings;
- module-relative loading works after changing `cwd`;
- exact whitespace is retained, blank content fails, and a subsequent read observes a file edit;
- an edited prompt snapshot is used by both canonical configuration and the in-memory import payload;
- both live and backfill import payloads have `agents[0].system` and their compiled system bootstrap prefix aligned to the same prompt;
- a custom AgentFile keeps its caller-owned `system` when no managed prompt override is supplied;
- an ordinary external env-selected agent still resolves when the bundled live prompt file is absent and performs only its ownership GET;
- a saved managed agent with the bundled live prompt absent fails before any fetch/remote mutation;
- an explicit backfill canary with `reconcileCanonicalPrompt:false` still resolves while `config/backfill-system.md` itself is absent.

Result: `manual offline checks: PASS`.

### Package shape

```text
npm pack --dry-run --json
```

Result: PASS. The package listing included:

```text
Subconscious.af
SubconsciousBackfill.af
config/live-system.md
config/backfill-system.md
docs/EDITABLE-SYSTEM-PROMPTS.md
```

The package has no `files` allow-list at this baseline, so the new `config/` resources are included by the current default npm packaging shape.

### Full Vitest suite

Attempted to install repository dependencies offline:

```text
npm ci --offline --ignore-scripts
```

Result: could not install because the sandbox npm cache does not contain `yoga-layout-3.2.1`; npm returned `ENOTCACHED`. Internet access is unavailable in this execution environment. Therefore `npm test` was not run here. No production credentials, Letta service, model, embedding service, VPS, or live backfill process was touched.

## Files changed

- added `config/live-system.md`
- added `config/backfill-system.md`
- added `scripts/managed_system_prompt.ts`
- changed `scripts/agent_config.ts`
- changed `scripts/backfill_agent_config.ts`
- added `scripts/managed_system_prompt.test.ts`
- updated prompt-authority assertions in `scripts/agent_prompt_reconciliation.test.ts`
- updated prompt-authority assertions in `scripts/backfill_agent_config.test.ts`
- updated prompt-authority assertions in `scripts/subcon_voice_contract.test.ts`
- added operator documentation in `docs/EDITABLE-SYSTEM-PROMPTS.md`

No model/profile/runtime JSON migration, backfill runner consolidation, sync profile change, recall repair, deployment, or production mutation was included.

## Follow-up real-service verification

Before production release, run the repository's normal dependency-backed test suite and a bounded managed-agent canary in an approved environment. The useful live-service checks are: edit one Markdown prompt, resolve the corresponding managed agent, confirm exactly one system PATCH for an existing agent and zero second-pass PATCHes; and separately provision a disposable managed import and confirm the created agent begins with the edited prompt without relying on a corrective system PATCH. This implementation does not perform those production/service calls itself.

## VPS acceptance follow-up — 2026-09-05

A follow-up acceptance pass was run in an isolated VPS checkout at the implementation head, with normal registry-backed dependencies installed by `npm ci`. No production service, Letta agent, Omen/backfill runner, model provider, embedding provider, or production state directory was used or mutated.

### Focused source review finding and hardening

The bundled AgentFiles currently each contain exactly one system-role text part whose text starts with the serialized `agents[0].system` snapshot. The remainder of that text is not prompt text: the live AgentFile has 15,835 trailing characters of compiled memory-block/bootstrap content, while the backfill AgentFile has 298 trailing characters of relationship-memory projection bootstrap content.

The original implementation preserved those suffixes by replacing only the serialized-system prefix, but it did not fail if a future AgentFile had zero matching bootstrap parts, and it would rewrite all matches if there were multiple. The acceptance review hardened `buildManagedAgentImportPayload()` to require exactly one compiled system bootstrap prefix. Zero or multiple matches now fail closed before import. The payload is returned as JSON text rather than a Node `Buffer`, which is directly accepted by `Blob` and removes two task-introduced `Buffer`/`BlobPart` type errors.

Permanent regression coverage now verifies, for both bundled AgentFiles, that:

- exactly one compiled bootstrap text part is rewritten;
- every character after the old serialized system prefix is byte-for-byte/text-for-text unchanged;
- all non-system/non-bootstrap payload data is unchanged;
- zero bootstrap matches fail closed;
- multiple bootstrap matches fail closed.

### Repeatable boundary evidence

The acceptance pass converted the earlier manual-only boundary checks into repeatable Vitest coverage where it was missing:

- a stale saved managed live agent converges with one system PATCH, and a second resolver pass emits no additional system PATCH;
- an ordinary untagged env-selected external agent remains usable even when the bundled live prompt resource path is missing, and performs only its read-only ownership GET;
- a saved managed live agent with a missing bundled prompt fails before any remote request;
- an explicit backfill canary with `reconcileCanonicalPrompt:false` remains usable even when the bundled backfill prompt resource path is missing and performs no system PATCH;
- an explicit custom AgentFile still keeps its own `system` unless a managed prompt file is explicitly supplied.

The stale source-level role-split test was also updated to match the new single-snapshot architecture: backfill resolves `getCanonicalManagedAgentConfig(DEFAULT_AGENT_FILE)` once, passes that same canonical object into `buildManagedAgentImportPayload(...)`, and reuses it for `reconcileManagedAgentConfiguration(...)` instead of independently reading the old prompt helper.

### Dependency-backed test results

Environment:

```text
npm ci --no-audit --no-fund
added 146 packages
Vitest 3.2.4
```

Focused editable-prompt suite:

```text
npx vitest run \
  scripts/managed_system_prompt.test.ts \
  scripts/agent_prompt_reconciliation.test.ts \
  scripts/backfill_agent_config.test.ts \
  scripts/subcon_voice_contract.test.ts \
  --reporter=verbose
```

Result: **PASS — 4 files, 33 tests**.

A normal full `npm test` was also run. The first run exposed one stale source-string assertion in `scripts/live_subconscious_role_split.test.ts`; after updating that assertion to the new canonical-config reuse contract, the editable-prompt and role-split tests passed. The remaining full-suite failures were confined to pre-existing child-process/concurrency tests outside this task:

- `relationship-memory/tests/concurrent-writer-safety.test.ts`
- `relationship-memory/tests/legacy-ombre-concurrency.test.ts`

On the task checkout, an isolated run of those two files produced 7 passes / 2 failures. The same two files run with the same installed dependencies against the fixed baseline `e83e75956b468dc43491bcb8fafff8ac70d0e854` produced 3 passes / 6 failures, including the same child exit `1`/`null` and timeout class. A separate `recall_mcp_entrypoint.test.ts` child-process failure seen during the broad run passed immediately when rerun alone on the task checkout, while the baseline isolated rerun failed. This is evidence of an existing VPS child-process/concurrency test instability rather than an editable-prompt regression; those unrelated tests were not modified.

Accordingly this acceptance pass does **not** claim a synthetic `421/421` full-suite green result. It records the raw broad-suite behavior and the baseline comparison, while the complete task-specific suite is green.

### Real TypeScript check

With dependencies installed, the modified TypeScript was checked without `--noCheck`:

```text
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --types node,vitest/globals --skipLibCheck \
  scripts/managed_system_prompt.ts \
  scripts/agent_config.ts \
  scripts/backfill_agent_config.ts \
  scripts/managed_system_prompt.test.ts \
  scripts/agent_prompt_reconciliation.test.ts \
  scripts/backfill_agent_config.test.ts \
  scripts/subcon_voice_contract.test.ts
```

After fixing the two task-introduced `Buffer`/`BlobPart` errors, the task checkout reports only:

```text
scripts/agent_config.ts(318,113): error TS2339: Property 'name' does not exist on type 'unknown'.
```

The same check against the fixed baseline reports the same pre-existing error at the corresponding baseline line 310. Therefore the acceptance patch introduces **zero new TypeScript errors relative to baseline**, but the repository still does not have a globally clean type-check baseline and this report does not label TypeScript as fully green.

### Final packaging/diff checks

`npm pack --dry-run --json` passed again in the dependency-backed VPS checkout and included both AgentFiles, both `config/*-system.md` files, and `docs/EDITABLE-SYSTEM-PROMPTS.md`. `git diff --check` also passed.

Acceptance-follow-up code/test changes are limited to:

- hardening compiled bootstrap replacement to require exactly one match;
- returning the generated AgentFile payload as JSON text for `Blob` compatibility;
- strengthening editable-prompt/boundary/reconcile tests;
- updating the stale role-split source assertion;
- this validation report.
