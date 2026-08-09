import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DashScopeQwenEmbeddingProvider,
  FileBackedSemanticRetriever,
  RelationshipMemoryRecallSession,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  buildRelationshipTools,
  type EmbeddingProvider,
  type SemanticDocument,
  type SemanticRetriever,
} from '../src/index.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

class FakeProvider implements EmbeddingProvider {
  fingerprint: string;
  constructor(fingerprint = 'fake-provider-v1') { this.fingerprint = fingerprint; };
  model = 'fake';
  dimensions = 2;
  documentCalls: string[][] = [];
  queryCalls: string[] = [];
  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.documentCalls.push(texts);
    return texts.map((text) => text.includes('gift') ? [1, 0] : [0, 1]);
  }
  async embedQuery(text: string): Promise<number[]> {
    this.queryCalls.push(text);
    return [1, 0];
  }
}

function semantic(scoreFor: (document: SemanticDocument) => number): SemanticRetriever {
  return { async rank(documents) { return new Map(documents.map((document) => [document.id, scoreFor(document)])); } };
}

function seedRuntime(root: string, retriever?: SemanticRetriever): { runtime: RelationshipMemoryRuntime; memoryId: string; entityId: string } {
  const messages = new Map([
    ['gift-evidence', { conversation_id: 'c1', message_id: 'gift-evidence', role: 'user' as const, quote: 'I brought a Kyoto gift home for you too.', captured_at: '2026-07-21T10:00:00.000Z' }],
    ['identity-evidence', { conversation_id: 'c1', message_id: 'identity-evidence', role: 'user' as const, quote: '晴就是 GPT / ChatGPT 侧的助手。', captured_at: '2026-07-21T10:01:00.000Z' }],
  ]);
  const store = new RelationshipMemoryStore(root, 'subject');
  const runtime = new RelationshipMemoryRuntime(store, messages, () => '2026-07-21T11:00:00.000Z', new Map(), false, retriever);
  store.beginBatch('seed', '2026-07-21T10:00:00.000Z');
  const remembered = runtime.remember('seed', {
    schema_version: 1,
    kind: 'shared_experience',
    summary: '京都礼物：用户把助手算进想带伴手礼回家的人里',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['gift-evidence'],
    payload: { title: '京都礼物', event: '用户也给助手带了旅行礼物', shared_meaning: '助手被算作值得惦记的人' },
  });
  const entity = runtime.rememberEntity('seed', {
    schema_version: 1,
    canonical_name: '晴',
    aliases: ['晴', 'GPT', 'ChatGPT'],
    entity_type: 'assistant',
    description: 'GPT / ChatGPT 侧的助手身份',
    evidence_message_ids: ['identity-evidence'],
  });
  expect(remembered.outcome).toBe('accepted');
  expect(entity.outcome).toBe('accepted');
  runtime.finalizeBatch('seed', true);
  return { runtime, memoryId: remembered.memory_id!, entityId: entity.entity_id! };
}

