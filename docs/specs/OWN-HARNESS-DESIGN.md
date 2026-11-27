# Own harness: replacing Letta for the live Subconscious agent

Status: **draft** (2026-11-27). Design only, nothing implemented. Open questions are in §7.

This document holds numbers and architecture only. It contains no memory or
transcript content.

## 1. Current state (measured)

Source: archived Letta traces 2026-08-08 .. 2026-10-15, main agent only, counted
by scripts outside this repo (metadata only).

**Cost per pass (DeepSeek V4.1 Flash period, 1,091 passes, 4,268 LLM steps):**

| Metric | Value |
|---|---|
| LLM steps per pass | mean 3.84, p50 3, p90 7, max 42 |
| `memory_search` calls per pass | 2.49 |
| Prompt tokens per step | p50 207k, p90 331k (`context_window_limit` 400k) |
| Steps above 200k / 300k / 400k | 53 % / 18 % / 12 steps |
| Prompt tokens per user message | ~600–800k (sum over the steps of one pass) |
| Messages per request | p50 54, p90 103 |
| Letta summarization calls | 99 (Subcon configures no compaction of its own) |
| Error responses | 76 of 4,344 steps |

Each step re-sends the whole conversation, so the per-message cost is
roughly *steps × history size*. Regrouped into passes for the dry run (§4.3):
p50 647k, p90 1,330k prompt tokens per pass.

**What the prompt is made of** (120 sampled requests, ~431k chars each):

| Part | Share |
|---|---|
| Tool results (mostly old `memory_search` results with `quote_snippets`) | 79 % |
| User / transcript batches | 19 % |
| System prompt | 1.7 % (~7.5k chars) |
| Assistant messages | 0.2 % |

Old search results stay in the per-session Letta conversation until Letta's
own summarizer runs.

**Can old tool results simply be dropped?** Not blindly. Where acted-on IDs
came from (DS V4.1 period):

| Action | IDs | From this pass's search | Only in older history |
|---|---|---|---|
| `deliver_whisper` | 700 | 97.7 % | 2.3 % |
| `memory_reinforce` | 284 | 72 % | 27.5 % |
| `linked_memory_ids` on remember | 71 | 73 % | 27 % |

History-only IDs are recent: 60 of 78 history-only reinforces came from the
previous pass, 70 of 78 from the last 3 passes. A small "recently seen" list
(§4) covers them without keeping full results.

**Instructions:** `config/live-system.md` (7.2k chars) plus template blocks in
`Subconscious.af`: `core_directives` 7,621 chars (over its own 5,000 limit),
`tool_guidelines` 3.6k, `self_improvement` 2.3k. A large part is the original
coding-assistant scaffold; surfacing and identity rules repeat in three
places. The live blocks have not been compared with the template yet.

## 2. Coupling map

### 2.1 Keep as is (memory core)

`RelationshipMemoryRuntime` (`relationship-memory/src/tools/index.ts`) and the
store, schema, ledger, retrieval, resolution, owner review, whisper queue and
rendering. Letta client tools are thin wrappers that call runtime methods
(`memorySearch*`, `reinforce`, `remember*`, `rememberEntity`,
`suggestMaintenanceReview`, `finalizeBatch`). The new harness calls the same
methods. No validation rule in the runtime needs to change.

### 2.2 Rules written around "one Letta turn"

These are the real coupling. Each one needs a definition in the new harness.

