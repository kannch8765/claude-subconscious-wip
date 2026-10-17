# REVIEW.md: what failure looks like in Subcon

This is the review lens for this repo. It applies to the author's self-review, to every PR review, and to the owner's approval.

It is built from data, not taste. On 2026-10-17 we mined about 170 records:
- 140 PRs and their review rounds
- fix, revert and restore commits
- session handoffs and lessons
- production telemetry incidents from 2026-08 to 2026-10

After removing duplicates, about 110 distinct incidents and findings remain. Counts below are approximate after that dedupe.

## How to review

- **Every finding needs `file:line` and a concrete failure scenario** (inputs or state, then the wrong outcome). No "might be an issue". If you can reproduce it, say so. Reproduced findings are fixed without debate.
- **Tag each finding:**
  - **Important**: blocks the merge.
  - **Nit**: at most 3 per review, never blocking.
  - **Pre-existing**: real, but not introduced by this PR. It goes to the board and does not block.
- **Cap review rounds at 3.** Most PRs here pass after one fix round. One needed three (a provenance bypass, fixed one alias at a time). If round 3 still finds Important issues, stop patching and rethink the approach.
- **Post reviews as PR comments, signed.** Agents share one GitHub account, so start every review comment with a signature line naming the reviewer and the reviewed commit, e.g. `🐱 Review by <name> @ <sha>`.
- **Approval covers one exact commit.** Merge only the reviewed head. An agent's approval never replaces the owner's on high-risk changes.
- **Merged is not deployed.** Say "not deployed" until a deploy receipt exists.

## Where the bugs actually came from

| Class | ≈ count | Mostly caught by |
|---|---|---|
| 1. Batch liveness: the cursor gets held | 16 | production (after merge) |
| 2. Concurrency and crash recovery on durable state | 14 | review |
| 3. Silent failure, or monitoring that lies | 18 | review + production |
| 4. Authority, provenance and scope | 11 | review |
| 5. Contract drift between twin paths | 12 | review + later analysis |
| 6. Evidence that over-claims | 9 | review |
| 7. Privacy and secret boundaries | 4 | review + author self-check |
| 8. Production-scale performance | 4 | production |
| Deploy and ops traps (scripts, units, installers) | 18 | deploy gates |

