import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackedSemanticRetriever } from '../relationship-memory/src/retrieval/index.js';
import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import type { ChatTransport, TransportReply } from './llm.js';
import { harnessTools, runAsyncPass, type PassInput } from './pass.js';
import { runSyncPass, runSyncPassSettled, type SyncInput } from './sync_pass.js';
import { asyncTrust, syncTrust, toAsyncTrace, toCrashTrace, toSyncTrace, traceHeader, TRACE_TOOL_NAMES } from './trace.js';

/** Made up; it goes everywhere content can enter and must never come out in a trace. */
const S = 'ZZ_SENTINEL_7f3';
const NOW = '2026-10-10T00:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An error class whose name is itself the sentinel. */
const SentinelError = { [S]: class extends Error {} }[S];

function message(id: string, extra: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return { conversation_id: 'conv-1', message_id: `msg-${id}`, evidence_id: id, role: 'user', quote: `${S} 测试消息`, captured_at: NOW, event_kind: 'user_text', ...extra };
}

const INTENT: AssistantRememberIntentRecord = {
  schema_version: 1, intent_id: 'intent-1', subject_id: 'local-user', session_id: 'conv-1', assistant_message_id: 'msg-a1', tool_use_id: 'tool-1',
  tool_name: 'remember', memory: { text: `${S} 测试意图` }, feel: { text: `${S} 测试感受` }, captured_at: NOW,
};

function provider() {
  return {
    model: 'm', dimensions: 2, maxBatchSize: 10, fingerprint: 'fp',
    async embedDocuments(texts: string[]): Promise<number[][]> { return texts.map(() => [0.3, 0.4]); },
    async embedQuery(): Promise<number[]> { return [0.3, 0.4]; },
  };
}

/**
 * A real store in a tmp dir with one seed memory (content full of the sentinel), a fake embedder, and the batch:
 * canonical messages (one a tool result), one remember intent.
 */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
  dirs.push(root);
  const indexFile = path.join(root, 'index', 'index.json');
  fs.mkdirSync(path.dirname(indexFile));
  fs.writeFileSync(indexFile, JSON.stringify({ schema_version: 1, provider_fingerprint: 'fp', documents: {} }));
  const store = new RelationshipMemoryStore(path.join(root, 'store'), 'local-user');
  const retriever = () => new FileBackedSemanticRetriever(provider() as any, indexFile);

  const seed = new RelationshipMemoryRuntime(store, new Map([['ev-seed', message('ev-seed')]]), () => NOW, new Map(), true, retriever());
  store.beginBatch('seed', NOW);
  const seeded = seed.rememberKind('seed', 'inside_joke', {
    summary: `测试笑话 ${S}`, participants: ['user', 'assistant'], evidence_ids: ['ev-seed'],
    payload: { name: S, meaning: `测试含义 ${S}`, trigger_phrases: [S] },
  });
  seed.finalizeBatch('seed', true);
  expect(seeded.outcome).toBe('accepted');
  await seed.prepareCurrentMemorySemanticIndex();
  store.appendAssistantIntent(INTENT);

  const canonical = [message('ev-1'), message('ev-2'), message('ev-3', { role: 'assistant', event_kind: 'tool_result', tool_name: S })];
  const runtime = new RelationshipMemoryRuntime(store, new Map(canonical.map((m) => [m.evidence_id!, m])), () => new Date().toISOString(), new Map([[INTENT.intent_id, INTENT]]), true, retriever());
  const input: PassInput = {
    batchId: 'batch-1', sessionId: 'conv-1', latestUserMessage: `${S} 测试`, canonicalMessages: canonical, assistantIntents: [INTENT],
    sessionKnownMemoryIds: [], recentSeen: [{ memory_id: seeded.memory_id!, summary: S }], sessionCard: S,
  };
  const syncInput: SyncInput = {
    batchId: 'batch-1', sessionId: 'conv-1', latestUserMessage: `${S} 测试`, previousUserMessage: S, previousKohakuReply: S, sessionKnownMemoryIds: [],
  };
  return { store, runtime, input, syncInput, seedId: seeded.memory_id! };
}