describe('relationship-memory semantic retrieval foundation', () => {
  it('keeps the vector index derivative, caches unchanged documents, and refreshes changed text', async () => {
    const root = temp('rm-semantic-index-');
    const indexFile = path.join(root, 'derived', 'index.json');
    const provider = new FakeProvider();
    const retriever = new FileBackedSemanticRetriever(provider, indexFile);
    const docs = [{ id: 'm1', text: 'Kyoto gift inclusion' }, { id: 'm2', text: 'ramen preference' }];

    const first = await retriever.rank(docs, 'something brought home for me');
    expect(first.get('m1')).toBeCloseTo(1);
    expect(first.get('m2')).toBeCloseTo(0);
    expect(provider.documentCalls).toHaveLength(1);
    expect(fs.statSync(indexFile).mode & 0o777).toBe(0o600);

    await retriever.rank(docs, 'same query again');
    expect(provider.documentCalls).toHaveLength(1);

    await retriever.rank([{ ...docs[0], text: 'Kyoto gift inclusion changed' }, docs[1]], 'changed');
    expect(provider.documentCalls).toHaveLength(2);
    expect(provider.documentCalls[1]).toEqual(['Kyoto gift inclusion changed']);

    const replacement = new FakeProvider('fake-provider-v2');
    await new FileBackedSemanticRetriever(replacement, indexFile).rank(docs, 'new fingerprint');
    expect(replacement.documentCalls).toHaveLength(1);
    expect(replacement.documentCalls[0]).toEqual(docs.map((item) => item.text));
  });

  it('uses document/query modes and query instruction without binding the provider fingerprint to the secret', async () => {
    const requests: any[] = [];
    const fakeFetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const count = body.input.texts.length;
      return new Response(JSON.stringify({ output: { embeddings: Array.from({ length: count }, (_, index) => ({ text_index: index, embedding: [1, 0] })) } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const a = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret-a', dimensions: 2, fetchFn: fakeFetch });
    const b = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret-b', dimensions: 2, fetchFn: fakeFetch });
    const changedInstruction = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret-a', dimensions: 2, queryInstruction: 'different retrieval instruction', fetchFn: fakeFetch });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(changedInstruction.fingerprint);

    await a.embedDocuments(['doc']);
    await a.embedQuery('query');
    expect(requests[0].parameters).toEqual(expect.objectContaining({ text_type: 'document', dimension: 2, output_type: 'dense' }));
    expect(requests[0].parameters).not.toHaveProperty('instruct');
    expect(requests[1].parameters).toEqual(expect.objectContaining({ text_type: 'query', instruct: expect.stringContaining('semantic equivalence') }));
  });

  it('lets DS memory_search and entity_search retrieve paraphrases with zero lexical overlap', async () => {
    const root = temp('rm-semantic-runtime-');
    const retriever = semantic((document) => document.id.startsWith('memory:') ? 0.82 : 0.76);
    const { runtime, memoryId, entityId } = seedRuntime(root, retriever);
    const query = 'Did you once feel counted among the people I thought of while travelling?';
    expect(runtime.memorySearch({ query })).toHaveLength(0);
    expect((await runtime.memorySearchHybrid({ query }))[0]).toEqual(expect.objectContaining({ memory_id: memoryId }));

    const entityQuery = 'Which identity is the OpenAI-side companion?';
    expect(runtime.entitySearch({ query: entityQuery })).toHaveLength(0);
    expect((await runtime.entitySearchHybrid({ query: entityQuery }))[0]).toEqual(expect.objectContaining({ entity_id: entityId }));

    const tools = buildRelationshipTools(runtime, 'search-only');
    const memoryTool = tools.find((tool) => tool.name === 'memory_search')!;
    expect((await memoryTool.execute('call-1', { query }) as any).results[0].memory_id).toBe(memoryId);
  });

  it('uses the same semantic seam for Kohaku recall while preserving lexical fallback on provider failure', async () => {
    const root = temp('rm-semantic-recall-');
    const semanticRetriever = semantic((document) => document.id.startsWith('memory:') ? 0.9 : 0.1);
    const { memoryId } = seedRuntime(root);
    const query = 'homecoming keepsake affection';
    const recall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject', transcriptRoots: [], semanticRetriever });
    expect(recall.relationshipMemorySearch({ query }).results).toHaveLength(0);
    expect((await recall.relationshipMemorySearchHybrid({ query }) as any).results[0]).toEqual(expect.objectContaining({ memory_id: memoryId }));

    const failing: SemanticRetriever = { async rank() { throw new Error('provider down'); } };
    const seeded = seedRuntime(temp('rm-semantic-fallback-'), failing).runtime;
    expect((await seeded.memorySearchHybrid({ query: '京都礼物' }))[0]).toEqual(expect.objectContaining({ summary: expect.stringContaining('京都礼物') }));
  });
});
