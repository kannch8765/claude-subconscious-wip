import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryRuntime, RelationshipMemoryStore, type SemanticRetriever } from '../src/index.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('foreground recall candidate diagnostics', () => {
  it('exposes lexical, existing-vector semantic, hybrid, and first-stage rank without changing the public recall result path', async () => {
    const root = temp('rm-recall-candidate-scores-');
    const retriever: SemanticRetriever = {
      async rank() { throw new Error('foreground path must not refresh the index'); },
      async rankExisting(documents) {
        return new Map(documents.map((document) => [document.id, document.text.includes('萨莉亚') ? 0.82 : 0.45]));
      },
    };
    const messages = new Map([
      ['ev1', { conversation_id: 'c1', message_id: 'ev1', role: 'user' as const, quote: '今天又来萨莉亚了。', captured_at: '2026-08-24T00:00:00.000Z' }],
      ['ev2', { conversation_id: 'c1', message_id: 'ev2', role: 'user' as const, quote: '京都买了礼物。', captured_at: '2026-08-23T00:00:00.000Z' }],
    ]);
    const store = new RelationshipMemoryStore(root, 'subject');
    const runtime = new RelationshipMemoryRuntime(store, messages, () => '2026-08-24T01:00:00.000Z', new Map(), false, retriever);
    store.beginBatch('seed', '2026-08-24T00:00:00.000Z');
    const saizeriya = runtime.remember('seed', {
      schema_version: 1,
      kind: 'shared_experience',
      summary: '猫和琥珀一起在萨莉亚点餐',
      participants: ['user', 'assistant'],
      evidence_message_ids: ['ev1'],
      payload: { title: '萨莉亚', event: '萨莉亚点餐', shared_meaning: '一起点餐的共同经历' },
    });
    runtime.remember('seed', {
      schema_version: 1,
      kind: 'shared_experience',
      summary: '京都礼物',
      participants: ['user', 'assistant'],
      evidence_message_ids: ['ev2'],
      payload: { title: '京都礼物', event: '京都旅行礼物', shared_meaning: '旅行里被惦记的共同经历' },
    });
    runtime.finalizeBatch('seed', true);

    const candidates = await runtime.memorySearchRecallCandidatesWithEvidence({ query: '又来吃意大利菜啦', limit: 20 });

    expect(candidates[0].memory_id).toBe(saizeriya.memory_id);
    expect(candidates[0].retrieval).toEqual(expect.objectContaining({
      semantic_score: 0.82,
      first_stage_rank: 1,
    }));
    expect(candidates[0].retrieval.hybrid_score).toBeGreaterThan(candidates[1].retrieval.hybrid_score);
    expect(candidates[0].quote_snippets.map((item) => item.quote)).toContain('今天又来萨莉亚了。');

    const legacyShape = await runtime.memorySearchRecallHybridWithEvidence({ query: '又来吃意大利菜啦', limit: 20 });
    expect((legacyShape[0] as any).retrieval).toBeUndefined();
  });
});
