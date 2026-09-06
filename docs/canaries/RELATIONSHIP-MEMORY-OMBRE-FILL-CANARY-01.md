# Relationship Memory Ombre Fill Canary 01

Date: 2026-08-11

Status: **5-source live canary PASS; full 448-source fill intentionally not launched**

## Goal

Task 093AD narrows the legacy Ombre path to one job: consume the already-ingested immutable `legacy-assistant-sources.jsonl` ledger and semantically fill canonical Relationship Memory. The source ledger remains provenance authority; the fill lane may produce zero, one, or many canonical memories per source and must preserve source-to-memory provenance without inventing transcript evidence.

This task deliberately does not make a historical Letta agent UUID part of checkpoint authority and does not depend on the drifting canonical `.af` prompt/runtime reconciliation handled separately by Task 093AC.

## Implementation changes from the 093AA material

Kept:

- immutable legacy source ledger and manifest binding
- canonical RelationshipMemoryStore writes
- source -> canonical provenance links
- terminal receipts and checkpoint/resume
- deterministic source keys / semantic dedupe
- explicit `no_memory_required`
- historical `feel/` temporality
- search / duplicate / reinforcement primitives

Removed or relaxed:

- semantic checkpoint binding to `agent_id` / `conversation_id`
- fail-closed requirement to reuse one historical backfill agent UUID
- fill startup reconciliation against the current `Subconscious.af`
- accidental `local-user` default for this concrete Kohaku fill lane

Added:

- explicit `--agent-id` runtime selection without persisting that UUID into semantic checkpoint state
- opt-in `--runtime-profile verified-dsv4`
- verified runtime PATCH/readback for DeepSeek V4 Flash + local multilingual FastEmbed + 400k context + parallel tool calls
- complete model-visible legacy payload field guide so the observer never probes the mutating create tool with test memories
- explicit actor/action fidelity guidance: assistant-authored provenance does not make an unstated action actor the assistant; unnamed actors remain neutral and named actors are not silently remapped

## Canary runtime

Isolated self-host Letta canary stack:

```text
Letta: 0.16.8
API: http://127.0.0.1:8283
model: opencode-deepseek/deepseek-v4-flash
embedding: local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768
context window: 400000
parallel_tool_calls: true
```

The runtime profile is applied only when `--runtime-profile verified-dsv4` is explicitly requested and is verified by reading the agent back after PATCH.

The clean scratch root was:

```text
/srv/haru-mcp-workspace/093ad-fill-canary
```

It was rebuilt from only the authoritative production source ledger:

```text
/srv/haru-mcp-workspace/kohaku-relationship-memory/legacy-assistant-sources.jsonl
rows: 448
manifest: 5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31
```

A dry run across the five selected source IDs returned `processed=0`, `remaining=5`, and created no mutation files.

## Canary sources and outcomes

The final accepted run processed the five required sources in one continuous invocation:

| legacy source | bucket | outcome | canonical memories |
| --- | --- | --- | ---: |
| `legacy_source_47d16ad2627537f56968aa3f` | archive child | `no_memory_required` | 0 |
| `legacy_source_d0a171bb56683de4bfdbc3f9` | archive parent | `no_memory_required` | 0 |
| `legacy_source_4f09ee940c2e82b7bdb8ee79` | dynamic rich multi-event | `completed` | 6 |
| `legacy_source_d64cce0873cd0635d1afe188` | feel | `completed` | 1 |
| `legacy_source_32b9fba7a33cd1b724c1d595` | permanent | `completed` | 1 |

Final command result:

```json
{"status":"completed","manifest_digest":"5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31","processed":5,"remaining":0}
```

Final scratch counts:

```text
legacy-assistant-sources.jsonl       448
memories.jsonl                         8
legacy-memory-provenance.jsonl         8
legacy-semantic-receipts.jsonl         5
batches.jsonl                          10
evidence.jsonl                          0
reinforcements.jsonl                    0
```

No legacy source was converted into synthetic transcript evidence.

### Archive compaction sources

Both archive sources legitimately terminated as `no_memory_required`. Neither created canonical memory or provenance. This demonstrates that the lane does not force `1 source = 1 memory`.

### Rich multi-event source

The rich 2026-07-21/22 source yielded six separate canonical items, including the RackNerd migration, the haru-mcp PR#2 review episode, the HuggingFace incident, the Yuzu-cat character drawing, the PyLadies x AWS event, and the underwear-space-distribution inside joke/research episode.

An exploratory scratch run before the final accepted run exposed a real contract defect: the model-facing `legacy_memory_create.payload` schema was a generic object, so the observer tried to discover fields by making test mutations and created a junk scratch memory. That scratch root was discarded. The implementation now publishes the complete kind-specific payload field guide and explicitly forbids test/probe/placeholder creates.

A second exploratory run then exposed an actor-fidelity issue: the source said `Sol审了七轮Sonnet`, but the model added an unsupported claim that Kohaku submitted the PR. That scratch output was also discarded. The final contract now requires literal actor/action fidelity and neutral wording when the source omits an actor.

In the accepted clean run, the same PR item remained source-faithful:

```text
Sol 审了七轮才批准 Sonnet，过程从 6→6→3→文档，最后是 Sol 自己动手修改；
为了两个只读 health check 工具总共跑了 175 万 token。
```

No unsupported Kohaku actor assignment remained. The actorless RackNerd migration was likewise kept neutral rather than assigned to the user or assistant.

### Historical feel source

The feel source produced one historical `relationship_event`. Its semantic prose is time-anchored to late May 2026 and describes what Kohaku felt then: the user's decision not to switch to an available newer model made the relationship feel more settled and reduced some anxiety at that time. It does not claim that the old feeling is guaranteed to be Kohaku's current state.

