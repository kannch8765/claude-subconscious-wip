import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DashScopeQwenEmbeddingProvider,
  FileBackedSemanticRetriever,
  RelationshipMemoryResolutionControlPlane,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  type AssistantRememberIntentRecord,
  type CanonicalMessage,
  type EmbeddingProvider,
  type SearchQuery,
  type SemanticRetriever,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING;
  delete process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE;
  vi.restoreAllMocks();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-search-many-'));
  dirs.push(dir);
  return dir;
}

// Made-up vocabulary only: this repo is public.
const WORDS = ['amber', 'basil', 'cobalt', 'dune', 'ember', 'fennel', 'garnet', 'hazel', 'indigo', 'juniper', 'kelp', 'lilac', 'moss', 'nutmeg'];
const DIMENSIONS = 16;
const UNIT_START = Date.UTC(2026, 2, 1);

function day(offset: number): string {
  return new Date(UNIT_START + offset * 86_400_000).toISOString();
}

/** Bag-of-words vector: texts that share words point the same way, so the semantic score carries signal. */
function vectorFor(text: string): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0.01);
  for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    vector[crypto.createHash('sha256').update(token).digest().readUInt8(0) % DIMENSIONS] += 1;
  }
  return vector;
}

type QueryMode = 'ok' | 'fail' | 'hang' | 'bad_vector';
/** How the rows of a successful response are laid out; only 'ok', 'reversed' and 'no_index' are well formed. */
type RowShape = 'ok' | 'reversed' | 'no_index' | 'duplicate_index' | 'out_of_range' | 'extra_row' | 'string_index' | 'fractional_index' | 'null_index';

function shapeRows(rows: Array<{ text_index: number; embedding: number[] }>, shape: RowShape): unknown[] {
  switch (shape) {
    case 'ok': return rows;
    case 'reversed': return [...rows].reverse();
    case 'no_index': return rows.map(({ embedding }) => ({ embedding }));
    case 'duplicate_index': return rows.map(({ embedding }) => ({ text_index: 0, embedding }));
    case 'out_of_range': return rows.map((row, index) => index === rows.length - 1 ? { ...row, text_index: rows.length } : row);
    case 'extra_row': return [...rows, { text_index: rows.length, embedding: rows[0].embedding }];
    // Reversed rows whose explicit index is not an integer: read as "absent", row position would swap the vectors.
    case 'string_index': return [...rows].reverse().map((row) => ({ ...row, text_index: String(row.text_index) }));
    case 'fractional_index': return [...rows].reverse().map((row) => ({ ...row, text_index: row.text_index + 0.25 }));
    case 'null_index': return [...rows].reverse().map((row) => ({ ...row, text_index: null }));
  }
}

