# Investigation 19 — Memory maintenance abstraction and reuse map

## Baseline

Investigate `kannch8765/claude-subconscious-wip` from this branch, created from production-aligned `main @ c77f737ad06d278bef1321ec91cc5337fe38d827`.

This is an investigation only. Do not change runtime behavior, schemas, tools, PWA, deployment, production data, Letta state, or service configuration. Do not deploy or call real providers. Keep the report compact and behavior-oriented.

## Context / intended next stage

Recall and whisper are now considered stable enough to move into memory maintenance. The intended behavior is:

1. Improve readability and clarify the existing abstraction boundaries, especially the layer(s) already exposed toward admin/frontend.
2. In the **normal async Subcon agent lane only**, add two future tools:
   - `flag_memory_conflict`: when Subcon has already searched and seen memories that appear conflicting, it may flag them for owner review.
   - `suggest_memory_merge`: when Subcon has already searched and seen memories that appear duplicative/mergeable, it may suggest them for owner review.
   These tools must only flag/suggest. They must not revise, deactivate, merge, rerank, change recall/whisper, alter current foreground behavior, or open a new lane.
3. Both future tools should operate only on memories actually returned to that Subcon run by prior `memory_search` calls. Do not invent a new similarity search or candidate-discovery algorithm; normal Subcon `memory_search` already supplies the memories being compared.
4. Separately, a lightweight daily owner-review suggestion should surface at most 5 old/low-reinforcement active memories for possible `inactive` marking. This is scheduler/store-level work, not an agent lane. Owner decides whether to deactivate. Prefer existing fields such as reinforcement and revision metadata over inventing new usage telemetry/schema unless existing code proves insufficient.
5. These maintenance suggestions should eventually be exposable through a small frontend/admin abstraction without turning the existing always-on Whisper status snapshot into a memory browser.

## Questions to answer

### A. Current abstraction/readability map

Trace the current boundaries among at least:

- `relationship-memory/src/schema/**`
- `relationship-memory/src/store/**`
- `relationship-memory/src/tools/**`
- `relationship-memory/src/owner/**`
- `relationship-memory/src/admin/**`
- normal async Subcon runtime/tool assembly (`scripts/send_worker_native.ts`, `scripts/send_messages_to_letta.ts`, and any actual helpers they reuse)
- current PWA/admin exposure where relevant

For each boundary, state what it owns today and whether there is an existing abstraction that the next stage should extend rather than bypass.

Call out duplicated plumbing, unnecessary wrappers/gates, or naming that currently makes behavior harder to understand. Do not propose cleanup merely for aesthetics; explain what concrete future maintenance feature would become simpler or safer.

### B. Reuse for `flag_memory_conflict` and `suggest_memory_merge`

Find the exact current mechanism that records memories returned by prior `memory_search` calls within one Subcon run. We already observed `surfacedRecallMemories`; verify its lifecycle and semantics rather than assuming.

Determine the smallest reusable way for future tools to enforce:

- every supplied `memory_id` was actually returned by a prior `memory_search` in this run;
- the tool only appends a review suggestion/flag;
- the tool has no effect on canonical/effective memory, recall ranking, whisper delivery, foreground output, or lane scheduling;
- no new similarity retrieval is needed.

Also inspect the current schema-derived model-facing tool machinery from Task 06 and say what should be reused for these two non-create tools versus what should not be forced through a memory-kind abstraction.

### C. Existing schema/store primitives for owner review candidates

Before proposing any new schema, inventory reusable existing durable record patterns and append/index helpers. Compare at least:

- canonical memory records
- reinforcement records
- remember outcomes / intent outcomes
- owner revisions
- any existing review/status-like record if one exists

Recommend the minimum durable representation needed for pending/resolved/dismissed maintenance suggestions. Prefer one shared review-envelope abstraction with kind-specific payloads if that fits existing code, but do not force conflict/merge/inactive payloads to be identical if their data differs.

Explicitly identify what can be reused unchanged and what truly requires a new record/schema.

### D. Daily inactive suggestion without new telemetry if possible

Verify the exact meaning and production path of:

- `reinforcement_count`
- `reinforcement_evidence_count`
- `latest_reinforcement_at`
- `created_at` / `observed_at`
- `owner_corrected`
- `latest_revision_at`
- active/inactive owner status

Confirm whether reinforcement means “new trusted evidence later supported the same canonical memory” rather than “memory was recalled/whispered”.

Then propose a first-version daily candidate selection using **only existing fields if sufficient**. It should be transparent, deterministic, cheap, and capped at 5 suggestions/day. It should not call an LLM, embeddings, or a new agent lane. Avoid a complicated learned/scored algorithm unless code evidence makes it necessary.

Discuss whether using recall/whisper frequency would create a retriever feedback loop and whether it is better omitted from v1.

### E. Frontend/admin boundary

Inspect the existing admin read model and PWA Subcon snapshot privacy/performance boundary. Recommend where a future Memory Review Inbox API should sit so that:

- the current frequent Whisper/admin status polling remains small;
- memory bodies are not accidentally added to the always-on snapshot;
- review candidates can later be listed and owner actions invoked through a narrow explicit endpoint;
- existing owner control-plane actions (`revise/deactivate/restore`) are reused rather than reimplemented.

Do not implement the endpoint in this investigation.

## Deliverable

Write `docs/INVESTIGATION-19-MEMORY-MAINTENANCE-ABSTRACTION.md` on this branch.

Keep it concise but concrete. Include:

1. current abstraction map;
2. exact reusable pieces for conflict/merge tools;
3. exact reusable fields/primitives for inactive suggestions;
4. minimal new durable state actually required;
5. recommended implementation split/order for the next small tasks;
6. explicit list of things **not** to build (especially no similarity algorithm, no new agent lane, no recall/whisper behavior changes, no new usage telemetry unless the investigation disproves existing-field sufficiency).

For every recommendation, cite file paths and relevant functions/types. Separate confirmed code facts from recommendations.

## Validation / boundaries

- Investigation/doc-only final diff.
- No runtime/source/test/config/workflow modifications.
- No deployment, VPS mutation, production-memory mutation, real provider calls, or backfill changes.
- Do not create a PR unless explicitly asked later.
- Commit the report and return: branch name, exact head SHA, report path, and a 5–10 line summary of the findings.