import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMessage, TranscriptEvidenceKind } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import type { ChatTransport, TransportReply } from './llm.js';
import { harnessTools, runAsyncPass } from './pass.js';
import { runSyncPass } from './sync_pass.js';
import { toAsyncTrace } from './trace.js';
import { SnippetHandles, slimMemory } from './view.js';
import { worldWhisperText } from './whisper.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

type Call = { name: string; args: unknown };
function scripted(steps: Call[][]): ChatTransport {
  let i = 0;
  return {
    async chat(): Promise<TransportReply> {
      const calls = steps[Math.min(i++, steps.length - 1)];
      const message = calls.length
        ? { role: 'assistant', content: null, tool_calls: calls.map((c, n) => ({ id: `c${i}-${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: 'assistant', content: 'done' };
      return { status: 200, ms: 1, body: { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 1 } } };
    },
  };
}

function event(id: string, kind: TranscriptEvidenceKind, capturedAt: string, quote: string): CanonicalMessage {
  return {
    conversation_id: 'conv-world', message_id: `msg-${id}`, role: kind.startsWith('assistant') ? 'assistant' : 'user', quote, captured_at: capturedAt,
    evidence_id: `ev-${id}`, event_kind: kind, block_index: 0,
    ...(kind === 'tool_result' ? { tool_name: 'WebSearch', tool_use_id: `toolu-${id}` } : {}),
  };
}

const EVENTS = [
  event('first', 'user_text', '2026-04-01T10:00:00Z', 'Example Corp released the Widget 9 model today.'),
  event('again', 'user_text', '2026-04-20T09:00:00Z', 'Widget 9 is still the newest model from Example Corp.'),
  event('changed', 'user_text', '2026-05-10T08:00:00Z', 'Example Corp just shipped Widget 10, replacing Widget 9.'),
  event('belief', 'assistant_text', '2026-05-10T08:01:00Z', 'I think Widget 11 is out already.'),
];
const TOPIC = 'Newest Example Corp widget model';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-world-'));
  dirs.push(root);
  const clock = { now: '2026-05-01T00:00:00.000Z' };
  const runtime = new RelationshipMemoryRuntime(
    new RelationshipMemoryStore(root, 'local-user'), new Map(EVENTS.map((e) => [e.evidence_id!, e])), () => clock.now, new Map(), false,
  );
  let batch = 0;
  const pass = (steps: Call[][], known: string[] = []) => runAsyncPass(runtime, scripted(steps), {
    batchId: `batch-${++batch}`, sessionId: 's', latestUserMessage: 'Example Corp widget news', canonicalMessages: [], assistantIntents: [],
    sessionKnownMemoryIds: known, recentSeen: [],
  }, { model: 'm', maxSteps: 3 });
  return { runtime, clock, pass };
}

const search: Call = { name: 'memory_search', args: { queries: ['Example Corp widget'] } };
const skip: Call = { name: 'skip_whisper', args: {} };
const remember = (evidence: string): Call => ({
  name: 'memory_remember',
  args: { kind: 'world_update', summary: 'Example Corp widget model', participants: ['user'], evidence_ids: [evidence], payload: { topic: TOPIC, fact: 'Widget 9 is the newest model' } },
});

async function searchView(runtime: RelationshipMemoryRuntime) {
  const hits = await runtime.memorySearchRecallHybridWithEvidence({ query: 'Example Corp widget', limit: 8 } as any);
  return hits.map((hit) => slimMemory(hit, new SnippetHandles()));
}

describe('world_update tools', () => {
  it('offers world_update to remember and search, the head id to reinforce, and memory_world_update', () => {
    const props = (name: string) => (harnessTools(false).find((tool) => tool.function.name === name)!.function.parameters as any).properties;
    expect(props('memory_remember').kind.enum).toContain('world_update');
    expect(props('memory_search').kind.enum).toContain('world_update');
    expect(props('memory_reinforce')).toHaveProperty('world_revision_id');
    expect(Object.keys(props('memory_world_update')).sort()).toEqual(['as_of', 'evidence_ids', 'fact', 'memory_id']);
  });
});

describe('world_update through the async pass', () => {
  it('remembers an anchor that search shows with its head only', async () => {
    const { runtime, pass } = setup();
    const result = await pass([[search], [remember('ev-first'), skip]]);
    expect(result.succeeded).toBe(true);
    expect(result.decisions.remember).toEqual([expect.objectContaining({ kind: 'world_update', outcome: 'accepted' })]);
    const [hit] = await searchView(runtime);
    expect(hit).toMatchObject({ kind: 'world_update', world: { fact: 'Widget 9 is the newest model', as_of: '2026-04-01', last_confirmed: '2026-04-01', source: 'user', revisions: 1 } });
    expect(hit.world!.revision_id).toMatch(/^world_rev_/);
  });

  it('confirms the head through memory_reinforce with its revision id, without a new revision', async () => {
    const { runtime, clock, pass } = setup();
    const memoryId = (await pass([[search], [remember('ev-first'), skip]])).decisions.remember[0].memory_id!;
    const [before] = await searchView(runtime);
    clock.now = '2026-04-21T00:00:00.000Z';
    const result = await pass([[search], [{ name: 'memory_reinforce', args: { memory_id: memoryId, evidence_ids: ['ev-again'], world_revision_id: before.world!.revision_id } }, skip]]);
    expect(result.decisions.reinforce).toEqual([expect.objectContaining({ outcome: 'accepted' })]);
    const [after] = await searchView(runtime);
    expect(after.world).toMatchObject({ revision_id: before.world!.revision_id, as_of: '2026-04-01', last_confirmed: '2026-04-20', revisions: 1 });
  });

  it('records a changed fact as the new head, keeps it session-known, and whispers the timeline in a later session', async () => {
    const { runtime, clock, pass } = setup();
    const memoryId = (await pass([[search], [remember('ev-first'), skip]])).decisions.remember[0].memory_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    const update = await pass([[search], [
      { name: 'memory_world_update', args: { memory_id: memoryId, fact: 'Widget 10 is the newest model', as_of: '2026-05-10', evidence_ids: ['ev-changed'] } },
      { name: 'deliver_whisper', args: { memory_id: memoryId } },
    ]]);
    expect(update.decisions.world_updates).toEqual([{ memory_id: memoryId, outcome: 'accepted', rejection_code: undefined }]);
    // Kohaku just heard the change: the whisper on it in the same pass is a quiet skip.
    expect(update.decisions).toMatchObject({ whisper_known_skip: true });
    expect(update.decisions.whisper).toBeUndefined();

    const [hit] = await searchView(runtime);
    expect(hit.world).toMatchObject({ fact: 'Widget 10 is the newest model', as_of: '2026-05-10', revisions: 2 });
    expect(JSON.stringify(hit)).not.toContain('Widget 9 is the newest model');

    const later = await pass([[search], [{ name: 'deliver_whisper', args: { memory_id: memoryId } }]]);
    expect(later.tool_errors).toEqual([]);
    expect(later.decisions.whisper).toEqual({ memory_id: memoryId, snippet_ids: [], world_update: true });
    expect(worldWhisperText(runtime, memoryId)).toBe([
      `（知识补丁）${TOPIC}`,
      '· 2026-04-01 起：Widget 9 is the newest model',
      '· 2026-05-10 起：Widget 10 is the newest model　← 最新（截至 2026-05-10）',
    ].join('\n'));
  });

  it('passes the runtime refusals through: the same fact is a duplicate, an assistant belief is not a source', async () => {
    const { pass } = setup();
    const memoryId = (await pass([[search], [remember('ev-first'), skip]])).decisions.remember[0].memory_id!;
    const result = await pass([[search], [
      { name: 'memory_world_update', args: { memory_id: memoryId, fact: 'Widget 9 is the newest model', evidence_ids: ['ev-again'] } },
      { name: 'memory_world_update', args: { memory_id: memoryId, fact: 'Widget 11 is the newest model', evidence_ids: ['ev-belief'] } },
      skip,
    ]]);
    expect(result.decisions.world_updates.map((w) => [w.outcome, w.rejection_code])).toEqual([
      ['duplicate', undefined],
      ['permanently_rejected', 'untrusted_world_source'],
    ]);
  });

  it('traces world_update calls and a timeline whisper without content', async () => {
    const { runtime, pass } = setup();
    const memoryId = (await pass([[search], [remember('ev-first'), skip]])).decisions.remember[0].memory_id!;
    const result = await pass([[search], [
      { name: 'memory_world_update', args: { memory_id: memoryId, fact: 'Widget 10 is the newest model', evidence_ids: ['ev-changed'] } },
      skip,
    ]]);
    const trust = { batchId: 'b', sessionId: 's', memoryIds: new Set([memoryId]), evidenceIds: new Set<string>(), intentIds: new Set<string>() };
    const trace = toAsyncTrace({ ...result, decisions: { ...result.decisions, whisper: { memory_id: memoryId, snippet_ids: [], world_update: true } } }, trust);
    expect(trace).toMatchObject({ world_updates: [{ outcome: 'accepted', memory_id: memoryId, unresolved_ids: 0 }], whisper_world_update: true, whisper_quotes: 0 });
    expect(JSON.stringify(trace)).not.toContain('Widget');
    expect(runtime.store.listMemories()).toHaveLength(1);
  });
});

describe('world_update through the sync pass', () => {
  it('picks no quotes for a world_update whisper', async () => {
    const { runtime, pass } = setup();
    const memoryId = (await pass([[search], [remember('ev-first'), skip]])).decisions.remember[0].memory_id!;
    const phraseError: ChatTransport = {
      async chat(): Promise<TransportReply> {
        return { status: 200, ms: 1, body: { choices: [{ message: { role: 'assistant', content: 'not json' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
      },
    };
    const result = await runSyncPass(runtime, phraseError, {
      batchId: 'b-sync', sessionId: 's2', latestUserMessage: 'Example Corp widget', previousUserMessage: '', previousKohakuReply: '', sessionKnownMemoryIds: [],
    }, { model: 'm', gate: 'rank' });
    expect(result.whisper).toEqual({ memory_id: memoryId, snippet_ids: [], world_update: true });
  });
});