/** A fetch for the real DashScope provider that never leaves the process and counts every request. */
function fakeDashScope() {
  const state = {
    mode: 'ok' as QueryMode,
    queryShape: 'ok' as RowShape,
    documentShape: 'ok' as RowShape,
    /** Fail only from this query request on (1-based), when mode is 'fail'. */
    failFromRequest: 1,
    documentRequests: [] as string[][],
    queryRequests: [] as string[][],
    abortObserved: false,
  };
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const texts: string[] = body.input.texts;
    if (body.parameters.text_type === 'document') state.documentRequests.push(texts);
    else state.queryRequests.push(texts);
    const isQuery = body.parameters.text_type === 'query';
    if (isQuery && state.mode === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => { state.abortObserved = true; reject(init.signal!.reason instanceof Error ? init.signal!.reason : new Error('aborted')); };
        if (init.signal!.aborted) onAbort();
        else init.signal!.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (isQuery && state.mode === 'fail' && state.queryRequests.length >= state.failFromRequest) {
      return new Response(JSON.stringify({ code: 'InternalError', message: 'synthetic failure' }), { status: 500 });
    }
    const embeddings = texts.map((text, index) => ({
      text_index: index,
      embedding: isQuery && state.mode === 'bad_vector' ? [1, 2] : vectorFor(text),
    }));
    const shaped = shapeRows(embeddings, isQuery ? state.queryShape : state.documentShape);
    return new Response(JSON.stringify({ output: { embeddings: shaped } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

function userEvent(id: string, capturedAt: string, quote: string): CanonicalMessage {
  return {
    conversation_id: 'conv-many', message_id: `msg-${id}`, role: 'user', quote, captured_at: capturedAt,
    evidence_id: `ev-${id}`, event_kind: 'user_text', block_index: 0,
  };
}

const PREFERENCES = Array.from({ length: 24 }, (_, index) => {
  const first = WORDS[index % WORDS.length];
  const second = WORDS[(index * 5 + 3) % WORDS.length];
  return { index, first, second, at: day(index) };
});

const EVENTS: CanonicalMessage[] = [
  ...PREFERENCES.map(({ index, first, second, at }) => userEvent(`pref-${index}`, at, `I keep a jar of ${first} next to the ${second} tin.`)),
  ...PREFERENCES.filter(({ index }) => index % 4 === 0).map(({ index, first, at }) => userEvent(`again-${index}`, day(index + 40), `Still reaching for the ${first} jar every morning.`)),
  userEvent('club-first', day(50), 'The lantern club meets on Mondays now.'),
  userEvent('club-changed', day(60), 'The lantern club moved its meetings to Thursdays.'),
  userEvent('late', day(70), 'A fresh note about saffron moss kept after the index was built.'),
  userEvent('kite-a', day(30), 'Flying the paper kite at the windy pier is my favourite.'),
  userEvent('kite-b', day(31), 'Nothing beats a paper kite over the windy pier.'),
  userEvent('pebble', day(32), 'I collect striped pebbles from the shore path.'),
];
const INTENT: AssistantRememberIntentRecord = {
  schema_version: 1, intent_id: 'intent-pebble', subject_id: 'subject', session_id: 'session-many',
  assistant_message_id: 'assistant-pebble', tool_use_id: 'tool-pebble', tool_name: 'remember',
  memory: { text: 'Striped pebble collecting walks' }, feel: { text: 'Glad to hear about the pebbles' },
  captured_at: day(32),
};
const TOPIC = 'Lantern club meeting day';

interface Fixture {
  root: string;
  indexFile: string;
  store: RelationshipMemoryStore;
  runtime: RelationshipMemoryRuntime;
  lexicalRuntime: RelationshipMemoryRuntime;
  dashScope: ReturnType<typeof fakeDashScope>;
  provider: DashScopeQwenEmbeddingProvider;
  retriever: FileBackedSemanticRetriever;
  worldId: string;
  preferenceIds: string[];
  kiteIds: string[];
  pebbleId: string;
}

async function fixture(): Promise<Fixture> {
  const root = tempDir();
  const storeDir = path.join(root, 'store');
  const indexFile = path.join(root, 'semantic-index', 'index.json');
  const store = new RelationshipMemoryStore(storeDir, 'subject');
  store.appendAssistantIntent(INTENT);
  const intents = new Map([[INTENT.intent_id, INTENT]]);
  const dashScope = fakeDashScope();
  const provider = new DashScopeQwenEmbeddingProvider({ apiKey: 'test-key', dimensions: DIMENSIONS, fetchFn: dashScope.fetchFn });
  const retriever = new FileBackedSemanticRetriever(provider, indexFile);
  const clock = { now: day(80) };
  const messages = new Map(EVENTS.map((item) => [item.evidence_id!, item]));
  const runtime = new RelationshipMemoryRuntime(store, messages, () => clock.now, intents, false, retriever);

  const preferenceIds = PREFERENCES.map(({ index, first, second }) => {
    const result = runtime.rememberKind(`batch-pref-${index}`, 'user_preference', {
      summary: `Keeps ${first} beside ${second}`, participants: ['user'], evidence_ids: [`ev-pref-${index}`],
      payload: { topic: `${first} jar`, preference: `${first} next to ${second}` },
    });
    expect(result.outcome).toBe('accepted');
    return result.memory_id!;
  });
  for (const { index } of PREFERENCES.filter(({ index }) => index % 4 === 0)) {
    expect(runtime.reinforce(`batch-again-${index}`, { memory_id: preferenceIds[index], evidence_ids: [`ev-again-${index}`] }).outcome).toBe('accepted');
  }
  const world = runtime.rememberKind('batch-club-1', 'world_update', {
    summary: 'When the lantern club meets', participants: ['user'], evidence_ids: ['ev-club-first'],
    payload: { topic: TOPIC, fact: 'The lantern club meets on Mondays', domain: 'hobby' },
  });
  expect(world.outcome).toBe('accepted');
  expect(runtime.worldUpdate('batch-club-2', { memory_id: world.memory_id!, fact: 'The lantern club meets on Thursdays', evidence_ids: ['ev-club-changed'] }).outcome).toBe('accepted');
  // Two memories of one meaning, merged by the owner into one card with two source ids.
  const kiteIds = ['kite-a', 'kite-b'].map((id, index) => {
    const result = runtime.rememberKind(`batch-${id}`, 'user_preference', {
      summary: index === 0 ? 'Loves flying a paper kite at the pier' : 'Paper kite over the windy pier', participants: ['user'], evidence_ids: [`ev-${id}`],
      payload: { topic: 'paper kite', preference: index === 0 ? 'kite flying at the windy pier' : 'a paper kite over the pier' },
    });
    expect(result.outcome).toBe('accepted');
    return result.memory_id!;
  });
  const review = runtime.suggestMaintenanceReview('batch-kite-review', 'relation', { memory_ids: kiteIds, relation: 'same_meaning', reason: 'one kite habit' });
  new RelationshipMemoryResolutionControlPlane(store, () => clock.now).resolveReview(review.review_id!, { resolution_id: 'res-kite', relation: 'same_meaning', target_memory_id: kiteIds[0] });
  // Remembered through a trusted assistant intent: linked intent text and the owner boost.
  const pebble = runtime.rememberKind('batch-pebble', 'user_preference', {
    summary: 'Collects striped pebbles', participants: ['user'], evidence_ids: ['ev-pebble'], assistant_intent_id: INTENT.intent_id,
    payload: { topic: 'pebbles', preference: 'striped pebbles from the shore path' },
  });
  expect(pebble.outcome).toBe('accepted');
  await runtime.prepareCurrentMemorySemanticIndex();
  // Written after the index was built: no vector, so it can only match lexically.
  expect(runtime.rememberKind('batch-late', 'user_preference', {
    summary: 'Keeps saffron moss notes', participants: ['user'], evidence_ids: ['ev-late'],
    payload: { topic: 'saffron moss', preference: 'saffron moss notes' },
  }).outcome).toBe('accepted');

  dashScope.state.documentRequests.length = 0;
  dashScope.state.queryRequests.length = 0;
  const lexicalRuntime = new RelationshipMemoryRuntime(store, messages, () => clock.now, intents, false);
  return { root, indexFile, store, runtime, lexicalRuntime, dashScope, provider, retriever, worldId: world.memory_id!, preferenceIds, kiteIds, pebbleId: pebble.memory_id! };
}

async function singles(runtime: RelationshipMemoryRuntime, queries: readonly SearchQuery[], signal?: AbortSignal) {
  const lists = [];
  for (const query of queries) lists.push(await runtime.memorySearchRecallHybridWithEvidence(query, signal));
  return lists;
}

function queryList(count: number): SearchQuery[] {
  return Array.from({ length: count }, (_, index) => ({ query: `${WORDS[index % WORDS.length]} ${WORDS[(index + 6) % WORDS.length]} tin`, limit: 6 }));
}

function filesUnder(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return files;
}

function cooldownFile(f: Fixture): string {
  return `${f.indexFile}.provider-cooldown.${f.provider.fingerprint}.json`;
}

describe('memorySearchRecallHybridManyWithEvidence', () => {
  it.each([1, 4, 11])('returns the single-call result for each of %i queries, with one query request per maxBatchSize chunk', async (count) => {
    const f = await fixture();
    expect(f.provider.maxBatchSize).toBe(10);
    const queries = queryList(count);

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);
    const manyRequests = f.dashScope.state.queryRequests.splice(0);
    const single = await singles(f.runtime, queries);

    expect(many).toEqual(single);
    expect(many.every((list) => list.length > 0)).toBe(true);
    // The semantic scores took part: a lexical-only search gives different lists.
    expect(many).not.toEqual(await singles(f.lexicalRuntime, queries));
    expect(manyRequests.map((texts) => texts.length)).toEqual(count <= 10 ? [count] : [10, count - 10]);
    expect(manyRequests.flat()).toEqual(queries.map((query) => query.query));
    expect(f.dashScope.state.queryRequests).toHaveLength(count);
    expect(f.dashScope.state.documentRequests).toEqual([]);
  });

  it('serves the world_update head only, without revisions, quoting only head evidence, as the single call does', async () => {
    const f = await fixture();
    // The no-query list comes first: evidence is attached to the first copy of each memory id.
    const queries: SearchQuery[] = [{ kind: 'world_update' }, { query: 'lantern club' }, { query: 'amber jar' }];

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(many).toEqual(await singles(f.runtime, queries));
    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence([queries[1], queries[0]])).toEqual(await singles(f.runtime, [queries[1], queries[0]]));
    for (const list of [many[0], many[1]]) {
      const hit = list.find((memory) => memory.memory_id === f.worldId)!;
      expect(hit.payload.fact).toBe('The lantern club meets on Thursdays');
      expect(hit.world_update).toEqual(expect.objectContaining({ revision_count: 2, head: expect.objectContaining({ fact: 'The lantern club meets on Thursdays' }) }));
      expect(hit.world_update).not.toHaveProperty('revisions');
      expect(JSON.stringify(hit)).not.toContain('Mondays');
      expect(hit.quote_snippets.map((snippet) => snippet.quote)).toEqual(['The lantern club moved its meetings to Thursdays.']);
    }
  });

  it('serves a merged pair as one card and keeps the linked intent and owner boost, as the single call does', async () => {
    const f = await fixture();
    const queries: SearchQuery[] = [
      { query: 'paper kite pier' },
      { query: 'striped pebbles' },
      { query: 'pebble walks', trigger: 'glad to hear' },
      { query: 'paper kite', excludeMemoryIds: [f.kiteIds[1]] },
      { kind: 'user_preference', time_start: day(29) },
    ];

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(many).toEqual(await singles(f.runtime, queries));
    const kite = many[0].find((memory) => memory.memory_id === f.kiteIds[0])!;
    expect(kite.resolution_source_memory_ids).toEqual(expect.arrayContaining(f.kiteIds));
    expect(many[0].map((memory) => memory.memory_id)).not.toContain(f.kiteIds[1]);
    expect(kite.quote_snippets.map((snippet) => snippet.quote).sort()).toEqual([
      'Flying the paper kite at the windy pier is my favourite.', 'Nothing beats a paper kite over the windy pier.',
    ]);
    expect(many[1][0].memory_id).toBe(f.pebbleId);
    // The trigger matches only the linked intent's feel text.
    expect(many[2].map((memory) => memory.memory_id)).toEqual([f.pebbleId]);
    // Excluding either source id hides the merged card.
    expect(many[3].map((memory) => memory.memory_id)).not.toContain(f.kiteIds[0]);
    expect(many[4].map((memory) => memory.memory_id)).toEqual(expect.arrayContaining([f.kiteIds[0], f.pebbleId]));
  });

  it('applies kind, participant, trigger, linked memory, time range and excluded ids per query in one call', async () => {
    const f = await fixture();
    const queries: SearchQuery[] = [
      { query: 'amber jar', kind: 'user_preference', excludeMemoryIds: [f.preferenceIds[0]] },
      { query: 'amber jar', time_start: day(3), time_end: day(12) },
      { query: 'lantern club', kind: 'world_update' },
      { query: 'jar', trigger: 'basil', participant: 'user', limit: 3 },
      { query: 'jar', linked_memory_id: 'memory_none' },
      { kind: 'user_preference', time_end: day(5) },
    ];

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(many).toEqual(await singles(f.runtime, queries));
    expect(many[0].map((memory) => memory.memory_id)).not.toContain(f.preferenceIds[0]);
    expect(many[1].every((memory) => memory.observed_at >= day(3) && memory.observed_at <= day(12))).toBe(true);
    expect(many[2].map((memory) => memory.kind)).toEqual(['world_update']);
    expect(many[3].length).toBeGreaterThan(0);
    expect(many[3].every((memory) => JSON.stringify(memory.payload).includes('basil'))).toBe(true);
    expect(many[4]).toEqual([]);
    expect(many[5].length).toBeGreaterThan(0);
  });

  it('treats an empty, blank or missing query like the single call and leaves it out of the embedding request', async () => {
    const f = await fixture();
    const queries: SearchQuery[] = [{ query: '' }, { query: 'amber jar' }, { query: '   ' }, {}, { query: '  cobalt tin  ' }];

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(f.dashScope.state.queryRequests.splice(0)).toEqual([['amber jar', 'cobalt tin']]);
    expect(many).toEqual(await singles(f.runtime, queries));
    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence([{ query: ' ' }, {}])).toEqual(await singles(f.runtime, [{ query: ' ' }, {}]));
    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence([])).toEqual([]);
  });

  it('embeds a repeated query text once and gives both positions the single-call result', async () => {
    const f = await fixture();
    const queries: SearchQuery[] = [{ query: 'amber jar' }, { query: 'amber jar', limit: 2 }];

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(f.dashScope.state.queryRequests.splice(0)).toEqual([['amber jar']]);
    expect(many).toEqual(await singles(f.runtime, queries));
    // Separate objects per list, down to nested fields, as separate single calls would give.
    expect(many[1][0]).not.toBe(many[0][0]);
    expect(many[1][0].payload).not.toBe(many[0][0].payload);
    expect(many[1][0].participants).not.toBe(many[0][0].participants);
    expect(many[1][0].quote_snippets[0]).not.toBe(many[0][0].quote_snippets[0]);
  });

  it.each(['fail', 'bad_vector'] as const)('falls back to lexical for every query when the batch embedding %s, as each single call does', async (mode) => {
    const f = await fixture();
    const queries = queryList(4);
    const lexical = await singles(f.lexicalRuntime, queries);
    f.dashScope.state.mode = mode;

    const many = await f.runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(f.dashScope.state.queryRequests).toHaveLength(1);
    expect(many).toEqual(lexical);
    expect(fs.existsSync(cooldownFile(f))).toBe(true);
    // The single call with the same failure, from a clean cooldown state, falls back the same way.
    fs.rmSync(cooldownFile(f));
    expect(await f.runtime.memorySearchRecallHybridWithEvidence(queries[0])).toEqual(lexical[0]);
    expect(fs.existsSync(cooldownFile(f))).toBe(true);
    // While the cooldown holds, nothing is sent and the many call still falls back.
    f.dashScope.state.queryRequests.length = 0;
    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence(queries)).toEqual(lexical);
    expect(f.dashScope.state.queryRequests).toEqual([]);
  });

  it('falls back to lexical for every query when a later chunk fails', async () => {
    const f = await fixture();
    const queries = queryList(11);
    const lexical = await singles(f.lexicalRuntime, queries);
    f.dashScope.state.mode = 'fail';
    f.dashScope.state.failFromRequest = 2;

    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence(queries)).toEqual(lexical);
    expect(f.dashScope.state.queryRequests.map((texts) => texts.length)).toEqual([10, 1]);
  });

  it('aborts the in-flight embedding request, writes no cooldown and returns the lexical fallback, as the single call does', async () => {
    const f = await fixture();
    const queries = queryList(4);
    const lexical = await singles(f.lexicalRuntime, queries);
    f.dashScope.state.mode = 'hang';
    const controller = new AbortController();

    const pending = f.runtime.memorySearchRecallHybridManyWithEvidence(queries, controller.signal);
    setTimeout(() => controller.abort(new Error('recall cancelled')), 10);

    expect(await pending).toEqual(lexical);
    expect(f.dashScope.state.abortObserved).toBe(true);
    expect(f.dashScope.state.queryRequests).toHaveLength(1);
    expect(fs.existsSync(cooldownFile(f))).toBe(false);
    // An already aborted signal behaves the same, for the single call too.
    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence(queries, controller.signal)).toEqual(lexical);
    expect(await singles(f.runtime, queries, controller.signal)).toEqual(lexical);
    expect(fs.existsSync(cooldownFile(f))).toBe(false);
  });

  it('builds the candidate set and attaches evidence once per call, reading the store as often as one single call', async () => {
    const f = await fixture();
    const spies = {
      reinforcements: vi.spyOn(f.store, 'listReinforcements'),
      memories: vi.spyOn(f.store, 'listMemories'),
      resolutions: vi.spyOn(f.store, 'listActiveMemoryResolutions'),
      evidence: vi.spyOn(f.store, 'listEvidenceForMemoryIds'),
      attach: vi.spyOn(f.runtime as any, 'attachRecallEvidence'),
    };
    const counts = () => Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]));
    const reset = () => Object.values(spies).forEach((spy) => spy.mockClear());

    await f.runtime.memorySearchRecallHybridWithEvidence(queryList(1)[0]);
    const single = counts();
    reset();
    await f.runtime.memorySearchRecallHybridManyWithEvidence(queryList(4));

    expect(counts()).toEqual(single);
    expect(counts()).toEqual(expect.objectContaining({ reinforcements: 1, memories: 1, attach: 1 }));
  });

  it('writes nothing to disk: no store write, no index rewrite, no new file', async () => {
    const f = await fixture();
    const before = filesUnder(f.root);

    await f.runtime.memorySearchRecallHybridManyWithEvidence(queryList(11));

    expect(filesUnder(f.root)).toEqual(before);
    expect(f.dashScope.state.documentRequests).toEqual([]);
  });

  it('emits one timing segment for the batched embedding request and the per-query comparison segments', async () => {
    const f = await fixture();
    const timingFile = path.join(f.root, 'timing.jsonl');
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING = '1';
    process.env.RELATIONSHIP_MEMORY_RECALL_TIMING_FILE = timingFile;

    await f.runtime.memorySearchRecallHybridManyWithEvidence([...queryList(4), { query: ' ' }]);

    const events = fs.readFileSync(timingFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.filter((event) => event.segment === 'semantic_query_embedding_external_batch')).toEqual([
      expect.objectContaining({ query_count: 4, request_count: 1, usable_document_union_count: 27 }),
    ]);
    expect(events.filter((event) => event.segment === 'semantic_query_embedding_external')).toEqual([]);
    expect(events.filter((event) => event.segment === 'semantic_local_vector_comparison')).toHaveLength(4);
  });

  it('falls back to rankExisting per query for a retriever without rankExistingMany', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const plain: SemanticRetriever = {
      rank: async () => { throw new Error('unexpected refresh'); },
      rankExisting: async (documents, query, signal) => {
        calls.push(query);
        if (query.includes('cobalt')) throw new Error('synthetic failure');
        return f.retriever.rankExisting(documents, query, signal);
      },
    };
    const runtime = new RelationshipMemoryRuntime(f.store, f.runtime.messages, f.runtime.now, new Map(), false, plain);
    const queries = [...queryList(4), { query: 'cobalt tin' }];

    expect(await runtime.memorySearchRecallHybridManyWithEvidence(queries)).toEqual(await singles(runtime, queries));
    expect(calls.slice(0, 5)).toEqual(queries.map((query) => query.query));
  });
});

