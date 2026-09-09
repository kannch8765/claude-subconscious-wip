# Investigation 19 — Memory maintenance abstraction and reuse map

Baseline: `investigation/19-memory-maintenance-abstraction @ bc06dbaa117f9bc63646019e456439064b20f193`, created from production-aligned `main @ c77f737ad06d278bef1321ec91cc5337fe38d827`.

This is a code-reading investigation only. No runtime/schema/tool/config/deployment behavior was changed.

## 1. Current abstraction map

### Confirmed code facts

| Boundary | Owns today | Reuse implication |
| --- | --- | --- |
| `relationship-memory/src/schema/index.ts` | Canonical/evidence/reinforcement/outcome/entity/owner-revision record types; `EffectiveMemoryRecord`; per-kind payload source of truth `MEMORY_KIND_DEFINITIONS` | Keep canonical memory kinds here. Maintenance review state is a different domain record and should not be forced into `MemoryKind`. |
| `relationship-memory/src/store/index.ts` | Append-only JSONL persistence, mutation lock, write indexes, list/get/append primitives | Reuse the append-only + mutation-boundary pattern for review suggestions; add one dedicated review JSONL/helper instead of writing canonical files. |
| `relationship-memory/src/tools/index.ts` | Search/materialization, recall evidence attachment, canonical create/reinforce behavior, model-facing JSON schemas | Reuse search result semantics and effective/reinforcement fields. Task 06 schema derivation is specifically useful for `memory_remember_<kind>`; conflict/merge tools should have small dedicated schemas. |
| `relationship-memory/src/owner/index.ts` | Effective-memory materialization and authoritative owner actions `revise/deactivate/restore` | Future review resolution must call/reuse this control plane for owner mutations; a review record must never become a second memory-authority path. |
| `relationship-memory/src/admin/index.ts` + `admin/http.ts` | Admin read model, compact rows/summary, GET `/snapshot` and `/memories` | Natural core boundary for a future explicit Memory Review Inbox read model/endpoint, separate from the frequent status snapshot. |
| `relationship-memory/src/adapter/index.ts` | Runtime construction and relationship client-tool assembly (`buildRelationshipTools`) | Add async-only maintenance tools through this existing assembly, but keep their run-local provenance gate in the worker where prior search results are known. |
| `scripts/send_messages_to_letta.ts` | Builds the normal async Subcon pass and its behavioral prompt; spawns the worker | No new lane is needed. The maintenance tools belong to the same normal async pass. |
| `scripts/send_worker_native.ts` | Per-run tool wrapping, async/sync split, run-local searched-memory tracking, whisper release | This is the exact boundary that already knows which memories were returned in this run. Extend it rather than adding a new search/gate layer. |

Concrete readability issue: `memory_search` behavior is split between `buildRelationshipTools()` in `adapter/index.ts` and a second wrapper in `send_worker_native.ts`. That split is necessary because the worker owns per-run state, but today the surfaced-result capture is embedded inside the whisper wrapper. A small reusable run-local helper (for example, a searched-memory registry with `record(results)` / `require(ids)`) would make both `deliver_whisper` and future maintenance tools share one provenance rule instead of duplicating Map checks. This is functional reuse, not cosmetic cleanup.

## 2. Conflict / merge tools: exact reuse path

### Confirmed code facts

`scripts/send_worker_native.ts::sendViaNativeClient()` creates `const surfacedRecallMemories = new Map<string, SurfacedRecallMemory>()` inside each invocation. Every wrapped `memory_search` records returned `memory_id`, canonical `summary`, and valid `quote_snippets` into that Map. `deliver_whisper` then rejects any `memory_id`/`snippet_id` not present there. The Map therefore has run-local lifetime and records the union of memories returned by prior searches in that same Subcon run.

Normal async mode receives all tools from `buildRelationshipTools(runtime, batchId)`; sync mode filters to `RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS = ['memory_search', 'entity_search']` (`adapter/index.ts`). This existing mode split is sufficient to keep maintenance tools async-only.

Task 06's reusable piece is `MEMORY_KIND_DEFINITIONS` -> `memoryRememberKindToolSchema(kind)`, which prevents drift between canonical kind validation and create-tool schemas. Conflict/merge are not memory creation and have no per-kind payload, so routing them through that abstraction would couple unrelated concepts.

### Recommendation

Add two ordinary client tools to the existing async relationship surface, with dedicated narrow schemas:

- `flag_memory_conflict`: at least two unique `memory_id`s plus a short agent-authored reason/note.
- `suggest_memory_merge`: at least two unique `memory_id`s plus a short reason/note; optionally designate a preferred survivor only if a later owner UX proves it useful.

Before append, call the shared run-local searched-memory registry and require every supplied ID to have been returned by a prior `memory_search` in this run. Do **not** call search again inside either tool. Their execute path should only append a review suggestion under the existing store mutation boundary. They must not call `revise`, `deactivate`, `restore`, reinforce, embeddings, recall ranking, whisper delivery, scheduling, or foreground release.

## 3. Existing durable primitives and minimum new state

### Confirmed code facts

- `CanonicalMemoryRecord`: immutable genesis semantic record in `memories.jsonl`; canonical status is created as `active` (`schema/index.ts`, `tools/index.ts::remember`).
- `ReinforcementRecord`: append-only later support for one existing memory, with `evidence_ids`, `latest_evidence_at`, `recorded_at` (`schema/index.ts`, `tools/index.ts::reinforce`, `store/index.ts::appendReinforcement`).
- `RememberOutcome` / `AssistantIntentOutcome`: append-only processing/idempotency outcomes tied to source/batch or trusted assistant intent. They describe ingestion attempts, not owner-review workflow.
- `OwnerRevisionRecord`: append-only authoritative owner action (`revise/deactivate/restore`); `materializeEffectiveMemory()` derives active/inactive and latest owner revision (`owner/index.ts`).
- No review/status-like durable record exists under `relationship-memory/src/**` at this baseline.

