# Task 21 · Foreground Kohaku Remember + Feel (Draft)

This feature integrates PR #126's formatter with PR #127's unified effective-memory review inbox in one isolated branch. No production mutations.

## Required behavior

- Foreground Remember is a trusted transcript tool-use with original memory.text and feel.text. The intent is independently preserved and linked to a canonical memory only through accepted/duplicate backend outcomes.
- A protected assistant-authored canonical A can receive B in a same_meaning resolution, but A cannot be merged away into B. In all subsequent structural merges, the effective survivor must remain A. When both A and B have first-party authored intents, refuse either merge target and suggest choosing another relation.
- Only same_meaning merges are constrained; changed_over_time keeps historical states and remains usable.
- Owner Review sends protected_target_memory_ids on current effective review cards. Telegram only offers legal same_meaning target(s), showing a protected indication.
- Search gives linked owner-authored effective memories +6 hybrid ranking points after topical filtering, without additional embedding/model requests. This is a light preference, not absolute priority.
- Whisper delivers original historical Memory and Feel text (up to three most recent intent pairs) with dates and explicit historical attribution. Original 1-3 model-selected source quote snippets remain unchanged. This is true for both sync and async paths, without modifying the Agent tool calls.
- Original Feel is not paraphrased or treated as current emotion. Related Top-2 remains summary-only, so unrelated historical emotions are not attached.

## Implementation files
- relationship-memory/src/intent/provenance.ts: shared immutable intent provenance index.
- relationship-memory/src/resolution/index.ts: root-preserving merge guard.
- relationship-memory/src/tools/index.ts: bounded recall ranking boost.
- scripts/owner_memory_review.ts: protected target metadata on projected cards.
- scripts/resolution_aware_whisper.ts and scripts/send_worker_native.ts: historical Feel transport.
- Telegram companion Draft branch layered on its existing PR #30.

## Test scenarios
- Authored A + ordinary B: A+B→B rejected, A+B→A accepted; Undo restores.
- Repeat merge A+B→A then A+C→C rejected, A+C→A accepted.
- Both A and B authored: neither can disappear through same_meaning; related remains available.
- Legacy wrong-root resolution requires owner Undo rather than quietly chaining.
- Close ranking favors authored; large relevance gap favors more relevant candidate; missing relevance evidence is not introduced by the boost.
- Actual queued Whisper includes original Memory+Feel after correct merge, marked as past, while selected quote text is untouched.
- Telegram shows only legal target and existing alternate relation choices.

Do not merge/deploy production without user approval; CI and integration review are still required.