**Who catches what:**
- Review catches classes 2, 4, 6 and 7 before merge.
- Classes 1, 3 and 8 mostly escaped to production and were found weeks later through metadata analysis.
- Class-1 fixes came in chains (#59 → #60 → #61, #138 → #139 → #140), because each fix exposed the next poison pattern.

**So review hardest where production has been finding the bugs.**

**Hot paths** (most incidents):
- `relationship-memory/src/tools/index.ts`
- `scripts/send_worker_native.ts`
- `scripts/conversation_utils.ts`
- `scripts/native_letta_backfill.ts`
- `scripts/agent_config.ts`
- `relationship-memory/src/owner/index.ts`
- `Subconscious.af`

## The failure classes

### 1. Batch liveness: something holds the transcript cursor

**What it looks like:** a batch ends `retryable_failure` for a reason the batch does not own, or one that never resolves. The cursor is held, retries widen the range, and ended sessions never retry. Work piles up behind the cursor with no error anywhere.

**Past cases:**
- Zero-evidence memories treated as corrupt (#59)
- Stale retryable outcomes from earlier attempts (#60)
- Mis-reconstructed dedupe key (#61)
- Approval that never completed (#62)
- Unresolved remember intent (#138)
- One sticky "any client tool threw" bit (#139)
- First-send `409 busy` (#140)

**The rule** (`docs/specs/BATCH-FAILURE-MODEL.md`): a batch fails only when work it owns (the memory, entity or intent ledger) is not durably settled. Optional UX tools (whisper, relation suggestions) must never fail the batch.

**Ask for:**
- A test that retries the **same batch id**, not a fresh one.
- What happens on resume, on a busy conversation, on an unresolved intent, and on an optional tool error.
- A `retry_reasons` entry for every new retryable path.
- The answer to "what clears this?" for every new non-terminal state.

### 2. Concurrency and crash recovery on durable state

**What it looks like:**
- Check-then-append outside the writer lock (#26, #113).
- A read-modify-write from a pre-await snapshot that regresses the cursor (#62).
- A lock file published before its owner metadata (#62).
- SessionStart on resume overwriting session state (#114).
- A half-written append later finishing as a terminal duplicate (#14).
- Idempotency that blocks self-repair (#17).
- Treating elapsed time as proof that another worker exited (#140).

**Ask for:**
- The lock scope covering both the check and the write.
- A two-worker simulation for anything shared.
- A kill between any two writes, followed by a replay that converges.
- Never infer ownership from time.

### 3. Silent failure, or monitoring that lies

**What it looks like:**
- An MCP server that exits 0 with no output (#72).
- `isError` dropped (#63).
- Lexical fallback hiding a 24 h embedding-quota outage while everything reported healthy.
- Health showing green after collection failed.
- A watchdog that stops when its input file disappears.
- Timing segments dropped without context (#104).
- Edit failures that show no message.
- Logs in PrivateTmp, wiped on restart.

**Ask for:**
- The output of the failure path, not just the happy path.
- "Service active" is not evidence. Show the behaviour (a real recall, or a real write).
- Every fallback must be visible somewhere (a status line, a metric or a log line).

### 4. Authority, provenance and scope

**What it looks like:**
- Data keyed too broadly, or not bound to the authority that owns it:
  - Provenance keyed by source id instead of canonical subject (#29 → #31).
  - Migration not bound to the frozen manifest (#29).
  - A manifest bypass through filesystem aliases and symlinks (#15).
  - `duplicate_link` treated like `created` (#59).
  - Batch-global identity anchors leaking into unrelated whispers (#64).
  - Selection `ok` treated as admission (#73).
- Config authority:
  - `Subconscious.af` is the authority. A live PATCH gets reverted (#69), and a model auto-select can PATCH it back (#32).
  - Split-brain between `model_settings` and the effective `llm_config` (#57).
  - Live-agent settings leaking into the backfill agent (#119).

**Ask for:**
- Which source of truth is involved.
- A re-GET after every PATCH.
- Keys scoped to subject, agent or purpose, not global.
- Does this feature belong in Subcon at all? (#121 was reverted for a wrong ownership boundary.)

### 5. Contract drift between twin paths

**What it looks like:** one copy of a behaviour gets a fix and its twin doesn't.
- Sync vs async whisper (#132).
- Two search implementations sharing a cache key.
- Effective-memory fold duplicated across owner, admin and recall (#76).
- Owner revise reusing the creator schema (#135).
- The prompt suggesting a field the schema forbids (#78).
- The lexical fallback ignoring `limit` (#16).
- A second usage parser beside `mapUsage()` (#6).

**Ask for:** grep for the twin. Either change both in this PR or merge them into one.

### 6. Evidence that over-claims

**What it looks like:**
- A canary "PASS" that never exercised the path (#64).
- A report that mislabels results (#3).
- CI gated to the wrong branch, so the head never ran tests (#31, #130).
- A fixture built by hand, bypassing the real write path (#116).
- A regression test that passes trivially (#23).
- A test that switched the DB config so its fix would pass.

**Ask for:**
- Red before green: the new test fails on the base commit.
- Tests run in the default production config.
- Fixtures created through the real write path.
- Canary output that shows the path being hit.

### 7. Privacy and secret boundaries (always check; rare but critical)

This repo handles a person's relationship memories.

- Memory, chat, transcript and whisper text never appear in PRs, logs, test fixtures, telemetry or reviews. Use aggregates and ids-free metadata only.
- Child processes do not inherit the worker's API keys.
- Raw stderr never goes to the model (#63).
- Read-only audits print counts only, through a schema guard.

### 8. Production-scale performance

**What it looks like:**
- Per-memory file re-reads: a search over about 1.3k memories took 54 s (#70).
- O(N²) admin scans (#75).

**Ask for:** the cost at the current store size, plus a growth estimate.

## Deploy-facing changes (scripts, units, installers)

These are found at deploy time far more often than in review. Check them when a PR touches deploy, systemd or install files:

- **Hidden tracked files.** `git status` before commit; a worktree `node_modules` symlink slips past `node_modules/` (#140). Source-only `reset --hard` deploys would overwrite installed dependencies.
- **Service user.** It must run as the service user: full `PATH`, readable package trees, no `npx` network installs, and no runtime compile children that the service identity cannot run.
- **systemd directives must actually apply.** `RuntimeMaxSec` does nothing on a oneshot unit, and a re-install must really restart the service.
- **Gates must check the live contract.** Use the real env and launch inputs, keep the first error, and accept the healthy lazy `offline` state.
- **Rollback is one-shot and idempotent.** It restores code only, never memories.
- **Narrowest restart.** Ask which process must reload this exact change.
- **`--plan` / dry runs have no side effects.** Not even SQLite `-wal`/`-shm` files.

## Don't flag (noise from history)

- Thread exhaustion on the small VPS in the full test suite (`EAGAIN`, `pthread_create`). GitHub `offline-ci` is the gate.
- The known flake `backfill.test.ts > detects same-size checkpoint replacement`. It is tracked; tag it Pre-existing.
- `npm audit` warnings unrelated to the change.
- Efficiency ideas that only matter at a scale we don't have. Note them once as a Nit, then move on.
- Upstream Letta errors where Subcon already fails closed.
- Wording-only comments in logs or docs, unless they mislead an operator.

## Standing rules

- Don't let slow backfill hold up a live turn, and don't merge the sync and async responsibilities.
- Don't apply the foreground mask to maintenance search.
- Don't fold queue state, session markers and ranking back into one bool.
- Evidence is never moved or deleted. Resolution is a reversible projection.
- No extra embedding or LLM gate in the foreground hot path.
- Before patching a Letta or client integration, check how upstream (letta-ai/claude-subconscious, the Letta client) handles the same case.

## Keeping this file honest

- **When something reaches production that review should have caught,** ask what the reviewer didn't have in front of it. Add the case to its class here, or add a class.
- **When the same finding shows up twice,** turn it into a test, a lint rule or a `CLAUDE.md` line instead of repeating the comment.
- **Re-mine and update the counts** about once a month.
