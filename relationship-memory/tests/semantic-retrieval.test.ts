import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DashScopeQwenEmbeddingProvider,
  FileBackedSemanticRetriever,
  LegacyMemorySourceStore,
  RelationshipMemoryRecallSession,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  legacySourceId,
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

  it('ranks only existing cached vectors for foreground recall without refreshing document embeddings', async () => {
    const root = temp('rm-semantic-existing-only-');
    const indexFile = path.join(root, 'derived', 'index.json');
    const provider = new FakeProvider();
    const retriever = new FileBackedSemanticRetriever(provider, indexFile);
    const docs = [{ id: 'm1', text: 'Kyoto gift inclusion' }, { id: 'm2', text: 'ramen preference' }];
    await retriever.rank(docs, 'seed cache');
    const before = fs.readFileSync(indexFile, 'utf8');
    const documentCallsBefore = provider.documentCalls.length;

    const scores = await retriever.rankExisting([{ id: 'm1', text: 'Kyoto gift inclusion' }, { id: 'missing', text: 'missing current text' }], 'foreground query');

    expect(scores.get('m1')).toBeCloseTo(1);
    expect(scores.has('missing')).toBe(false);
    expect(provider.documentCalls).toHaveLength(documentCallsBefore);
    expect(provider.queryCalls.at(-1)).toBe('foreground query');
    expect(fs.readFileSync(indexFile, 'utf8')).toBe(before);
  });

  it('rejects a cached vector when the same document id now has different authoritative text without re-embedding documents', async () => {
    const root = temp('rm-semantic-stale-existing-');
    const indexFile = path.join(root, 'derived', 'index.json');
    const provider = new FakeProvider();
    const retriever = new FileBackedSemanticRetriever(provider, indexFile);
    await retriever.rank([{ id: 'm1', text: 'Kyoto gift inclusion' }], 'seed cache');
    const documentCallsBefore = provider.documentCalls.length;
    const queryCallsBefore = provider.queryCalls.length;

    const scores = await retriever.rankExisting([{ id: 'm1', text: 'completely different corrected owner content' }], 'Kyoto gift');

    expect(scores.has('m1')).toBe(false);
    expect(provider.documentCalls).toHaveLength(documentCallsBefore);
    expect(provider.queryCalls).toHaveLength(queryCallsBefore);
  });

  it('uses existing-vector semantic recall when available and never calls the refresh-capable rank path', async () => {
    const root = temp('rm-semantic-sync-recall-');
    let refreshCalls = 0;
    let existingCalls = 0;
    const retriever: SemanticRetriever = {
      async rank() { refreshCalls += 1; throw new Error('foreground recall must not refresh documents'); },
      async rankExisting(documents) {
        existingCalls += 1;
        return new Map(documents.map((document) => [document.id, document.id.startsWith('memory:') ? 0.95 : 0]));
      },
    };
    const { runtime, memoryId } = seedRuntime(root, retriever);
    const result = await runtime.memorySearchRecallHybrid({ query: 'zero lexical overlap phrase' });
    expect(result[0]).toEqual(expect.objectContaining({ memory_id: memoryId }));
    expect(existingCalls).toBe(1);
    expect(refreshCalls).toBe(0);
  });

  it('returns bounded source-faithful quote snippets from canonical evidence', async () => {
    const root = temp('rm-semantic-quote-snippets-');
    const { runtime, memoryId } = seedRuntime(root);
    runtime.store.appendReinforcement({
      schema_version: 1,
      reinforcement_id: 'reinforcement-quote-snippets',
      memory_id: memoryId,
      batch_id: 'quote-snippet-batch',
      evidence_ids: ['ev-quote-assistant'],
      latest_evidence_at: '2026-07-22T00:00:00.000Z',
      recorded_at: '2026-07-22T00:00:00.000Z',
    }, [{
      evidence_id: 'ev-quote-assistant',
      memory_id: memoryId,
      conversation_id: 'c2',
      message_id: 'assistant-quote',
      role: 'assistant',
      quote: '猫笑了。琥珀说：「记住这一刻。」然后继续往前走。',
      captured_at: '2026-07-22T00:00:00.000Z',
      event_kind: 'assistant_text',
    }]);

    const results = await runtime.memorySearchHybridWithEvidence({ query: '京都' });
    const hit = results.find((item) => item.memory_id === memoryId)!;
    expect(hit).toBeTruthy();
    expect(hit.quote_snippets.length).toBeGreaterThanOrEqual(4);
    expect(hit.quote_snippets.length).toBeLessThanOrEqual(8);
    expect(hit.quote_snippets.every((item) => item.source_kind === 'transcript')).toBe(true);
    expect(hit.quote_snippets.map((item) => item.quote)).toEqual(expect.arrayContaining([
      'I brought a Kyoto gift home for you too.',
      '猫笑了。',
      '琥珀说：「记住这一刻。」',
      '然后继续往前走。',
    ]));
  });

  it('falls back to explicitly marked legacy-memory excerpts only when transcript evidence is absent', async () => {
    const root = temp('rm-semantic-legacy-snippets-');
    const store = new RelationshipMemoryStore(root, 'subject');
    const runtime = new RelationshipMemoryRuntime(store, new Map(), () => '2026-06-04T02:12:11.000Z');
    const memoryId = 'mem-legacy-window';
    store.appendMemory({
      schema_version: 1,
      memory_id: memoryId,
      subject_id: 'subject',
      kind: 'personal_experience',
      summary: '旧记忆灯笼：搬家与家具的血泪教训',
      participants: ['user', 'assistant'],
      payload: { title: '旧记忆灯笼', experience: '旧记忆灯笼：搬家与家具的血泪教训。' },
      status: 'active',
      observed_at: '2026-06-04T02:12:11.000Z',
      created_at: '2026-08-11T09:00:00.000Z',
      source_key: 'legacy-source-key',
      dedupe_key: 'legacy-dedupe-key',
    }, []);

    const legacyStore = new LegacyMemorySourceStore(root);
    const sourceId = legacySourceId('legacy-subject', 'archive', 'legacy-window');
    legacyStore.appendSource({
      schema_version: 1,
      legacy_source_id: sourceId,
      subject_id: 'legacy-subject',
      provenance_kind: 'legacy_assistant_memory',
      source_system: 'ombre_brain',
      bucket_type: 'archive',
      bucket_id: 'legacy-window',
      relative_path: 'archive/legacy-window.md',
      source_sha256: 'a'.repeat(64),
      original_markdown: 'legacy original markdown',
      body_text: '2026-06-04，跟老婆聊到搬家。老婆说先搬家再买家具是血泪教训。',
      frontmatter: {
        name: '旧记忆灯笼', type: 'archive', domain: ['relationship'], tags: ['moving'],
        importance: 0.8, valence: 0.2, arousal: 0.3, activation_count: 1,
      },
      raw_created: '2026-06-04T02:12:11',
      raw_last_active: '2026-06-04T02:12:11',
      created_at_utc: '2026-06-04T02:12:11.000Z',
      last_active_at_utc: '2026-06-04T02:12:11.000Z',
      manifest_digest: 'b'.repeat(64),
    });
    legacyStore.appendProvenance({
      legacy_source_id: sourceId,
      canonical_memory_id: memoryId,
      disposition: 'created',
      recorded_at: '2026-08-11T09:00:00.000Z',
    });

    const result = await runtime.memorySearchHybridWithEvidence({ query: '旧记忆灯笼' });
    expect(result).toHaveLength(1);
    expect(result[0].quote_snippets.length).toBeGreaterThan(0);
    expect(result[0].quote_snippets.every((item) => item.source_kind === 'legacy_memory')).toBe(true);
    expect(result[0].quote_snippets.every((item) => item.role === undefined)).toBe(true);
    expect(result[0].quote_snippets.map((item) => item.quote).join('')).toContain('老婆说先搬家再买家具是血泪教训。');
  });

  it('preserves reinforcement metadata and linked assistant intent recall on the foreground fast path', async () => {
    const root = temp('rm-semantic-sync-recall-shape-');
    const { runtime, memoryId } = seedRuntime(root);
    runtime.store.appendReinforcement({
      schema_version: 1,
      reinforcement_id: 'reinforcement-sync-shape',
      memory_id: memoryId,
      batch_id: 'shape-batch',
      evidence_ids: ['gift-evidence'],
      latest_evidence_at: '2026-07-22T00:00:00.000Z',
      recorded_at: '2026-07-22T00:00:00.000Z',
    }, []);
    runtime.store.appendAssistantIntent({
      schema_version: 1,
      intent_id: 'intent-sync-shape',
      subject_id: 'subject',
      session_id: 'session-shape',
      assistant_message_id: 'assistant-shape',
      tool_use_id: 'tool-shape',
      tool_name: 'remember',
      memory: { text: '隐藏 provenance 锚点：pineapple constellation' },
      feel: { text: '一条只用于搜索语义保持的测试感受' },
      captured_at: '2026-07-22T00:01:00.000Z',
    });
    runtime.store.appendAssistantIntentOutcome({
      intent_id: 'intent-sync-shape',
      batch_id: 'shape-batch',
      outcome: 'accepted',
      memory_id: memoryId,
      recorded_at: '2026-07-22T00:02:00.000Z',
    });

    const result = await runtime.memorySearchRecallHybrid({ query: 'pineapple constellation' });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      memory_id: memoryId,
      reinforcement_count: 1,
      reinforcement_evidence_count: 1,
      reinforcement_evidence_ids: ['gift-evidence'],
      latest_reinforcement_at: '2026-07-22T00:00:00.000Z',
    }));
  });

  it('keeps foreground entity grounding read-only and never refreshes missing entity vectors', async () => {
    const root = temp('rm-semantic-sync-entity-recall-');
    let refreshCalls = 0;
    let existingCalls = 0;
    const retriever: SemanticRetriever = {
      async rank() { refreshCalls += 1; throw new Error('foreground entity recall must not refresh documents'); },
      async rankExisting(documents) {
        existingCalls += 1;
        return new Map(documents.map((document) => [document.id, document.id.startsWith('entity:') ? 0.97 : 0]));
      },
    };
    const { runtime, entityId } = seedRuntime(root, retriever);
    const result = await runtime.entitySearchRecallHybrid({ query: 'zero lexical overlap identity phrase' });
    expect(result[0]).toEqual(expect.objectContaining({ entity_id: entityId }));
    expect(existingCalls).toBe(1);
    expect(refreshCalls).toBe(0);
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