describe('query vectors land on their own query', () => {
  it.each(['reversed', 'no_index'] as const)('maps a well-formed %s response to the right inputs', async (shape) => {
    const f = await fixture();
    const queries = queryList(4);
    const expected = await singles(f.runtime, queries);
    f.dashScope.state.queryShape = shape;

    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence(queries)).toEqual(expected);
    expect(await f.provider.embedQueries(['amber jar', 'cobalt tin'])).toEqual([vectorFor('amber jar'), vectorFor('cobalt tin')]);
    expect(fs.existsSync(cooldownFile(f))).toBe(false);
  });

  it.each(['duplicate_index', 'out_of_range', 'extra_row', 'string_index', 'fractional_index', 'null_index'] as const)('refuses a %s response, so no query takes another query\'s vector', async (shape) => {
    const f = await fixture();
    const queries = queryList(2);
    const lexical = await singles(f.lexicalRuntime, queries);
    f.dashScope.state.queryShape = shape;

    await expect(f.provider.embedQueries(['amber jar', 'cobalt tin'])).rejects.toThrow('invalid vector payload');
    expect(await f.runtime.memorySearchRecallHybridManyWithEvidence(queries)).toEqual(lexical);
    expect(fs.existsSync(cooldownFile(f))).toBe(true);
  });

  it('refuses a malformed document response without writing the index', async () => {
    const f = await fixture();
    const before = fs.readFileSync(f.indexFile, 'utf8');
    f.dashScope.state.documentShape = 'duplicate_index';

    await expect(f.provider.embedDocuments(['amber one', 'basil two'])).rejects.toThrow('invalid vector payload');
    await expect(f.retriever.prepare([{ id: 'n1', text: 'amber one' }, { id: 'n2', text: 'basil two' }])).rejects.toThrow('invalid vector payload');
    expect(fs.readFileSync(f.indexFile, 'utf8')).toBe(before);
  });
});