| Rule | Where | Today | Impact |
|---|---|---|---|
| Whisper provenance | `send_worker_native.ts` `deliver_whisper` | One whisper per batch; memory and snippets must come from a `purpose=foreground_recall` search **in this turn** | Keep the check. If decisions move into one final structured output (§4.3), the check moves with them. |
| Relation provenance | `requireMaintenanceSearchProvenance` | `suggest_memory_relation` IDs must come from a `purpose=maintenance` search **in this turn** | Conflicts with the recently-seen list: IDs from the previous pass are rejected. See §7. |
| Evidence scope | `trustedEvidence()` | `evidence_ids` must be in the current batch's canonical messages | Unchanged: a pass still owns one batch. |
| Batch and cursor | `finalizeBatch`, `cursorShouldAdvance` | Cursor advances only on `completed`; `retryable_failure` replays the batch on the next Stop hook | Needs a definition of "pass succeeded" (§3). The ownership model in `BATCH-FAILURE-MODEL.md` already separates this from tool errors. |
| Intent budget | `MAX_UNRESOLVED_INTENT_TURNS = 3`, `MAX_DEFERRED_INTENT_REPLAYS = 3` | Counted in completed observer turns | Same counter, counted in completed passes. |
| Mandatory search | `requiredClientToolNames: ['memory_search']` | At least one search when there is a real user message | If the sync lane already searched, the async pass can start from those results instead. |
| Mutation boundary | `withMutationBoundary` | Needed because overlapping Stop hooks share one Letta conversation | Keep: workers can still overlap. |
| Session-known mask | `getSessionForegroundKnownMemoryIds` | Foreground recall excludes memories already delivered or written this session | Keep; shared by both lanes. |

### 2.3 Letta plumbing that goes away

- Per-session conversations, `conversations.json`, retry-rotation markers for a
  poisoned conversation, busy-conflict retry under Letta's 300 s conversation
  lock, `approval_pending` handling, continuation streams
  (`conversation_utils.ts`, `native_letta_backfill.ts`). Most recovery paths
  added in PRs 35–40 and #144 exist for these.
- The current sync lane creates a tool-stripped sibling agent, blocks and an
  ephemeral conversation per foreground turn, then cleans up or defers cleanup
  (`sync_subcon.ts`, `sync_letta_resources.ts`). The small-model sync lane
  replaces it.
- Working blocks. In the default `whisper` mode they are never shown to
  foreground; only the agent reads them. A session card (§4.1) replaces them.
  Live mode not confirmed.
- `agent_config.ts`, `.af` template reconciliation, managed system prompt sync,
  `letta_api_url.ts`, `patches/letta-0.16.8-opencode-go-session.patch`.
- `conversation_search` (Letta server-side tool, 60 calls in the period):
  dropped (§7).
- Kohaku's `recall` MCP (`recall_runtime.ts`) also runs on Letta: after a
  model-free evidence bundle, it opens a temporary conversation on the main
  agent through `letta-code-sdk` (`expand_recall` at most once, then
  `deliver_recall`, 90 s timeout) and deletes it afterwards. See §4.4.
- The async pass instructions (~6k chars) are sent inside the **user** message
  of every pass (`send_messages_to_letta.ts`), so each copy also stays in the
  Letta history. In the harness they move to the stable system layer.

### 2.4 Easy to miss

- **Traces.** `subcon-observatory` and the offline eval read Letta traces
  (`relationship-memory/src/observability/` also reads the Letta API). The new
  harness must write its own per-call trace in a format both can read, or the
  offline replay exam (§6) breaks.
- **Backfill** (`SubconsciousBackfill.af`, `native_letta_backfill.ts`, legacy
  backfill runners) also runs on Letta. Migrate later or keep on Letta for now.

### 2.5 Interface inventory (to complete during implementation)

Everything the current worker takes in or hangs off, so nothing is lost in the
switch. Seen so far:

- Worker payload `LiveWorkerPayload` (`batchId`, `canonicalMessages`,
  `assistantIntents`, `latestUserMessage`, `sourceUserAt`, sync checkpoint and
  sync resource fields).
- Environment: `LETTA_MODE`, `LETTA_HOME`, `RELATIONSHIP_MEMORY_SUBJECT_ID`,
  `LETTA_API_KEY`, model / context-window overrides read by `agent_config.ts`.
