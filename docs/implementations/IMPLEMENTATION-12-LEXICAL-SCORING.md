# Task 12 — Lexical scoring correctness

## Status

- Base: `main` @ `744850f77a211136868c7da4b02a7f8be28cbd21`
- Branch: `task/12-lexical-scoring-final`
- Draft PR: #91
- Scope: lexical scoring correctness only; no deployment, VPS access, real Letta/model/embedding calls, production data access, dependency changes, or retrieval-architecture/performance changes.

## Implementation

### One lexical scorer

`lexicalTextScore` in `relationship-memory/src/retrieval/index.ts` is now the single exported lexical-scoring implementation. The duplicate transcript-local `tokens` / `textScore` implementation was removed from `relationship-memory/src/recall/index.ts`; transcript search now calls `lexicalTextScore` directly.

The existing relationship-search `lexicalScore > 0` filter is unchanged.

### CJK tokenization

Lexical terms are split by writing system:

- Latin letters/digits keep word-token behavior and the existing weighting: matching terms of length >= 5 add 4, otherwise 2.
- Han, Hiragana, and Katakana runs (including Japanese long-vowel marks) are split into character bigrams. CJK bigrams always use the normal weight of 2, so the old `token.length >= 5` branch cannot accidentally treat an entire CJK run as a long Latin token.
- Mixed text can produce both Latin/digit words and CJK bigrams from the same query.

The exact-substring bonus remains unchanged: an exact query substring starts at 100 before token-level additions.

### Explicit zero-match semantics

The shared scorer preserves the retrieval-side behavior: if no lexical term matches, it returns the score accumulated so far. This means an exact-substring score is not discarded.

The pre-task source contained a nominal divergence: retrieval returned the current score when `matches === 0`, while transcript scoring returned `0`. However, the task description's specific case “exact substring hit + non-empty query tokens + zero token matches” is not constructible under the old tokenizer: if the complete exact query is a substring, every token extracted from that query is also a substring. The observable adjacent boundary is an exact query with no eligible lexical tokens; the new behavior test pins that case (`猫🐾` queried by `🐾`) at 100. The CJK partial-match tests below provide the actual repair-before red evidence.

### Missing semantic score fallback

`hybridScore` maps a missing or non-finite semantic score to `-1`, the lower bound of the cosine range already accepted by the function.

Reason: the old implicit semantic contribution of 0 let an item with no vector outrank an item with a known negative similarity such as `-0.3`. Using the bounded floor is a conservative “unknown semantic evidence” fallback: absence of a vector receives no ranking advantage, while every known finite cosine above -1 can outrank it when lexical scores are equal. Existing cosine clamping and the lexical contribution are otherwise unchanged.

## Tests

Added behavior coverage through exported/runtime surfaces; no new source-string implementation assertions were introduced.

Coverage includes:

- Chinese partial token-level match without whole-query substring match.
- Japanese (including kana) partial token-level match.
- mixed Latin + CJK matching.
- English regression with the previous exact scores (`126` and `14`).
- exact substring with no eligible lexical terms retains 100.
- missing semantic score ranks below known cosine `-0.3` at equal lexical score.
- transcript-search integration proving the recall path uses the shared scorer for CJK/mixed queries.

No existing assertion was weakened or rewritten to accommodate the new behavior. `relationship-memory/tests/recall.test.ts` only gained a new integration test; the new focused behavior file is `relationship-memory/tests/lexical-scoring.test.ts`.

## Repair-before evidence

Tests-first commit: `cb98bbdf251e9fea2bda6062cb82a44ae5f2e7e5`.

PR offline CI run: https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34045619485

That run's `head_sha` is exactly `cb98bbdf251e9fea2bda6062cb82a44ae5f2e7e5` and failed before the implementation change:

- Chinese partial match: expected score > 0, got 0.
- Japanese partial match: expected score > 0, got 0.
- mixed Latin/CJK match: expected score > 0, got 0.
- missing semantic vs `-0.3`: old scores were 0 vs -30, so the known negative result incorrectly ranked below missing.
- Summary: 4 failed / 457 passed (461 total tests). The English regression and exact/no-eligible-token cases already passed in the red run.

## Green verification before report commit

Implementation head: `bcd985884ed9b675d0f3234e84aa7d0a118f29c4`.

PR offline CI run: https://github.com/kannch8765/claude-subconscious-wip/actions/runs/34045952387

- `head_sha`: `bcd985884ed9b675d0f3234e84aa7d0a118f29c4`
- `npm run test:ci`: PASS — 52 files, 462 tests.
- `npm run typecheck`: PASS.

A final exact-head CI run is expected after this report commit; the PR's final run is the authoritative merge gate.

## Scope audit / remaining items

Files changed for Task 12 are limited to:

- `relationship-memory/src/retrieval/index.ts`
- `relationship-memory/src/recall/index.ts`
- `relationship-memory/tests/lexical-scoring.test.ts`
- `relationship-memory/tests/recall.test.ts`
- `docs/implementations/IMPLEMENTATION-12-LEXICAL-SCORING.md`

Not addressed by design: retrieval/index performance, transcript scanning performance, embedding/index refresh policy, weighting-policy retuning, bundle assembly/truncation, storage/locking, or any production/runtime deployment work. No additional correctness finding requiring an in-scope change remains after the tests above.