### Recommendation

Introduce one shared append-only maintenance-review envelope rather than three independent files, e.g. fields conceptually equivalent to:

`review_id`, `subject_id`, `kind: conflict|merge|inactive_candidate`, `payload`, `status: pending|resolved|dismissed`, `created_at`, optional resolution metadata.

Kind-specific payloads should remain distinct:

- conflict: searched memory IDs + reason;
- merge: searched memory IDs + reason (and only later, if useful, proposed survivor);
- inactive candidate: one memory ID + deterministic candidate facts used when it was surfaced.

Use append-only status transitions (or immutable proposal + resolution records) so dismissal/resolution is auditable. Reuse `stableId`, JSONL append, mutation locking, and the owner control plane; do not reuse ingestion `RememberOutcome`, because its accepted/duplicate/retry semantics are the wrong lifecycle.

## 4. Daily inactive suggestion using existing fields

### Confirmed code facts

`EffectiveMemoryRecord` exposes `owner_corrected`, `latest_revision_at`, `reinforcement_count`, `reinforcement_evidence_count`, and `latest_reinforcement_at` (`schema/index.ts`). Search materialization computes reinforcement count from durable `ReinforcementRecord`s and unique reinforcement evidence IDs (`tools/index.ts::memorySearchRecallHybrid` / `materializedMemorySearchRows`).

`reinforce()` accepts only trusted current-batch evidence, removes original/already-reinforced evidence, and appends a new `ReinforcementRecord` only for genuinely new evidence supporting the same memory. Therefore reinforcement means **later trusted evidence supported the same canonical memory**, not “the memory was recalled/whispered”.

`CanonicalMemoryRecord.observed_at` is the earliest captured time among its creation evidence, while `created_at` is canonical insertion time (`tools/index.ts::remember`). `latest_revision_at` is the latest owner action time. Active/inactive is derived solely from owner revisions (`owner/index.ts::materializeEffectiveMemory`).

### Recommendation

Existing fields are sufficient for v1. Run one cheap deterministic scheduler/store job daily, no LLM/embedding/agent lane. For active memories only:

1. exclude memories with an already-pending inactive review suggestion;
2. use a minimum age threshold based on `observed_at` (with `created_at` available as operational provenance);
3. avoid recently owner-touched memories using `latest_revision_at`;
4. order by `reinforcement_count` ascending, then last support time (`latest_reinforcement_at ?? observed_at`) oldest first, then `memory_id` for stable ties;
5. append at most 5 pending `inactive_candidate` reviews.

The exact age/recent-owner thresholds should be constants, not a learned score. `reinforcement_evidence_count` can be displayed as explanation but need not create a second weighting formula in v1.

Do not use recall/whisper frequency in v1. Retrieval exposure depends on the retriever itself; feeding that frequency back into retention would favor memories the current retriever already shows and create a self-reinforcing loop. No new usage telemetry is justified by current code.

## 5. Frontend/admin boundary

### Confirmed code facts

Core admin already separates `/api/subconscious/admin/v1/memories` from `/snapshot` (`admin/http.ts`). However the canonical snapshot type can contain memory rows, so the PWA intentionally prevents the always-on Whisper panel from becoming a memory browser: `pwa-wip/pwa_server/subcon.py::_snapshot_query()` sends a sentinel `memoryId` that returns no rows, `_validate_snapshot()` rejects non-empty rows, and `src/lib/subconAdmin.ts` types `relationshipMemory.rows` as `[]`. `WhisperPanel.tsx` refreshes this status surface every 60 seconds.

### Recommendation

Put a future Memory Review Inbox behind a new explicit core admin read endpoint/read-model method, not inside `SubconsciousAdminSnapshot`. Let PWA expose a separate explicit route used only when the review UI opens. List payloads may contain the narrow memory/review bodies required for owner decision because they are not part of 60-second status polling.

Owner actions should resolve/dismiss the review record and, where requested, invoke existing `RelationshipMemoryOwnerControlPlane.deactivate/restore/revise`; never reimplement memory mutation in PWA or the review store.

## 6. Suggested next-task split/order

1. **Review schema/store core** — add maintenance-review envelope, append/list/resolve helpers and deterministic inactive-candidate selector tests; no agent/frontend work.
2. **Async conflict/merge tools** — extract/reuse the run-local searched-memory registry, add the two async-only tools, prove unknown/unsearched IDs are rejected and canonical/recall/whisper behavior is unchanged.
3. **Daily inactive scheduler hook** — one existing scheduler/cron-style invocation that calls the deterministic selector, caps at 5, and does not create an agent/model lane.
4. **Core review inbox API** — separate explicit admin read/action endpoints that reuse owner control-plane actions.
5. **PWA review UI/proxy** — fetch only on review-screen demand; keep current Whisper snapshot privacy/performance contract unchanged.

## 7. Explicitly do not build

- no new similarity/dedupe/conflict discovery algorithm;
- no new agent lane for conflict, merge, or inactive candidates;
- no LLM or embedding call for daily inactive suggestions;
- no recall/whisper ranking, delivery, foreground, or sync-mode behavior change;
- no recall/whisper-frequency telemetry or retention feedback loop in v1;
- no mutation of canonical/effective memory from agent conflict/merge tools;
- no memory bodies added to the 60-second Whisper/admin status snapshot;
- no second owner mutation implementation beside `RelationshipMemoryOwnerControlPlane`.