describe('separate query requests (provider without embedQueries)', () => {
  it('keeps the queries whose request succeeded and falls back only for the failed one, as parallel single calls do', async () => {
    const f = await fixture();
    const sent: string[] = [];
    // Same fingerprint and vectors as the fixture's provider, so it ranks against the fixture's index.
    const provider: EmbeddingProvider = {
      fingerprint: f.provider.fingerprint, model: 'plain', dimensions: DIMENSIONS, maxBatchSize: 10,
      embedDocuments: async (texts) => texts.map(vectorFor),
      embedQuery: async (text) => {
        sent.push(text);
        if (text.includes('cobalt')) throw new Error('synthetic failure');
        return vectorFor(text);
      },
    };
    const runtime = new RelationshipMemoryRuntime(f.store, f.runtime.messages, f.runtime.now, new Map(), false, new FileBackedSemanticRetriever(provider, f.indexFile));
    const queries: SearchQuery[] = [{ query: 'amber jar', limit: 12 }, { query: 'cobalt tin', limit: 12 }];
    const lexical = await singles(f.lexicalRuntime, queries);

    const many = await runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(sent).toEqual(['amber jar', 'cobalt tin']);
    expect(many[1]).toEqual(lexical[1]);
    expect(many[0]).not.toEqual(lexical[0]);
    expect(fs.existsSync(cooldownFile(f))).toBe(true);
    // Parallel single calls from a clean cooldown state give the same lists.
    fs.rmSync(cooldownFile(f));
    expect(many).toEqual(await Promise.all(queries.map((query) => runtime.memorySearchRecallHybridWithEvidence(query))));
  });
});