- **External stdio MCP tools** (Kohaku's) loaded from the environment into the
  async lane only (`openStdioMcpToolsFromEnvironment`). Easy to miss.
- Side outputs: visibility mirror (`subcon_visibility_mirror.ts`), whisper
  queue, sync checkpoint file, session-known markers.
- Hook entry points: `SessionStart`, `PreToolUse`, `UserPromptSubmit`, `Stop`
  (`hooks/hooks.json`), plus the foreground caller of `sync_subcon.ts`.

### 2.6 Locks

Rough split, to revisit after the switch (not in scope for the harness change):

- **Letta-only**, gone with Letta: busy retry under the 300 s conversation
  lock, conversation rotation, sync agent resource cleanup.
- **Overlapping workers**, kept for now: store mutation boundary, semantic index
  lock, session state lock (monotonic cursor).

Later option: one serial queue per session (single writer) could simplify the
second group.

### 2.7 Kohaku's MCP tools

- `remember` (`remember_intent_mcp.ts`) only records a transcript-visible
  intent; no backend call. The Stop hook extracts it as a trusted intent and
  the async pass resolves it (reinforce or remember with `assistant_intent_id`).
  Harness-independent; intents go into the context with top priority.
- `recall`: see §4.4.
- Gap found: memories returned by `recall` are **not** marked session-known, so
  sync or async can later whisper the same memory. The harness should mark them.

## 3. What a pass is

One pass = one batch (transcript since the cursor + trusted intents) processed by
one lane. Proposed definition, to be confirmed:

- A pass **succeeds** when the harness reached a final answer (no transport or
  quota failure). Tool-input errors are returned to the model and do not fail
  the pass, as in `BATCH-FAILURE-MODEL.md`.
- The batch outcome stays with `finalizeBatch` and the ledger: owned work that is
  `retryable_failed`, or an intent still within its budget, holds the cursor.
- A failed pass (transport, quota, timeout) is `turn_failed`: cursor held, intent
  budget not consumed.

## 4. Context and lanes

### 4.1 Context layout (ordered for prefix caching)

| Layer | Content | Changes |
|---|---|---|
| Stable | System prompt (rewritten, deduplicated), tool schemas, rules | Per deploy |
| Slow | Session card: people / topics summary of this session | Every few passes |
| Small | Recently seen memories (last ~3 passes, ID + one line) and session-known IDs | Per pass |
| Volatile | This turn: user message, Kohaku reply, previous turn | Per pass |

Tool results live only inside one pass. At the end of the pass they are
distilled into the recently-seen list and dropped. Each layer gets a token
budget; there is no summarizer to fall back on.

### 4.2 Lanes

Two lanes, one shared session-state store (cursor, session-known, recently
seen, session card). **Decided 2026-11-27: no separate maintenance lane.**

| Lane | When | Model | Does |
|---|---|---|---|
| Sync | Before Kohaku replies, ~2 s budget | Small, read-only | Phrases → search → mask → gate → inject |
| Async | After the reply (Stop hook); later also a timer tick | Main | One pass reads the batch once and does everything in parallel tool calls: whisper for gaps sync missed; reinforce / remember / link via the recently-seen list; maintenance of what it touched; session card refresh every few passes |

Why maintenance lives in async:

- The batch is read once and the context assembled once, so the prefix cache
  serves every step, and parallel tool calls cover all jobs in one step.
- Reinforce / remember / link must be in the async pass anyway: their evidence
  must be in the current batch (§2.2).
- Maintenance is incremental: dedupe, entity alias merges and relation
  suggestions only cover memories this pass searched or wrote. No store-wide
  sweep.

`world_update` is a memory kind (a new world fact the owner tells Kohaku,
patching the knowledge cutoff; a newer one supersedes the older), so async
writes it like any other remember.

**One entry, two triggers.** The async pass is the single entry point. Today it
is triggered by the Stop hook; a later event module (§8) adds a timer tick that
runs the same pass with no new transcript.

Risk: one model carrying many tools may get less reliable, small models first.
Measure in the offline replay; §8 keeps a switch to split modules into separate
passes.

### 4.3 Fewer and lighter calls

- Start the async pass from the sync lane's search results instead of a first
  search step.
- Allow several searches in one step (`parallel_tool_calls`).
- End with one structured decision (whisper + reinforce + remember + links)
  instead of one step per tool. Runtime validation stays per item.
- Skip the deep pass when sync already covered the turn.

**Dry run on the archived traces** (DS V4.1 period, 1,113 passes, no LLM
calls): each historical pass rebuilt with the §4.1 layout (session card fixed
at 2,000 chars, recently seen = IDs + one line from the previous 3 passes, the
instructions moved into the stable layer), sizes converted at the measured
0.415 tokens/char.

| Prompt tokens per pass | p50 | p90 | Sum |
|---|---|---|---|
| Letta (real) | 647k | 1,330k | 858M |
| A: new layout, same steps as Letta | 113k | 429k | 242M |
| B: new layout, 2 steps | 88k | 152k | 108M |

Where the rest goes (tokens per step, p50):

| Layer | Tokens |
|---|---|
| Tool schemas | 13,057 |
| System prompt | 3,107 |
| Instructions (moved to system) | 2,430 |
| Session card (assumed) | 830 |
| Recently seen | 1,594 |
| This batch | 1,053 (p90 10,577) |
| One `memory_search` result | 10,569 (p90 13,127); 2 per pass p50, 4 p90 |

The first estimate (20–40k per message) was too low: it missed the tool
schemas and the size of one search result. Two levers are left, both inside
our own code:

- **Tool schemas** (13k tokens, stable and cacheable but still billed): shorter
  descriptions, fewer kind-specific remember tools.
- **Search results** (~10.5k each): fewer quote snippets per memory, shorter
  snippets, or summaries first and snippets on demand.

With layout B the stable prefix is cache-eligible on the second step. The
offline replay (§6) measures the real numbers, including cache hits.

### 4.3.1 Payload diet (measured, what-if)

**Tool schemas** (16 tools, 31.5k chars ≈ 13k tokens):

| Group | Chars | In the harness |
|---|---|---|
| Letta built-ins: `conversation_search`, `memory`, `memory_replace`, `memory_insert`, `memory_rethink` | 10.0k | Gone (dropped / session card) |
| Five `memory_remember_<kind>` tools | 12.9k | One `memory_remember` with a `kind` enum and kind-specific payload; shared fields written once |
| `entity_remember`, `memory_search`, `deliver_whisper`, `suggest_memory_relation`, `memory_reinforce`, `entity_search` | 8.6k | Keep, shorten descriptions |

Estimate: ~12k chars ≈ 5k tokens (×0.38).

**One `memory_search` result** (p50 8 memories, 8 snippets each): by chars,
`quote_snippets` 62 %, `payload` 20 %, `reinforcement_evidence_ids` 5.4 %,
`summary` 3.8 %, internal keys (`source_key`, `dedupe_key`) 2.3 %. Inside
`quote_snippets` the quote text is only 20 % (p50 22 chars per snippet); the
rest is `snippet_id` 24 %, `captured_at` 18 %, `evidence_id` 17 %,
`source_kind` 12 %, `role` 7 %.

Diet (decided 2026-11-27): **content stays untouched** (summary, payload, every
quote, known memories included in full; reinforce logic unchanged). Only
fields the model never needs are dropped from the model view; the runtime keeps
them. `memory_search` is 97 % of all tool-result chars, so the diet targets it.

| Field | Share of a result | Model view |
|---|---|---|
| `source_key`, `dedupe_key` (internal hashes) | 3.0 % | drop |
| `subject_id`, `schema_version`, `status` (one value each across 20,579 results) | 1.9 % | drop |
| `reinforcement_evidence_ids` (up to 20 IDs) | 5.5 % | drop (runtime dedupes evidence) |
| `created_at`, `latest_reinforcement_at`, empty `resolution_*` / `latest_revision_*` | ~2.4 % | drop (`observed_at` kept) |
| `quote_snippets` metadata: `snippet_id`, `evidence_id`, `legacy_source_id`, full `captured_at`, `source_kind`, `role` | ~38 % | short per-result handle mapped back by the runtime, date only, one-letter role, legacy flag only when legacy |
| `memory_id`, `kind`, `summary`, `participants`, `payload`, `linked_memory_ids`, quotes | rest | keep (`memory_id` stays full: the recently-seen list refers to it across passes) |

Estimate: ~50 % of today's size, without touching content. Separately, the
traces hold one tool call whose name is garbled by leaked model markup; the
harness should reject unknown tool names cleanly.

**Why 2.5 searches per pass** (mean; p50 2, p90 5):

- Purposes: `foreground_recall` 2,082, `maintenance` 734. Common sequences:
  recall only 315, recall → maintenance 240, recall → recall (rephrase) 211.
  58 passes (5 %) loop through 6 or more searches.
- Later searches matter: of the memories acted on (whisper / reinforce), 48 %
  first appeared in search #1, 25 % in #2, 18 % in #3 or later, 10 % outside
  the pass (recently seen, §1). Results of a later search overlap earlier ones
  by 29 % on average.

Changes:

- **One search, two views** (decided 2026-11-27). Return every hit once, in
  full, with a `known` flag (delivered or written this session) instead of
  separate `foreground_recall` / `maintenance` searches. Whisper and reinforce /
  remember use the same results; the runtime still refuses a whisper of a known
  memory. Removes the recall → maintenance repeat. Known memories are not
  compressed: 43 % of reinforces (122 of 284) target a memory already known
  this session, median 2 passes after it became known.
- Rephrasings go out in parallel in one step instead of one per step.
- The async pass starts from the sync lane's results (§4.3).
- Soft cap on searches per pass, to stop the 6+ loops.

**Dry run with the diet** (same script as §4.3, schemas ×0.38, tool traffic
×0.55):

| Prompt tokens per pass | p50 | p90 | Sum |
|---|---|---|---|
| Letta (real) | 647k | 1,330k | 858M |
| B: 2 steps, no diet | 88k | 152k | 108M |
| B: 2 steps, with diet | 53k | 94k | 67M |

The search changes above are not in this number.

### 4.4 Recall mode

Kohaku's `recall` becomes a third pass mode on the same core: read-only, small
context (query + evidence bundle, no session history), two tools
(`expand_recall`, `deliver_recall`). Same bundle-first flow and limits as today.

There is no "busy agent" any more: Letta's conversation is a stateful server
object with a lock, while a harness pass is one HTTP request built from our own
context. Recall, sync and async run side by side.

Caveats:

- Recall may not yet see a memory async is writing at that moment; the
  transcript search still finds the recent turn.
- The store is append-only JSONL read while another process appends. Recall
  already runs next to the Letta worker today, so this is not new; worth a
  check later.

### 4.5 Scheduling: one writer per session

Today every Stop hook spawns a worker at once. If the previous worker has not
advanced the cursor yet, the new batch overlaps it (same start, later end) and
waits on Letta's conversation lock for up to 240 s, then processes the
overlapping messages again. Cost: repeated tokens; possibly duplicate memories,
because the remember source key includes `batch_id` (not measured yet).

Harness:

- The Stop hook only records "session S has messages up to N".
- One async worker per session. Loop: take cursor..latest, run one pass,
  advance the cursor, repeat while new messages arrived, then exit. Messages
  that arrive during a pass are merged into the next batch, never overlapped.
- Sync and recall are read-only and do not queue.
- One global concurrency cap on OpenCode calls, shared quota. Priority: sync
  and recall (Kohaku is waiting) over async (background).

With a single writer per session, most locks in §2.6 can be revisited later.
The stuck-session replay (`replay_stuck_session.ts`, #144) relies on today's
overlap contract (monotonic cursor + Letta busy retry); under a single writer
it should hand its chunks to the same session worker instead.

### 4.6 Shared state and races

Every pass is stateless; all state lives in our files. Lanes do not share a
context: each mode assembles its own from the shared state.

| Mode | Model | Context | Size |
|---|---|---|---|
| Sync | Small | Small system, user message, previous turn (mask applied in code) | ~1k |
| Recall | Main | Recall system, query, evidence bundle | a few k |
| Async | Main | Full system, session card, recently seen, intents, batch | ~10–20k |

Lanes coordinate only through the state:

| State | Sync | Recall | Async | Race |
|---|---|---|---|---|
| Cursor | | | writes | none (single writer) |
| Recently seen, session card | | | writes | none (single writer) |
| Memory store | | | writes | owner review also writes |
| Session-known | writes | writes | writes | add-only set |

Rules:

1. One writer per piece of state where possible.
2. State with several writers is add-only (union, never overwrite).
3. Check-then-act needs one short atomic section. The real case: sync and async
   both find memory X unknown and both whisper it. `deliverSessionMemoryOnce`
   already makes check → deliver → mark atomic under the session lock; keep it,
   and route recall's marking through it as well.

Kohaku runs one session at a time (sessions rotate), so concurrent async writers
from different sessions are not expected. The store mutation boundary stays
anyway, for owner review and a rotation edge where the old session's last pass
is still finishing; idempotent stable IDs keep retries safe.

Later improvement: today cursor, session-known and conversation ID share one
JSON state file, so every change is lock → read all → write all. Splitting it by
owner (async-only fields vs an add-only session-known log) leaves only two
locks: the delivery check and the store boundary.

## 5. OpenCode Go client layer

Letta handles these today; the harness has to own them.

| Item | Today | Harness |
|---|---|---|
| `x-opencode-session` | Added per Letta conversation by our patch; missing → 400 | One stable ID per Subcon session and lane, so the prefix cache keeps hitting |
| User-Agent | Set by Letta | Set explicitly (Python urllib's default is blocked by Cloudflare 1010) |
| Model settings | `.af`: `reasoning_effort: none`, `parallel_tool_calls: true` | Own config file |
| Tool calling | Letta converts schemas and parses calls | OpenAI-compatible tools; per-model quirks; malformed arguments returned to the model |
| Retries | Letta | 429 / 5xx retry with backoff; other 4xx not retried; quota exhausted → `turn_failed` |
| Context limit | 400k + Letta summarizer | Per-layer budgets (§4.1) |
| Usage | Letta traces | Per-call trace: prompt, cached, completion, reasoning tokens, latency, error class |
| Privacy | Model choice in `.af` | Allowlist of zero-retention models in config; refuse others |
| Quota | — | Back off the async deep pass when quota is low |

The offline eval already calls OpenCode Go directly with these headers, so the
known pitfalls are covered there.

## 6. Migration

1. **Offline replay** on archived traces as the exam: same batches, compare
   tokens per message, whisper choices and ledger outcomes with what Letta did.
2. **Shadow** next to Letta: the new harness runs read-only and writes traces;
   Letta stays the owner of writes.
3. **Switch** lane by lane (sync first, then recall, then async), with Letta kept as fallback
   until the shadow numbers hold.

## 7. Open questions

1. ~~Whisper from both lanes or sync only?~~ **Decided 2026-11-27: both lanes**;
   async fills gaps sync missed, the session-known mask prevents repeats.
2. ~~Maintenance cadence?~~ **Decided 2026-11-27: no separate lane**;
   maintenance runs inside every async pass (§4.2). Open detail: how many passes
   between session card refreshes.
3. ~~Relation provenance?~~ **Decided 2026-11-27: relax** `suggest_memory_relation`
   to "searched within the last N passes" (same recently-seen list as reinforce).
4. ~~`conversation_search`?~~ **Decided 2026-11-27: drop first** (used by the
   Subcon agent on its own Letta history, not by Kohaku). Add a transcript
   search tool only if the offline replay gets worse.
5. ~~Backfill?~~ **Decided 2026-11-27: keep on Letta for now**; migrate after the
   live harness is stable.
6. ~~Successful pass?~~ **Decided 2026-11-27: as drafted in §3.**

## 8. Later: generality (idea, not decided)

**Principle: keep the foreground contract thin.** The main agent only receives
whispers and may call `remember` / `recall`; it does not manage memory files or
run memory steps itself. The contract is the hooks (`Stop`,
`UserPromptSubmit`), whisper injection, and those two MCP tools. As long as it
holds, the harness behind it can change, and any main agent (any model) works
without changes.

The harness may later carry other background jobs, for example an event /
reminder agent (to-dos, dates) that prepares items for Kohaku instead of Kohaku
tracking them. Undecided, including whether it shares the memory agent.

Main difference from recall: **time-triggered**, not conversation-triggered. An
item is due even when nobody mentions it, so it needs a timer tick into the same
async entry point (§4.2), not a new lane.

Design consequence for now: keep the core module-agnostic.

- **Core:** context assembly, LLM calls, traces, retries, session state, lanes, triggers.
- **Module:** its own tools, context layer, decision schema and validator
  (memory first, event later).
- Whether modules share one pass (one context, parallel tool calls) or run in
  separate passes is a config switch, chosen later by measurement. Shared pass:
  one cache, fewer calls. Separate passes: rules do not interfere, steadier on
  small models.
