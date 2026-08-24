import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryRecallCandidate, RelationshipMemoryRuntime } from '../relationship-memory/src/index.js';
import type { Reranker, RerankDocument, RerankResult } from '../relationship-memory/src/rerank/index.js';
import { makeShadowReceipt, renderSyncRecallBody, runDeterministicSyncRecall, selectSyncRecall } from './sync_recall.js';

class FakeReranker implements Reranker {
  model = 'fake-reranker';
  calls: Array<{ ids: string[]; query: string; instruction?: string }> = [];

  async rank(documents: readonly RerankDocument[], query: string, options?: { topN?: number; instruction?: string }): Promise<RerankResult[]> {
    this.calls.push({ ids: documents.map((item) => item.id), query, instruction: options?.instruction });
    if (documents[0]?.id.startsWith('memory:')) {
      return [
        { id: 'memory:m2', index: 1, score: 0.93 },
        { id: 'memory:m1', index: 0, score: 0.41 },
      ];
    }
    return [
      { id: 's2', index: 1, score: 0.88 },
      { id: 's1', index: 0, score: 0.82 },
    ].slice(0, options?.topN ?? documents.length);
  }
}

function candidate(overrides: Partial<MemoryRecallCandidate> & Pick<MemoryRecallCandidate, 'memory_id' | 'summary'>): MemoryRecallCandidate {
  return {
    schema_version: 1,
    subject_id: 'subject',
    kind: 'shared_experience',
    participants: ['user', 'assistant'],
    payload: { event: overrides.summary },
    status: 'active',
    observed_at: '2026-08-20T00:00:00.000Z',
    created_at: '2026-08-20T00:00:00.000Z',
    source_key: `source-${overrides.memory_id}`,
    dedupe_key: `dedupe-${overrides.memory_id}`,
    owner_corrected: false,
    quote_snippets: [],
    retrieval: { lexical_score: 0, semantic_score: 0.5, hybrid_score: 50, first_stage_rank: 1 },
    ...overrides,
  } as MemoryRecallCandidate;
}

afterEach(() => {
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_TOP_K;
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SNIPPET_LIMIT;
  delete process.env.RELATIONSHIP_MEMORY_SYNC_RECALL_SHADOW_INCLUDE_QUERY;
});