describe('separate query requests: failures stay inside their own query', () => {
  function splitProvider(f: Fixture, failure: 'sync_throw' | 'reject'): EmbeddingProvider {
    return {
      fingerprint: f.provider.fingerprint, model: 'plain', dimensions: DIMENSIONS, maxBatchSize: 10,
      embedDocuments: async (texts) => texts.map(vectorFor),
      // Promise-returning but not async: the failure can be a synchronous throw.
      embedQuery: (text: string) => {
        if (text.includes('cobalt')) {
          if (failure === 'sync_throw') throw new Error('synthetic synchronous failure');
          return Promise.reject(new Error('synthetic failure'));
        }
        return Promise.resolve(vectorFor(text));
      },
    };
  }
  const queries: SearchQuery[] = [{ query: 'amber jar', limit: 12 }, { query: 'cobalt tin', limit: 12 }];

  it('isolates a synchronous throw and still writes the cooldown, as parallel single calls do', async () => {
    const f = await fixture();
    const runtime = new RelationshipMemoryRuntime(f.store, f.runtime.messages, f.runtime.now, new Map(), false, new FileBackedSemanticRetriever(splitProvider(f, 'sync_throw'), f.indexFile));
    const lexical = await singles(f.lexicalRuntime, queries);

    const many = await runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(many[0]).not.toEqual(lexical[0]);
    expect(many[1]).toEqual(lexical[1]);
    expect(fs.existsSync(cooldownFile(f))).toBe(true);
    fs.rmSync(cooldownFile(f));
    expect(many).toEqual(await Promise.all(queries.map((query) => runtime.memorySearchRecallHybridWithEvidence(query))));
  });

  it('keeps the successful query when the failed query cannot write its cooldown', async () => {
    const f = await fixture();
    const runtime = new RelationshipMemoryRuntime(f.store, f.runtime.messages, f.runtime.now, new Map(), false, new FileBackedSemanticRetriever(splitProvider(f, 'reject'), f.indexFile));
    const lexical = await singles(f.lexicalRuntime, queries);
    // A directory where the cooldown file goes: reading it finds no cooldown, and writing it fails.
    fs.mkdirSync(cooldownFile(f));

    const many = await runtime.memorySearchRecallHybridManyWithEvidence(queries);

    expect(many[0]).not.toEqual(lexical[0]);
    expect(many[1]).toEqual(lexical[1]);
    expect(fs.statSync(cooldownFile(f)).isDirectory()).toBe(true);
    expect(many).toEqual(await Promise.all(queries.map((query) => runtime.memorySearchRecallHybridWithEvidence(query))));
  });
});