type Call = { name: string; args: unknown };
/** One model reply: tool calls (string args are sent raw), or text, or a provider failure. */
interface Reply { calls?: Call[]; content?: string; status?: unknown; ms?: unknown; usage?: unknown; delayMs?: number; throws?: unknown }

function reply(r: Reply): TransportReply {
  const message = {
    role: 'assistant', content: r.content ?? S, reasoning_content: S,
    ...(r.calls?.length ? { tool_calls: r.calls.map((c, n) => ({ id: `${S}-${n}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })) } : {}),
  };
  const status = (r.status ?? 200) as number;
  const usage = r.usage ?? { prompt_tokens: 10, completion_tokens: 1 };
  return { status, ms: (r.ms ?? 1) as number, error: S, body: status === 200 ? { choices: [{ message }], usage } : { error: S, usage } };
}

/** The async pass: replies in order (the last one repeats). */
function scripted(replies: Reply[]): ChatTransport {
  let i = 0;
  return {
    async chat() {
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r.throws) throw r.throws;
      if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
      return reply(r);
    },
  };
}

/** The sync pass: one reply for the phrase call and one for the gate. */
function syncModel(phrase: Reply, gate: Reply): ChatTransport {
  return {
    async chat(body) {
      const r = String(body.messages.at(-1)?.content).includes('Candidate memories') ? gate : phrase;
      if (r.throws) throw r.throws;
      if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
      return reply(r);
    },
  };
}

/** chat() backs off 1 + 2 + 4 s on 429/5xx; run the pass with fake timers instead of waiting. */
async function withoutBackoff<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const promise = run();
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) await vi.advanceTimersByTimeAsync(1_000);
  vi.useRealTimers();
  return promise;
}

/** The sentinel reached the research record (so the path carried content), and the trace holds none of it. */
function expectClean(trace: unknown, record?: unknown): void {
  if (record !== undefined) expect(JSON.stringify(record)).toContain(S);
  expect(JSON.stringify(trace)).not.toContain(S);
  expect(JSON.stringify(trace)).not.toContain('SENTINEL');
}

const search: Call = { name: 'memory_search', args: { queries: [S, '测试笑话'], kind: 'inside_joke' } };

describe('async trace', () => {
  it('normal pass: keeps the ids that resolve, and nothing of the content', async () => {
    const { store, runtime, input, seedId } = await setup();
    const result = await runAsyncPass(runtime, scripted([
      { calls: [search, { name: 'entity_search', args: { query: S } }] },
      { calls: [
        { name: 'deliver_whisper', args: { memory_id: seedId, quotes: [1] } },
        { name: 'memory_reinforce', args: { memory_id: seedId, evidence_ids: ['ev-1'], assistant_intent_id: 'intent-1' } },
        { name: 'memory_remember', args: { kind: 'shared_experience', summary: `测试新记忆 ${S}`, participants: ['user'], evidence_ids: ['ev-2'], payload: { title: S, event: `测试事件 ${S}`, shared_meaning: `测试意义 ${S}` } } },
        { name: 'entity_remember', args: { canonical_name: S, aliases: [S], entity_type: 'other', description: `测试描述 ${S}`, evidence_ids: ['ev-1'] } },
      ] },
    ]), input, { model: 'm', maxSteps: 4 });
    const trace = toAsyncTrace(result, asyncTrust(store, input, { at: NOW, wallMs: 12 }));

    expect(result.succeeded).toBe(true);
    const created = result.decisions.remember[0].memory_id!;
    expect(trace).toMatchObject({
      schema_version: 1, lane: 'async', crashed: false, batch_id: 'batch-1', session_id: 'conv-1', at: NOW, wall_ms: 12,
      completion: 'completed', succeeded: true, whisper: 'selected', whisper_memory_id: seedId, whisper_quotes: 1,
      reinforce: [{ outcome: 'accepted', memory_id: seedId, evidence_ids: ['ev-1'], assistant_intent_id: 'intent-1', unresolved_ids: 0 }],
      remember: [{ kind: 'shared_experience', outcome: 'accepted', memory_id: created, unresolved_ids: 0 }],
      intents: { catalog: 1, resolved: 1 }, entities: 1, searches: 1, search_queries: 2, surfaced: 1, tool_errors: [], unresolved_ids: 0,
    });
    expect(trace.steps.map((s) => s.tool_calls)).toEqual([['memory_search', 'entity_search'], ['deliver_whisper', 'memory_reinforce', 'memory_remember', 'entity_remember']]);
    expect(trace.steps[0]).toMatchObject({ step: 1, ms: 1, attempts: 1, status: 200, error_class: 'none', prompt_tokens: 10, completion_tokens: 1 });
    expectClean(trace, result);
  });

  it('invalid model output: unknown tool, malformed arguments, bogus ids, non-numeric usage', async () => {
    const { store, runtime, input, seedId } = await setup();
    const result = await runAsyncPass(runtime, scripted([
      {
        calls: [
          { name: S, args: { [S]: S } },
          { name: 'memory_search', args: `{"queries": ["${S}"` },
          { name: 'memory_search', args: { queries: [], [S]: S } },
          { name: 'memory_remember', args: { kind: S, summary: S } },
          { name: 'deliver_whisper', args: { memory_id: S, quotes: [1] } },
        ],
        ms: S,
        usage: { prompt_tokens: S, completion_tokens: S, prompt_tokens_details: { cached_tokens: S }, completion_tokens_details: { reasoning_tokens: S } },
      },
      { calls: [search] },
      { calls: [
        { name: 'memory_reinforce', args: { memory_id: S, evidence_ids: [S, 'ev-1'], assistant_intent_id: S } },
        { name: 'deliver_whisper', args: { memory_id: seedId, quotes: [S] } },
        { name: 'suggest_memory_relation', args: { memory_ids: [seedId, S], relation: 'related', reason: S } },
        { name: 'skip_whisper', args: { [S]: S } },
      ] },
      { content: S },
    ]), input, { model: 'm', maxSteps: 4 });
    const trace = toAsyncTrace(result, asyncTrust(store, input));

    expect(trace.steps[0].tool_calls).toEqual(['unknown', 'memory_search', 'memory_search', 'memory_remember', 'deliver_whisper']);
    expect(trace.steps[0]).not.toHaveProperty('ms');
    expect(trace.steps[0]).not.toHaveProperty('prompt_tokens');
    expect(trace.steps[0]).not.toHaveProperty('cached_tokens');
    expect(trace.tool_errors).toEqual([
      { tool: 'unknown', code: 'unknown_tool' },
      { tool: 'memory_search', code: 'invalid_arguments' },
      { tool: 'memory_search', code: 'invalid_queries' },
      { tool: 'memory_remember', code: 'invalid_kind' },
      { tool: 'deliver_whisper', code: 'not_surfaced' },
      { tool: 'deliver_whisper', code: 'invalid_quotes' },
      { tool: 'suggest_memory_relation', code: 'unseen_memory' },
    ]);
    // The bogus memory and intent ids are counted; the evidence id from the catalog is kept.
    expect(trace.reinforce).toEqual([{ outcome: 'permanently_rejected', rejection_code: 'unknown_assistant_intent', evidence_ids: ['ev-1'], unresolved_ids: 3 }]);
    expect(trace).toMatchObject({ whisper: 'skipped', intents: { catalog: 1, resolved: 0 }, unresolved_ids: 3 });
    expectClean(trace, result);
  });

  for (const status of [429, 503]) {
    it(`provider error ${status}: the step keeps its error class, not the provider's body`, async () => {
      const { store, runtime, input } = await setup();
      const result = await withoutBackoff(() => runAsyncPass(runtime, scripted([{ status, usage: { prompt_tokens: S } }]), input, { model: 'm', maxSteps: 4 }));
      const trace = toAsyncTrace(result, asyncTrust(store, input));
      expect(trace).toMatchObject({ completion: 'retryable_failure', succeeded: false, steps: [{ step: 1, attempts: 4, status, error_class: status === 429 ? 'rate_limited' : 'server', tool_calls: [] }] });
      expect(trace.steps[0]).not.toHaveProperty('prompt_tokens');
      expectClean(trace, result);
    });
  }

  it('a status that is not a number is dropped', async () => {
    const { store, runtime, input } = await setup();
    const result = await runAsyncPass(runtime, scripted([{ status: S }]), input, { model: 'm', maxSteps: 4 });
    const trace = toAsyncTrace(result, asyncTrust(store, input));
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({ step: 1, ms: 1, attempts: 1, error_class: 'client', tool_calls: [] });
    expect(trace.steps[0]).not.toHaveProperty('status');
    expectClean(trace, result);
  });

  it('a tool that throws: a fixed code and an allowlisted class name, never the message', async () => {
    const { store, runtime, input } = await setup();
    vi.spyOn(runtime, 'entitySearchRecallHybrid').mockRejectedValueOnce(new SentinelError(S)).mockRejectedValueOnce(new TypeError(S));
    const result = await runAsyncPass(runtime, scripted([
      { calls: [search, { name: 'entity_search', args: { query: S } }, { name: 'entity_search', args: { query: S } }] },
      { calls: [{ name: 'skip_whisper', args: {} }] },
    ]), input, { model: 'm', maxSteps: 4 });
    const trace = toAsyncTrace(result, asyncTrust(store, input));
    expect(trace.tool_errors).toEqual([
      { tool: 'entity_search', code: 'exception', exception: 'other' },
      { tool: 'entity_search', code: 'exception', exception: 'TypeError' },
    ]);
    expectClean(trace, result);
  });

  it('a pass that throws: a crash trace with the class name only', async () => {
    const { input, runtime } = await setup();
    // An error class whose constructor cannot even be read still gets a record.
    const hostile = new Error(S);
    Object.defineProperty(hostile, 'constructor', { get() { throw new Error(S); } });
    for (const [error, name] of [[new SentinelError(S), 'other'], [new TypeError(S), 'TypeError'], [S, 'other'], [hostile, 'other']] as const) {
      const thrown = await runAsyncPass(runtime, scripted([{ throws: error }]), input, { model: 'm', maxSteps: 4 }).then(() => undefined, (e: unknown) => e);
      expect(thrown).toBe(error);
      const trace = toCrashTrace('async', thrown, traceHeader(input, { wallMs: 3 }));
      expect(trace).toEqual({ schema_version: 1, lane: 'async', batch_id: 'batch-1', session_id: 'conv-1', wall_ms: 3, crashed: true, error_class: 'exception', exception: name });
      expectClean(trace);
    }
  });

  it('rejected reinforce and remember: fixed rejection codes, resolved ids only', async () => {
    const { store, runtime, input, seedId } = await setup();
    const valid = { participants: ['user'], evidence_ids: ['ev-2'], payload: { name: S, meaning: `测试含义 ${S}`, trigger_phrases: [S] } };
    const result = await runAsyncPass(runtime, scripted([
      { calls: [search] },
      { calls: [
        { name: 'memory_reinforce', args: { memory_id: seedId, evidence_ids: [S] } },
        { name: 'memory_reinforce', args: { memory_id: S, evidence_ids: ['ev-1'] } },
        { name: 'memory_remember', args: { kind: 'inside_joke', summary: S, ...valid } },
        { name: 'memory_remember', args: { kind: 'inside_joke', summary: `测试 ${S}`, ...valid, [S]: S } },
        { name: 'memory_remember', args: { kind: 'inside_joke', summary: `测试一 ${S}`, ...valid, assistant_intent_id: S } },
        { name: 'memory_remember', args: { kind: 'inside_joke', summary: `测试二 ${S}`, ...valid, linked_memory_ids: [S] } },
        { name: 'entity_remember', args: { canonical_name: S, aliases: [S], entity_type: S, description: S, evidence_ids: [S] } },
        { name: 'skip_whisper', args: {} },
      ] },
    ]), input, { model: 'm', maxSteps: 4 });
    const trace = toAsyncTrace(result, asyncTrust(store, input));
    expect(trace.reinforce).toEqual([
      { outcome: 'permanently_rejected', rejection_code: 'unresolvable_evidence', memory_id: seedId, evidence_ids: [], unresolved_ids: 1 },
      { outcome: 'permanently_rejected', rejection_code: 'unknown_memory', evidence_ids: ['ev-1'], unresolved_ids: 1 },
    ]);
    expect(trace.remember.map((r) => [r.outcome, r.rejection_code, r.unresolved_ids])).toEqual([
      ['permanently_rejected', 'non_chinese_semantic_prose', 0],
      ['permanently_rejected', 'unknown_field', 0],
      ['permanently_rejected', 'unknown_assistant_intent', 1],
      ['permanently_rejected', 'unknown_linked_memory', 0],
    ]);
    expect(trace.remember.every((r) => r.memory_id === undefined && r.kind === 'inside_joke')).toBe(true);
    expect(trace).toMatchObject({ succeeded: true, entities: 1, unresolved_ids: 3 });
    expectClean(trace, result);
  });

  it('a whisper selected before a failed step is a selection, not a delivery', async () => {
    const { store, runtime, input, seedId } = await setup();
    const result = await withoutBackoff(() => runAsyncPass(runtime, scripted([
      { calls: [search] },
      { calls: [{ name: 'deliver_whisper', args: { memory_id: seedId, quotes: [1] } }, search] },
      { status: 429 },
    ]), input, { model: 'm', maxSteps: 4 }));
    const trace = toAsyncTrace(result, asyncTrust(store, input));
    expect(trace).toMatchObject({ completion: 'retryable_failure', succeeded: false, whisper: 'selected', whisper_memory_id: seedId });
    expectClean(trace, result);
  });

  it('ids padded with whitespace resolve as the runtime resolves them', async () => {
    const { store, runtime, input, seedId } = await setup();
    const result = await runAsyncPass(runtime, scripted([
      { calls: [search] },
      { calls: [
        { name: 'memory_reinforce', args: { memory_id: ` ${seedId} `, evidence_ids: [' ev-1 '], assistant_intent_id: ' intent-1 ' } },
        { name: 'skip_whisper', args: {} },
      ] },
    ]), input, { model: 'm', maxSteps: 4 });
    expect(store.getTerminalAssistantIntentOutcome('intent-1')?.memory_id).toBe(seedId);
    const trace = toAsyncTrace(result, asyncTrust(store, input));
    expect(trace.reinforce).toEqual([{ outcome: 'accepted', memory_id: seedId, evidence_ids: ['ev-1'], assistant_intent_id: 'intent-1', unresolved_ids: 0 }]);
    expect(trace).toMatchObject({ intents: { catalog: 1, resolved: 1 }, unresolved_ids: 0 });
    expectClean(trace);
  });

  it('the header takes ids from the hook input only, never from the context', async () => {
    const { store, input, syncInput } = await setup();
    // Structurally a valid context: extra properties pass the type check when they come in a variable.
    const context = { at: NOW, wallMs: 5, batchId: S, sessionId: S };
    expect(traceHeader(input, context)).toEqual({ batchId: 'batch-1', sessionId: 'conv-1', at: NOW, wallMs: 5 });
    const traces = [
      toCrashTrace('async', new Error(S), asyncTrust(store, input, context)),
      toCrashTrace('sync', new Error(S), syncTrust(store, syncInput, context)),
      toCrashTrace('sync', new Error(S), traceHeader(syncInput, context)),
    ];
    for (const trace of traces) {
      expect(trace).toMatchObject({ batch_id: 'batch-1', session_id: 'conv-1', at: NOW, wall_ms: 5 });
      expectClean(trace);
    }
  });

  it('values outside the allowlists become other, unknown or a count', () => {
    const trust = { batchId: 'b', sessionId: 's', memoryIds: new Set<string>(), evidenceIds: new Set<string>(), intentIds: new Set<string>() };
    const trace = toAsyncTrace({
      succeeded: false, completion: S as any, steps: [], tool_errors: [{ name: S, code: S as any, exception: S, message: S }], surfaced_memory_ids: [S],
      decisions: { reinforce: [{ memory_id: S, outcome: S, rejection_code: S, evidence_ids: S as any }], remember: [{ kind: S, outcome: 'accepted', memory_id: S }], relations: [{ outcome: S }], entities: S as any, searches: 0, search_queries: 0, query_texts: [S] },
    }, trust);
    expect(trace).toMatchObject({
      completion: 'other', entities: 0, surfaced: 1,
      reinforce: [{ outcome: 'other', rejection_code: 'other', evidence_ids: [], unresolved_ids: 2 }],
      remember: [{ kind: 'other', outcome: 'accepted', unresolved_ids: 1 }],
      relations: [{ outcome: 'other' }], tool_errors: [{ tool: 'unknown', code: 'other' }], unresolved_ids: 3,
    });
    expectClean(trace);
  });
});

describe('sync trace', () => {
  it('normal pass: keeps the selected memory id, counts the phrases', async () => {
    const { store, runtime, syncInput, seedId } = await setup();
    const result = await runSyncPass(runtime, syncModel(
      { content: JSON.stringify({ queries: [S, '测试笑话'] }) },
      { content: JSON.stringify({ memory_id: seedId }) },
    ), syncInput, { model: 'm' });
    const trace = toSyncTrace(result, syncTrust(store, syncInput, { at: NOW }));
    expect(trace).toMatchObject({
      schema_version: 1, lane: 'sync', crashed: false, batch_id: 'batch-1', session_id: 'conv-1', at: NOW,
      phrase_status: 'ok', phrases: 2, gate_status: 'ok', whisper_selected: true, whisper_memory_id: seedId, whisper_quotes: 1, candidates: 1,
      usage: { prompt_tokens: 20, completion_tokens: 2 }, unresolved_ids: 0,
    });
    expect(trace.skip_reason).toBeUndefined();
    expectClean(trace, result);
  });

  it('invalid model output: a bogus gate pick, non-numeric usage', async () => {
    const { store, runtime, syncInput } = await setup();
    const usage = { prompt_tokens: S, completion_tokens: S };
    const result = await runSyncPass(runtime, syncModel(
      { content: `${S} {"queries": ["${S}"]} ${S}`, usage },
      { content: JSON.stringify({ memory_id: S }), usage },
    ), syncInput, { model: 'm' });
    const trace = toSyncTrace(result, syncTrust(store, syncInput));
    expect(trace).toMatchObject({ phrase_status: 'ok', phrases: 1, gate_status: 'ok', whisper_selected: false, skip_reason: 'gate_none', usage: {} });
    expectClean(trace, result);

    const broken = await runSyncPass(runtime, syncModel({ content: S }, { content: S }), syncInput, { model: 'm' });
    const brokenTrace = toSyncTrace(broken, syncTrust(store, syncInput));
    expect(brokenTrace).toMatchObject({ phrase_status: 'error', phrases: 0, gate_status: 'error', skip_reason: 'gate_failed' });
    expectClean(brokenTrace);
  });

  it('provider errors: the error class only', async () => {
    const { store, runtime, syncInput } = await setup();
    const result = await runSyncPass(runtime, syncModel({ status: 429, usage: { prompt_tokens: S } }, { status: 502 }), syncInput, { model: 'm' });
    const trace = toSyncTrace(result, syncTrust(store, syncInput));
    expect(trace).toMatchObject({ phrase_status: 'error', gate_status: 'error', skip_reason: 'gate_failed', provider_error: 'server', candidates: 1 });
    expectClean(trace);
  });

  it('timeouts of the phrase call and the gate', async () => {
    const { store, runtime, syncInput } = await setup();
    const late = { content: JSON.stringify({ queries: [S], memory_id: S }), usage: { prompt_tokens: S }, delayMs: 60 };
    const { result, settled } = await runSyncPassSettled(runtime, syncModel(late, late), syncInput, { model: 'm', phraseTimeoutMs: 20 });
    expect(await settled()).toBeUndefined();
    const trace = toSyncTrace(result, syncTrust(store, syncInput));
    expect(trace).toMatchObject({ phrase_status: 'timeout', phrases: 0, gate_status: 'timeout', skip_reason: 'gate_failed', whisper_selected: false, usage: {} });
    expect(trace.gate_ms).toBeGreaterThanOrEqual(15);
    expectClean(trace);
  });

  it('a pass that throws: a crash trace with the class name only', async () => {
    const { runtime, syncInput } = await setup();
    const header = traceHeader(syncInput);
    const thrown = await runSyncPass(runtime, syncModel({ throws: new SentinelError(S) }, {}), syncInput, { model: 'm' }).then(() => undefined, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(SentinelError);
    expectClean(toCrashTrace('sync', thrown, header));

    vi.spyOn(runtime, 'memorySearchRecallHybridWithEvidence').mockRejectedValue(new RangeError(S));
    const thrownBySearch = await runSyncPass(runtime, syncModel({ content: S }, {}), syncInput, { model: 'm' }).then(() => undefined, (e: unknown) => e);
    const trace = toCrashTrace('sync', thrownBySearch, header);
    expect(trace).toMatchObject({ lane: 'sync', crashed: true, error_class: 'exception', exception: 'RangeError' });
    expectClean(trace);
  });

  it('a crash the store caused still gets its record: the header reads no store', async () => {
    const { store, runtime, syncInput } = await setup();
    const header = traceHeader(syncInput, { at: NOW });
    fs.appendFileSync(path.join(store.rootDir, 'memories.jsonl'), `{"memory_id": "${S}", ${S}\n`);
    const thrown = await runSyncPass(runtime, syncModel({ content: JSON.stringify({ queries: [S] }) }, {}), syncInput, { model: 'm' }).then(() => undefined, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    // Building the store-backed trust now would throw a second time; the crash record does not need it.
    expect(() => syncTrust(store, syncInput)).toThrow();
    const trace = toCrashTrace('sync', thrown, header);
    expect(trace).toEqual({ schema_version: 1, lane: 'sync', batch_id: 'batch-1', session_id: 'conv-1', at: NOW, crashed: true, error_class: 'exception', exception: (thrown as Error).constructor.name });
    expect(['SyntaxError', 'Error']).toContain(trace.exception);
    expectClean(trace);
  });
});

describe('trace allowlists', () => {
  it('know every harness tool and drop a timestamp that is not one', () => {
    expect([...TRACE_TOOL_NAMES].sort()).toEqual(harnessTools().map((tool) => tool.function.name).sort());
    const trace = toCrashTrace('sync', new Error(S), { batchId: 'b', sessionId: 's', at: S, wallMs: S as any });
    expect(trace).toEqual({ schema_version: 1, lane: 'sync', batch_id: 'b', session_id: 's', crashed: true, error_class: 'exception', exception: 'Error' });
  });
});
