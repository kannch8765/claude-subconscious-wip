import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryRecallAnchorCandidate, RelationshipMemoryRuntime } from '../relationship-memory/src/index.js';
import type { SyncRecallRunResult } from './sync_recall.js';
import { makeShadowReceipt, runDeterministicAnchorShadow } from './sync_recall.js';

function rawResult(): SyncRecallRunResult {
  return {
    status: 'ok',
    query_sha256: 'query-hash',
    elapsed_ms: 120,
    candidates: [
      { memory_id: 'tone', summary: '亲昵语气旧记忆', first_stage_rank: 1, lexical_score: 0, semantic_score: 0.7, hybrid_score: 70 },
      { memory_id: 'wake', summary: '修好唤醒桥', first_stage_rank: 2, lexical_score: 0, semantic_score: 0.65, hybrid_score: 65 },
    ],
    selected: {
      memory: { memory_id: 'tone', summary: '亲昵语气旧记忆' } as any,
      memory_rerank_score: 0.73,
      memory_rerank_rank: 1,
      snippets: [],
      body: '记忆：亲昵语气旧记忆',
      envelope: '<subcon_whisper/>',
    },
  };
}

function anchorCandidate(memory_id: string, summary: string, rank: number, score: number): MemoryRecallAnchorCandidate {
  return {
    memory_id,
    summary,
    schema_version: 1,
    subject_id: 'subject',
    kind: 'shared_experience',
    participants: ['user', 'assistant'],
    payload: { event: summary },
    status: 'active',
    observed_at: '2026-08-20T00:00:00.000Z',
    created_at: '2026-08-20T00:00:00.000Z',
    source_key: 'source-' + memory_id,
    dedupe_key: 'dedupe-' + memory_id,
    owner_corrected: false,
    anchor_retrieval: {
      anchor_score: score,
      matched_anchor_count: 1,
      anchor_count: 2,
      first_stage_rank: rank,
    },
  } as MemoryRecallAnchorCandidate;
}

afterEach(() => {
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SHADOW_INCLUDE_ANCHORS;
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_ANCHOR_ALIASES_FILE;
});

describe('anchor shadow diagnostics', () => {
  it('records disagreement and fused ranks without persisting derived prompt anchors by default', () => {
    const runtime = {
      memorySearchRecallAnchorCandidates() {
        return [
          anchorCandidate('wake', '修好唤醒桥', 1, 0.92),
          anchorCandidate('tone', '亲昵语气旧记忆', 2, 0.31),
        ];
      },
    } as unknown as RelationshipMemoryRuntime;

    const anchor = runDeterministicAnchorShadow('对呀那个唤醒桥之前又掉了', rawResult(), runtime);
    expect(anchor.status).toBe('ok');
    expect(anchor.anchor_count).toBeGreaterThan(0);
    expect(anchor.context_signal_count).toBeGreaterThan(0);
    expect(anchor.anchors).toBeUndefined();
    expect(anchor.context_signals).toBeUndefined();
    expect(anchor.top_agrees_with_raw_selected).toBe(false);
    expect(anchor.raw_selected_anchor_rank).toBe(2);
    expect(anchor.candidates[0].memory_id).toBe('wake');
    expect(anchor.fused_candidates.slice(0, 2).map((item) => item.memory_id).sort()).toEqual(['tone', 'wake']);
    expect(anchor.fused_candidates[0].rrf_score).toBeCloseTo(anchor.fused_candidates[1].rrf_score, 12);

    const receipt = makeShadowReceipt('s1', '/tmp', '对呀那个唤醒桥之前又掉了', rawResult(), '2026-08-24T00:00:00.000Z', anchor);
    expect(receipt.query_preview).toBeUndefined();
    expect(receipt.anchor_shadow?.anchors).toBeUndefined();
    expect(receipt.anchor_shadow?.context_signals).toBeUndefined();
  });

  it('only includes anchor text under the explicit shadow opt-in', () => {
    process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SHADOW_INCLUDE_ANCHORS = '1';
    const runtime = {
      memorySearchRecallAnchorCandidates() {
        return [anchorCandidate('wake', '修好唤醒桥', 1, 1)];
      },
    } as unknown as RelationshipMemoryRuntime;

    const anchor = runDeterministicAnchorShadow('唤醒桥之前又掉了', rawResult(), runtime);
    expect(anchor.anchors).toBeDefined();
    expect(anchor.context_signals).toEqual(expect.arrayContaining(['之前', '又']));
  });
});
