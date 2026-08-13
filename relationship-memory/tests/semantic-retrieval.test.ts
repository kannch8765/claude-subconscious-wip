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
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS;
  delete process.env.RELATIONSHIP_MEMORY_EMBEDDING_THROTTLE_COOLDOWN_MS;
  delete process.env.RELATIONSHIP_MEMORY_EMBEDDING_QUOTA_COOLDOWN_MS;
});

class FakeProvider implements EmbeddingProvider {
  fingerprint: string;
  constructor(fingerprint = 'fake-provider-v1') { this.fingerprint = fingerprint; };
  model = 'fake';
  dimensions = 2;
  maxBatchSize = 10;
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

function addFallbackMatches(runtime: RelationshipMemoryRuntime): void {
  runtime.store.beginBatch('fallback-second', '2026-07-21T12:00:00.000Z');
  expect(runtime.remember('fallback-second', {
    schema_version: 1,
    kind: 'shared_experience',
    summary: '另一段旅行礼物记忆',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['gift-evidence'],
    payload: { title: '旅行礼物续篇', event: '另一段与旅行礼物有关的事件', shared_meaning: '用于验证多个 lexical 候选的 limit' },
  }).outcome).toBe('accepted');
  expect(runtime.rememberEntity('fallback-second', {
    schema_version: 1,
    canonical_name: '琥珀',
    aliases: ['琥珀', 'Claude'],
    entity_type: 'assistant',
    description: 'Claude 侧的助手身份',
    evidence_message_ids: ['identity-evidence'],
  }).outcome).toBe('accepted');
  runtime.finalizeBatch('fallback-second', true);
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

  it('checkpoints successful provider-sized batches so a later failure resumes without re-embedding earlier texts', async () => {
    process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER_COOLDOWN_MS = '1';
    const root = temp('rm-semantic-checkpoint-');
    const indexFile = path.join(root, 'derived', 'index.json');
    const provider = new FakeProvider();
    let failSecondBatch = true;
    const originalEmbedDocuments = provider.embedDocuments.bind(provider);
    provider.embedDocuments = async (texts: string[]) => {
      if (provider.documentCalls.length === 1 && failSecondBatch) {
        provider.documentCalls.push(texts);
        failSecondBatch = false;
        throw new Error('synthetic provider failure after first billed batch');
      }
      return originalEmbedDocuments(texts);
    };
    const retriever = new FileBackedSemanticRetriever(provider, indexFile);
    const docs = Array.from({ length: 25 }, (_, index) => ({ id: `m${index}`, text: `gift document ${index}` }));

    await expect(retriever.rank(docs, 'first attempt')).rejects.toThrow('synthetic provider failure');
    const partial = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    expect(Object.keys(partial.documents)).toHaveLength(10);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await retriever.rank(docs, 'resume');
    expect(provider.documentCalls).toHaveLength(4);
    expect(provider.documentCalls[0]).toEqual(docs.slice(0, 10).map((item) => item.text));
    expect(provider.documentCalls[1]).toEqual(docs.slice(10, 20).map((item) => item.text));
    expect(provider.documentCalls[2]).toEqual(docs.slice(10, 20).map((item) => item.text));
    expect(provider.documentCalls[3]).toEqual(docs.slice(20).map((item) => item.text));
    expect(Object.keys(JSON.parse(fs.readFileSync(indexFile, 'utf8')).documents)).toHaveLength(25);
  });

  it('serializes concurrent semantic index bootstraps so waiters reuse vectors instead of duplicating provider calls', async () => {
    const root = temp('rm-semantic-concurrent-');
    const indexFile = path.join(root, 'derived', 'index.json');
    const provider = new FakeProvider();
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const originalEmbedDocuments = provider.embedDocuments.bind(provider);
    provider.embedDocuments = async (texts: string[]) => {
      const call = originalEmbedDocuments(texts);
      if (provider.documentCalls.length === 1) {
        startedFirst();
        await firstRelease;
      }
      return call;
    };
    const docs = [{ id: 'm1', text: 'Kyoto gift inclusion' }, { id: 'm2', text: 'ramen preference' }];
    const first = new FileBackedSemanticRetriever(provider, indexFile).rank(docs, 'first query');
    await firstStarted;
    const second = new FileBackedSemanticRetriever(provider, indexFile).rank(docs, 'second query');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(provider.documentCalls).toHaveLength(1);
    releaseFirst();

    await Promise.all([first, second]);
    expect(provider.documentCalls).toHaveLength(1);
    expect(provider.queryCalls).toEqual(expect.arrayContaining(['first query', 'second query']));
    expect(fs.existsSync(`${indexFile}.lock`)).toBe(false);
  });

  it('defaults DashScope semantic retrieval to text-embedding-v4 and enforces its 10-text request limit', async () => {
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
    const provider = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret', dimensions: 2, fetchFn: fakeFetch });
    expect(provider.model).toBe('text-embedding-v4');
    expect(provider.maxBatchSize).toBe(10);
    await provider.embedDocuments(Array.from({ length: 10 }, (_, index) => `doc-${index}`));
    await expect(provider.embedDocuments(Array.from({ length: 11 }, (_, index) => `too-many-${index}`))).rejects.toThrow('at most 10 texts');
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('text-embedding-v4');
  });

  it('persists free-tier exhaustion cooldown across retrievers while a new provider fingerprint can proceed immediately', async () => {
    const root = temp('rm-semantic-quota-cooldown-');
    const indexFile = path.join(root, 'derived', 'index.json');
    let exhaustedCalls = 0;
    const exhaustedFetch = (async () => {
      exhaustedCalls += 1;
      return new Response(JSON.stringify({ code: 'AllocationQuota.FreeTierOnly', message: 'free tier exhausted' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const exhausted = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret', dimensions: 2, fetchFn: exhaustedFetch });
    const docs = [{ id: 'm1', text: 'Kyoto gift inclusion' }];

    await expect(new FileBackedSemanticRetriever(exhausted, indexFile).rank(docs, 'first')).rejects.toThrow('AllocationQuota.FreeTierOnly');
    await expect(new FileBackedSemanticRetriever(exhausted, indexFile).rank(docs, 'second')).rejects.toThrow('cooldown active');
    expect(exhaustedCalls).toBe(1);
    const cooldownFile = fs.readdirSync(path.dirname(indexFile)).find((name) => name.includes('.provider-cooldown.'))!;
    const cooldown = JSON.parse(fs.readFileSync(path.join(path.dirname(indexFile), cooldownFile), 'utf8'));
    expect(cooldown).toEqual(expect.objectContaining({ reason: 'quota', code: 'AllocationQuota.FreeTierOnly', provider_fingerprint: exhausted.fingerprint }));

    let replacementCalls = 0;
    const replacementFetch = (async (_url: any, init: any) => {
      replacementCalls += 1;
      const body = JSON.parse(init.body);
      const count = body.input.texts.length;
      return new Response(JSON.stringify({ output: { embeddings: Array.from({ length: count }, (_, index) => ({ text_index: index, embedding: [1, 0] })) } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const replacement = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret', model: 'text-embedding-v3', dimensions: 2, fetchFn: replacementFetch });
    await new FileBackedSemanticRetriever(replacement, indexFile).rank(docs, 'replacement');
    expect(replacement.fingerprint).not.toBe(exhausted.fingerprint);
    expect(replacementCalls).toBe(2);
  });

  it('puts 429 throttling on a shared short cooldown instead of retrying every search', async () => {
    const root = temp('rm-semantic-throttle-cooldown-');
    const indexFile = path.join(root, 'derived', 'index.json');
    let calls = 0;
    const throttledFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 'Throttling.RateQuota', message: 'slow down' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const provider = new DashScopeQwenEmbeddingProvider({ apiKey: 'secret', dimensions: 2, fetchFn: throttledFetch });
    const retriever = new FileBackedSemanticRetriever(provider, indexFile);
    const docs = [{ id: 'm1', text: 'Kyoto gift inclusion' }];

    await expect(retriever.rank(docs, 'first')).rejects.toThrow('Throttling.RateQuota');
    await expect(retriever.rank(docs, 'second')).rejects.toThrow('cooldown active');
    expect(calls).toBe(1);
    const cooldownFile = fs.readdirSync(path.dirname(indexFile)).find((name) => name.includes('.provider-cooldown.'))!;
    const cooldown = JSON.parse(fs.readFileSync(path.join(path.dirname(indexFile), cooldownFile), 'utf8'));
    expect(cooldown).toEqual(expect.objectContaining({ reason: 'throttle', code: 'Throttling.RateQuota' }));
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

  it('honors public result limits on provider-failure, no-provider, and blank-query lexical fallback', async () => {
    const failing: SemanticRetriever = { async rank() { throw new Error('provider down'); } };
    const degraded = seedRuntime(temp('rm-semantic-limit-failure-'), failing).runtime;
    addFallbackMatches(degraded);
    expect(await degraded.memorySearchHybrid({ query: '礼物', limit: 1 })).toHaveLength(1);
    expect(await degraded.entitySearchHybrid({ query: '助手身份', limit: 1 })).toHaveLength(1);

    const lexicalOnly = seedRuntime(temp('rm-semantic-limit-disabled-')).runtime;
    addFallbackMatches(lexicalOnly);
    expect(await lexicalOnly.memorySearchHybrid({ query: '礼物', limit: 1 })).toHaveLength(1);
    expect(await lexicalOnly.entitySearchHybrid({ query: '助手身份', limit: 1 })).toHaveLength(1);
    expect(await lexicalOnly.memorySearchHybrid({ limit: 1 })).toHaveLength(1);
    expect(await lexicalOnly.entitySearchHybrid({ limit: 1 })).toHaveLength(1);
  });
});