describe('deterministic sync recall selection', () => {
  it('reranks memories and source snippets, then renders canonical description plus chronological source quotes', async () => {
    const reranker = new FakeReranker();
    const candidates = [
      candidate({ memory_id: 'm1', summary: '不相关的旧事', retrieval: { lexical_score: 3, semantic_score: 0.61, hybrid_score: 64, first_stage_rank: 1 } }),
      candidate({
        memory_id: 'm2',
        summary: '猫和琥珀之前一起在萨莉亚点过餐',
        retrieval: { lexical_score: 2, semantic_score: 0.58, hybrid_score: 60, first_stage_rank: 2 },
        quote_snippets: [
          { snippet_id: 's1', source_kind: 'transcript', role: 'user', quote: '今天要 drinkbar 和辣味鸡翅 <3', captured_at: '2026-08-24T05:00:00.000Z' },
          { snippet_id: 's2', source_kind: 'transcript', role: 'assistant', quote: '好咪，一个人提交。', captured_at: '2026-08-24T05:01:00.000Z' },
        ],
      }),
    ];

    const result = await selectSyncRecall('猫又来萨莉亚惹', candidates, reranker, {
      snippetLimit: 2,
      now: () => '2026-08-24T06:00:00.000Z',
    });

    expect(result.selection?.memory.memory_id).toBe('m2');
    expect(result.selection?.body).toBe([
      '记忆：猫和琥珀之前一起在萨莉亚点过餐',
      '',
      '[2026-08-24]',
      '猫：「今天要 drinkbar 和辣味鸡翅 <3」',
      '当时琥珀：「好咪，一个人提交。」',
    ].join('\n'));
    expect(result.selection?.envelope).toContain('source="sync_recall"');
    expect(result.selection?.envelope).toContain('&lt;3');
    expect(result.diagnostics.find((item) => item.memory_id === 'm2')).toEqual(expect.objectContaining({
      first_stage_rank: 2,
      rerank_rank: 1,
      rerank_score: 0.93,
      semantic_score: 0.58,
    }));
    expect(reranker.calls).toHaveLength(2);
  });

  it('does not surface a memory that has no source-faithful evidence snippets', async () => {
    const reranker = new FakeReranker();
    const candidates = [
      candidate({ memory_id: 'm1', summary: 'first but ungrounded' }),
      candidate({ memory_id: 'm2', summary: 'also ungrounded', retrieval: { lexical_score: 0, semantic_score: 0.4, hybrid_score: 40, first_stage_rank: 2 } }),
    ];

    const result = await selectSyncRecall('query', candidates, reranker);

    expect(result.selection).toBeUndefined();
    expect(reranker.calls).toHaveLength(1);
  });

  it('runs the read-only foreground candidate path and records first-stage plus rerank diagnostics', async () => {
    const reranker = new FakeReranker();
    const candidates = [
      candidate({ memory_id: 'm1', summary: 'first', retrieval: { lexical_score: 10, semantic_score: 0.72, hybrid_score: 82, first_stage_rank: 1 } }),
      candidate({
        memory_id: 'm2', summary: 'second', retrieval: { lexical_score: 2, semantic_score: 0.68, hybrid_score: 70, first_stage_rank: 2 },
        quote_snippets: [
          { snippet_id: 's1', source_kind: 'transcript', role: 'user', quote: '原话一', captured_at: '2026-08-20T00:00:00.000Z' },
          { snippet_id: 's2', source_kind: 'transcript', role: 'assistant', quote: '原话二', captured_at: '2026-08-20T00:01:00.000Z' },
        ],
      }),
    ];
    const runtime = {
      async memorySearchRecallCandidatesWithEvidence(input: unknown) {
        expect(input).toEqual({ query: 'current prompt', limit: 20 });
        return candidates;
      },
    } as unknown as RelationshipMemoryRuntime;

    const result = await runDeterministicSyncRecall('current prompt', { runtime, reranker, now: () => '2026-08-24T00:00:00.000Z' });

    expect(result.status).toBe('ok');
    expect(result.selected?.memory.memory_id).toBe('m2');
    expect(result.reranker_model).toBe('fake-reranker');
    expect(result.candidates[0]).toEqual(expect.objectContaining({ lexical_score: 10, semantic_score: 0.72, hybrid_score: 82 }));
  });

  it('keeps the shadow query private by default while retaining the rendered description and source window', async () => {
    const body = renderSyncRecallBody({ summary: '猫和琥珀一起做过一件事' }, [
      { snippet_id: 's1', source_kind: 'transcript', role: 'user', quote: '猫的原话', captured_at: '2026-08-20T00:00:00.000Z' },
    ]);
    const result = {
      status: 'ok' as const,
      query_sha256: 'hash',
      elapsed_ms: 12,
      reranker_model: 'fake',
      candidates: [],
      selected: {
        memory: candidate({ memory_id: 'm2', summary: '猫和琥珀一起做过一件事' }),
        memory_rerank_score: 0.9,
        memory_rerank_rank: 1,
        snippets: [{ snippet_id: 's1', source_kind: 'transcript' as const, role: 'user' as const, quote: '猫的原话', captured_at: '2026-08-20T00:00:00.000Z', rerank_score: 0.8, rerank_rank: 1 }],
        body,
        envelope: '<subcon_whisper />',
      },
    };

    const receipt = makeShadowReceipt('session', '/tmp/project', 'sensitive current prompt', result, '2026-08-24T00:00:00.000Z');

    expect(receipt.query_preview).toBeUndefined();
    expect(receipt.result.selected?.body).toContain('记忆：猫和琥珀一起做过一件事');
    expect(JSON.stringify(receipt)).not.toContain('sensitive current prompt');
  });
});
