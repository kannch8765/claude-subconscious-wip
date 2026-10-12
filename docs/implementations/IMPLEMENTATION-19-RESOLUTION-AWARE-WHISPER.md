# Task 19 · Resolution-aware async Whisper transport (Draft)

Depends on Draft PR #125 (task/async-reviewed-memory-projection). All code is isolated; no production changes.

## Behavioral contract

Subcon's Agent, current-memory memory_search, allowed tools and deliver_whisper(memory_id, snippet_ids) (1–3 exact, previously searched historical snippets) remain UNCHANGED. Existing sync deliver_whisper remains unchanged, too.

For async delivery only, a pure renderResolutionAwareWhisper reads the owner-reviewed CURRENT memory and adds bounded, trustworthy presentation. This happens after the Agent selects the primary memory and original snippets, immediately before the existing Whisper queue operation. It does not invoke a model, run another search, or amend any canonical/evidence record.

The one formatter uses existing projected metadata rather than six isolated agents or six new tool calls:

- same_meaning: One current owner summary. Original quote snippets already follow the merged source family.
- changed_over_time: Current summary plus bounded dated historical stages; optionally one exact short source transcript sentence per prior stage (never synthetic).
- context_dependent: Annotate the reviewed context/scope of the chosen current memory; retain the original quote.
- conflict: Conflicting memories are filtered from the current workspace. If a conflict/hide happens after search but before delivery, do not queue Whisper.
- related: Existing Top-2 MMR direct owner-confirmed summaries (420-character budget), no associated quotes.
- unrelated: No automatic related neighbor appears. The main memory still surfaces normally.

Non-resolution memories produce the previous format unchanged, except that a late owner correction replaces an outdated summary while keeping original selected quotes.

## Provenance, performance and guardrails

- Added historical quotes originate from EvidenceRecord.quote (user_text or assistant_text), never from model paraphrase. The original 1–3 selected snippet IDs are preserved.
- At most 3 historical stages and a 420-character stage block. Owner effective records and a batched evidence read are requested ONLY when the selected memory has a temporal history pointer.
- Repeated changed_over_time reviews retain chronological predecessor links and allow the prior current target to become historical when a subsequent target is selected.
- No delivery for deactivated, merged-away or conflict-hidden memories even when a search result became stale during the current turn.
- Contradictory owner decisions after later merges of separately approved families require the separate unified provenance-aware Review Inbox. Do not treat collisions as unqualified related facts. This is an outstanding release consideration.
- No extra Agent instructions, embedding or language model calls.

## Validation

npm run typecheck; npx vitest run --maxWorkers=1; focused test suites in scripts/resolution_aware_whisper.test.ts, scripts/resolution_aware_whisper_integration.test.ts, relationship-memory/tests/relation-resolution.test.ts.

No production backfill, merge, or deploy without approval.