describe('FileBackedSemanticRetriever.rankExistingMany', () => {
  it('equals rankExisting per request, with the same vectors, for missing, stale and shared documents', async () => {
    const f = await fixture();
    const documents = [
      { id: 'd1', text: 'amber jar beside basil' },
      { id: 'd2', text: 'cobalt tin and dune' },
      { id: 'd3', text: 'ember fennel garnet' },
    ];
    await f.retriever.prepare(documents);
    const requests = [
      { documents, query: 'amber jar' },
      { documents: [documents[1], { id: 'missing', text: 'never indexed' }], query: 'cobalt tin' },
      { documents: [{ id: 'd3', text: 'changed text, stale vector' }], query: 'ember' },
      { documents: [], query: 'amber jar' },
      { documents, query: '  ' },
      { documents: documents.slice(0, 2), query: 'amber jar' },
    ];
    f.dashScope.state.queryRequests.length = 0;

    const many = await f.retriever.rankExistingMany(requests);

    expect(f.dashScope.state.queryRequests).toEqual([['amber jar', 'cobalt tin']]);
    const single = [];
    for (const request of requests) single.push(await f.retriever.rankExisting(request.documents, request.query));
    expect(many.map((scores) => [...scores])).toEqual(single.map((scores) => [...scores]));
    expect(many[0].size).toBe(3);
    expect(many[2].size).toBe(0);
  });

  it('uses embedQuery per distinct text for a provider without embedQueries', async () => {
    const root = tempDir();
    const queries: string[] = [];
    const provider: EmbeddingProvider = {
      fingerprint: 'plain-provider-v1', model: 'plain', dimensions: DIMENSIONS, maxBatchSize: 10,
      embedDocuments: async (texts) => texts.map(vectorFor),
      embedQuery: async (text) => { queries.push(text); return vectorFor(text); },
    };
    const retriever = new FileBackedSemanticRetriever(provider, path.join(root, 'index.json'));
    const documents = [{ id: 'd1', text: 'amber jar' }, { id: 'd2', text: 'cobalt tin' }];
    await retriever.prepare(documents);

    const many = await retriever.rankExistingMany([{ documents, query: 'amber' }, { documents, query: 'cobalt' }, { documents, query: 'amber' }]);

    expect(queries).toEqual(['amber', 'cobalt']);
    expect(many.map((scores) => [...scores])).toEqual([
      [...await retriever.rankExisting(documents, 'amber')],
      [...await retriever.rankExisting(documents, 'cobalt')],
      [...await retriever.rankExisting(documents, 'amber')],
    ]);
  });
});