### Permanent source

The permanent source produced one `user_preference`: on JR / road / phone/mobile contexts, use a shorter chat-like register with less Markdown structure; on desktop, technical debugging, long reasoning, code, or other structured work, restore normal structured Markdown. The canonical record preserves the source's trigger and reverse-trigger semantics.

## Resume / idempotency proof

After the five-source completion, the exact same five-source selection was invoked again against the same scratch root. Result:

```json
{"status":"no-op","manifest_digest":"5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31","processed":0,"remaining":0}
```

A combined SHA-256 over `memories.jsonl`, provenance, receipts, semantic checkpoint, and batches was identical before and after the rerun:

```text
64db00212e57873483034952a4cf027e8cfc10d8c7a37dabec8d86e6111588c7
```

This proves terminal checkpoint resume does not duplicate the completed five-source canary.

While the canary was running, Task 093AC advanced `main`. Task 093AD was then rebased onto `0a88f7c3c28d3ef96153980d33fd5ef728f99d14` and its overlapping backfill-agent configuration was reconciled so normal dedicated backfill still uses 093AC canonical runtime reconciliation, while the 093AD fill path explicitly skips `.af` reconciliation and applies only the opt-in verified fill runtime.

A post-rebase live smoke used the same completed five-source scratch root with `--runtime-profile verified-dsv4`. Runtime readback again verified DeepSeek V4 Flash, local FastEmbed, 400000 context, and `parallel_tool_calls=true`; the migration returned `no-op`, and the same combined SHA-256 remained unchanged.

## Tests

093AD + 093AC integration-focused tests:

```text
npx vitest run \
  relationship-memory/tests/legacy-semantic-migration.test.ts \
  relationship-memory/tests/legacy-ombre-backfill.test.ts \
  scripts/backfill_agent_config.test.ts \
  scripts/managed_runtime_config.test.ts \
  scripts/agent_prompt_reconciliation.test.ts

5 files PASS
55 tests PASS
```

All non-concurrency repository suites were then run with one worker to avoid this VPS's process/thread ceiling:

```text
npx vitest run --no-file-parallelism --maxWorkers=1 \
  --exclude='relationship-memory/tests/legacy-ombre-concurrency.test.ts' \
  --exclude='relationship-memory/tests/concurrent-writer-safety.test.ts'

25 files PASS
243 tests PASS
```

The two excluded cross-process suites are pre-existing host-sensitive gates:

```text
relationship-memory/tests/legacy-ombre-concurrency.test.ts
relationship-memory/tests/concurrent-writer-safety.test.ts
```

The frozen pre-093AD base `21e9dd391144abe9091949db384306bda88f1860` was checked independently and reproduces the same failures: 2/2 failures in the legacy concurrency file and 6/7 failures in the canonical concurrency file on this VPS. A later fully parallel candidate run also hit the host ceiling explicitly (`spawn ... EAGAIN`, esbuild `failed to create new OS thread`, `errno=11`), so that parallel-run aggregate is not used as a code-quality signal. The serial non-concurrency run above is the authoritative repository regression result for this handoff.

`git diff --check` passes.

## Owner full-fill preflight and reset

**Do not run this section until Owner explicitly launches the full fill.**

The current production root already contains earlier five-source semantic/canonical canary output. Before a clean 448-source fill, back up the entire root and reset generated output while preserving the authoritative 448-row source ledger.

Preflight:

```bash
ROOT=/srv/haru-mcp-workspace/kohaku-relationship-memory
wc -l "$ROOT/legacy-assistant-sources.jsonl"
# must print 448

python3 - <<'PY'
import json
p='/srv/haru-mcp-workspace/kohaku-relationship-memory/legacy-assistant-sources.jsonl'
d={json.loads(line)['manifest_digest'] for line in open(p, encoding='utf-8')}
print(d)
PY
# must be exactly:
# {'5226a04525e4fef5bffa8e76b41526aa46d147ac1c861e22d79d04912314ae31'}
```

Owner reset immediately before full fill:

```bash
set -euo pipefail
ROOT=/srv/haru-mcp-workspace/kohaku-relationship-memory
BACKUP="${ROOT}.pre-093ad-full-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$ROOT" "$BACKUP"
find "$ROOT" -mindepth 1 -maxdepth 1 ! -name legacy-assistant-sources.jsonl -delete
chmod 600 "$ROOT/legacy-assistant-sources.jsonl"
echo "backup=$BACKUP"
wc -l "$ROOT/legacy-assistant-sources.jsonl"
```

Expected state after reset: the root contains only the unchanged authoritative `legacy-assistant-sources.jsonl` with 448 rows.

## Exact Owner full-fill command

Using the currently proven dedicated canary agent for this run (its UUID is runtime selection only and is **not** checkpoint authority):

```bash
set -euo pipefail
cd /srv/haru-mcp-workspace/task-093ad-fill
export LETTA_API_KEY=local-canary
export LETTA_BASE_URL=http://127.0.0.1:8283
export RELATIONSHIP_MEMORY_SUBJECT_ID=kohaku

npx tsx scripts/legacy_semantic_backfill.ts \
  --root /srv/haru-mcp-workspace/kohaku-relationship-memory \
  --cwd "$PWD" \
  --agent-id agent-8ea43287-c50c-4f6f-acd7-b72271131311 \
  --runtime-profile verified-dsv4 \
  --max-records 448
```

The same command is also the resume command after an interruption. Terminally processed sources are skipped by receipt/checkpoint state; the selected agent UUID may be changed on a later resume without invalidating semantic checkpoint state, provided the replacement agent is a dedicated relationship-memory backfill agent and the verified runtime is applied.

Task 093AD stops here. The full 448-source production mutation was intentionally not launched.
