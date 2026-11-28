import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_MEMORY_KINDS,
  FileBackedSemanticRetriever,
  MEMORY_KINDS,
  RELATIONSHIP_EXTERNAL_TOOLS,
  RELATIONSHIP_MUTATION_CLIENT_TOOLS,
  RelationshipMemoryOwnerControlPlane,
  RelationshipMemoryRecallSession,
  RelationshipMemoryResolutionControlPlane,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  buildRelationshipTools,
  extractAssistantRememberIntents,
  ASSISTANT_REMEMBER_TOOL_NAME,
  materializeCurrentMemoryView,
  rebuildProjection,
  summarizeRelationshipMemory,
  validateSemanticContent,
  type AssistantRememberIntentRecord,
  type CanonicalMessage,
  type EmbeddingProvider,
  type FailureInjector,
  type TranscriptEvidenceKind,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-world-update-')); dirs.push(dir); return dir; }

function event(id: string, kind: TranscriptEvidenceKind, capturedAt: string, quote: string): CanonicalMessage {
  return {
    conversation_id: 'conv-world', message_id: `msg-${id}`, role: kind.startsWith('assistant') ? 'assistant' : 'user', quote, captured_at: capturedAt,
    evidence_id: `ev-${id}`, event_kind: kind, block_index: 0,
    ...(kind === 'tool_result' || kind === 'assistant_tool_use' ? { tool_name: 'WebSearch', tool_use_id: `toolu-${id}` } : {}),
  };
}

const EVENTS = [
  event('u-first', 'user_text', '2026-04-01T10:00:00Z', 'The prime minister of Country X is Person A now.'),
  event('u-again', 'user_text', '2026-04-20T09:00:00Z', 'Yes, Person A is still the prime minister of Country X.'),
  event('u-changed', 'user_text', '2026-05-10T08:00:00Z', 'Country X has a new prime minister: Person B.'),
  event('u-later', 'user_text', '2026-05-12T08:00:00Z', 'Person C took over in Country X this week.'),
  event('u-listing', 'user_text', '2026-05-13T08:00:00Z', 'Example Corp is publicly listed now.'),
  event('u-pref', 'user_text', '2026-05-14T08:00:00Z', 'I like reading the news in the morning.'),
  event('tool-found', 'tool_result', '2026-05-11T08:00:00Z', 'Search result: Person B took office in Country X.'),
  event('a-belief', 'assistant_text', '2026-05-10T08:01:00Z', 'I believe Person D leads Country X.'),
  event('a-tool', 'assistant_tool_use', '2026-05-10T08:02:00Z', 'WebSearch {"query":"Country X prime minister"}'),
  event('note', 'self_note', '2026-05-10T08:03:00Z', 'Check the Country X news later.'),
  event('meta', 'meta_text', '2026-05-10T08:04:00Z', 'Runtime note: Country X news.'),
];
const ev = (id: string) => `ev-${id}`;

function setup(options: { intents?: AssistantRememberIntentRecord[]; failureInjector?: FailureInjector; chinese?: boolean } = {}) {
  const root = tempDir();
  const store = new RelationshipMemoryStore(root, 'subject', options.failureInjector);
  for (const intent of options.intents ?? []) store.appendAssistantIntent(intent);
  const clock = { now: '2026-05-01T00:00:00.000Z' };
  const runtime = new RelationshipMemoryRuntime(
    store, new Map(EVENTS.map((item) => [item.evidence_id!, item])), () => clock.now,
    new Map((options.intents ?? []).map((intent) => [intent.intent_id, intent])), options.chinese ?? false,
  );
  return { root, store, runtime, clock };
}

const TOPIC = 'Prime minister of Country X';
function anchor(evidenceIds: string[], extra: Record<string, unknown> = {}, fact = 'Person A is the prime minister of Country X') {
  return { summary: 'Who leads Country X', participants: ['user'], evidence_ids: evidenceIds, payload: { topic: TOPIC, fact, domain: 'politics' }, ...extra };
}

describe('world_update remember', () => {
  it('writes the anchor and revision r1; the effective view has head r1, one revision and last_confirmed = r1 evidence time', async () => {
    const { store, runtime } = setup();
    const result = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')]));
    expect(result.outcome).toBe('accepted');
    const memoryId = result.memory_id!;
    expect(store.getMemory(memoryId)).toEqual(expect.objectContaining({ kind: 'world_update', payload: { topic: TOPIC, fact: 'Person A is the prime minister of Country X', domain: 'politics' } }));
    const revisions = store.listWorldRevisionsForMemoryIds([memoryId]);
    expect(revisions).toEqual([{
      schema_version: 1,
      revision_id: expect.stringMatching(/^world_rev_/),
      memory_id: memoryId,
      fact: 'Person A is the prime minister of Country X',
      as_of: '2026-04-01T10:00:00Z',
      source: 'user',
      evidence_ids: store.listEvidence().map((item) => item.evidence_id),
      batch_id: 'batch-1',
      recorded_at: '2026-05-01T00:00:00.000Z',
      sequence: 0,
    }]);

    const view = runtime.currentWorldUpdate(memoryId)!;
    expect(view.world_update).toEqual(expect.objectContaining({
      head: expect.objectContaining({ revision_id: revisions[0].revision_id, fact: revisions[0].fact, as_of: '2026-04-01T10:00:00Z', source: 'user' }),
      revision_count: 1,
      last_confirmed: '2026-04-01T10:00:00Z',
      revisions,
    }));
    const [hit] = await runtime.memorySearchRecallHybridWithEvidence({ kind: 'world_update' });
    expect(hit.world_update).toEqual(expect.objectContaining({ revision_count: 1, last_confirmed: '2026-04-01T10:00:00Z' }));
    expect(hit.world_update).not.toHaveProperty('revisions');
  });

  it('takes as_of from the call when given, and refuses a malformed date', () => {
    const { store, runtime } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')], { as_of: '2026-03-15' })).memory_id!;
    expect(store.listWorldRevisionsForMemoryIds([memoryId]).map((item) => item.as_of)).toEqual(['2026-03-15']);
    expect(runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-again')], { as_of: '2026-02-30' })))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_as_of' }));
    // as_of stays an unknown field for the five relationship kinds.
    expect(runtime.rememberKind('batch-1', 'user_preference', {
      summary: 'Reads news in the morning', participants: ['user'], evidence_ids: [ev('u-pref')], as_of: '2026-05-14',
      payload: { topic: 'news', preference: 'Reads the news in the morning' },
    })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unknown_field' }));
  });

  it('repairs a torn remember (anchor without r1) on the same-batch replay', () => {
    let failNext = true;
    const { store, runtime } = setup({ failureInjector: (phase) => {
      if (phase !== 'world_revision_commit' || !failNext) return false;
      failNext = false;
      return true;
    } });
    store.beginBatch('batch-torn', '2026-05-01T00:00:00.000Z');
    const proposal = anchor([ev('u-first')]);
    expect(runtime.rememberKind('batch-torn', 'world_update', proposal).outcome).toBe('retryable_failed');
    const [torn] = store.listMemories();
    expect(store.listWorldRevisions()).toHaveLength(0);
    expect(runtime.currentWorldUpdate(torn.memory_id)!.world_update).toEqual(expect.objectContaining({
      head: expect.objectContaining({ fact: 'Person A is the prime minister of Country X' }), revision_count: 0,
    }));
    expect(runtime.finalizeBatch('batch-torn', true)).toBe('retryable_failure');

    expect(runtime.rememberKind('batch-torn', 'world_update', proposal)).toEqual({ outcome: 'duplicate', memory_id: torn.memory_id });
    expect(store.listMemories()).toHaveLength(1);
    expect(store.listWorldRevisionsForMemoryIds([torn.memory_id])).toHaveLength(1);
    expect(runtime.finalizeBatch('batch-torn', true)).toBe('completed');
  });

  it('keeps a revision appended during the torn window as head when the replay repairs r1 later', () => {
    let failNext = true;
    const { store, runtime, clock } = setup({ failureInjector: (phase) => {
      if (phase !== 'world_revision_commit' || !failNext) return false;
      failNext = false;
      return true;
    } });
    const proposal = anchor([ev('u-first')]);
    expect(runtime.rememberKind('batch-torn', 'world_update', proposal).outcome).toBe('retryable_failed');
    const [torn] = store.listMemories();
    clock.now = '2026-05-10T09:00:00.000Z';
    expect(runtime.worldUpdate('batch-other', { memory_id: torn.memory_id, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] }).outcome).toBe('accepted');
    clock.now = '2026-05-11T09:00:00.000Z';
    expect(runtime.rememberKind('batch-torn', 'world_update', proposal).outcome).toBe('duplicate');
    const view = runtime.currentWorldUpdate(torn.memory_id)!.world_update!;
    expect(view.revisions!.map((item) => [item.fact, item.recorded_at])).toEqual([
      ['Person A is the prime minister of Country X', torn.created_at],
      ['Person B is the prime minister of Country X', '2026-05-10T09:00:00.000Z'],
    ]);
    expect(view.head.fact).toBe('Person B is the prime minister of Country X');
  });
});

describe('world_update reinforce and revisions', () => {
  it('reinforce with later evidence adds no revision, moves last_confirmed and keeps as_of', () => {
    const { store, runtime, clock } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-02T00:00:00.000Z';
    const head = runtime.currentWorldUpdate(memoryId)!.world_update!.head.revision_id;
    expect(runtime.reinforce('batch-2', { memory_id: memoryId, evidence_ids: [ev('u-again')], world_revision_id: head })).toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(store.listWorldRevisions()).toHaveLength(1);
    const view = runtime.currentWorldUpdate(memoryId)!.world_update!;
    expect(view.head.as_of).toBe('2026-04-01T10:00:00Z');
    expect(view.last_confirmed).toBe('2026-04-20T09:00:00Z');
    expect(view.revision_count).toBe(1);
  });

  it('a new fact becomes head r2, r1 is kept, and recall shows only r2', async () => {
    const { store, runtime, clock } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    const result = runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    expect(result).toEqual({ outcome: 'accepted', memory_id: memoryId });

    const revisions = store.listWorldRevisionsForMemoryIds([memoryId]);
    expect(revisions.map((item) => item.fact)).toEqual(['Person A is the prime minister of Country X', 'Person B is the prime minister of Country X']);
    expect(revisions[1]).toEqual(expect.objectContaining({ as_of: '2026-05-10T08:00:00Z', source: 'user', batch_id: 'batch-2' }));
    expect(store.getMemory(memoryId)!.payload.fact).toBe('Person A is the prime minister of Country X');

    const view = runtime.currentWorldUpdate(memoryId)!;
    expect(view.payload.fact).toBe('Person B is the prime minister of Country X');
    expect(view.world_update).toEqual(expect.objectContaining({ revision_count: 2, last_confirmed: '2026-05-10T08:00:00Z' }));
    expect(view.world_update!.revisions!.map((item) => item.fact)).toEqual(revisions.map((item) => item.fact));

    for (const hits of [
      await runtime.memorySearchRecallHybridWithEvidence({ query: 'Country X' }),
      await runtime.memorySearchHybridWithEvidence({ query: 'Country X' }),
      runtime.memorySearch({ kind: 'world_update' }),
    ]) {
      expect(hits).toHaveLength(1);
      expect(hits[0].payload.fact).toBe('Person B is the prime minister of Country X');
      expect(hits[0].world_update).toEqual(expect.objectContaining({ head: expect.objectContaining({ fact: 'Person B is the prime minister of Country X' }), revision_count: 2 }));
      expect(hits[0].world_update).not.toHaveProperty('revisions');
      expect(JSON.stringify(hits[0])).not.toContain('Person A is the prime minister');
    }
    const [withQuotes] = await runtime.memorySearchRecallHybridWithEvidence({ query: 'Country X' });
    expect(withQuotes.quote_snippets.map((snippet) => snippet.quote)).toEqual(['Country X has a new prime minister: Person B.']);
  });

  it('explicit recall search shows the head only', () => {
    const { root, runtime, clock } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    const recall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject', transcriptRoots: [] });
    const [hit] = (recall.relationshipMemorySearch({ query: 'Person B' }) as any).results;
    expect(hit).toEqual(expect.objectContaining({ memory_id: memoryId, payload: expect.objectContaining({ fact: 'Person B is the prime minister of Country X' }) }));
    expect(hit.world_update).toEqual(expect.objectContaining({ revision_count: 2 }));
    expect(hit.world_update).not.toHaveProperty('revisions');
    expect(JSON.stringify(hit)).not.toContain('Person A is the prime minister');
  });

  it('the head is the latest recorded revision, even when its as_of is earlier', () => {
    const { runtime, clock } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', as_of: '2026-01-01', evidence_ids: [ev('u-changed')] });
    const view = runtime.currentWorldUpdate(memoryId)!.world_update!;
    expect(view.head).toEqual(expect.objectContaining({ fact: 'Person B is the prime minister of Country X', as_of: '2026-01-01' }));
    expect(view.revisions!.map((item) => item.as_of)).toEqual(['2026-04-01T10:00:00Z', '2026-01-01']);
  });

  it('a fact equal to the head is a duplicate and writes nothing; a non-world target is not_world_update', () => {
    const { store, runtime, clock } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    const preferenceId = runtime.rememberKind('batch-1', 'user_preference', {
      summary: 'Reads news in the morning', participants: ['user'], evidence_ids: [ev('u-pref')],
      payload: { topic: 'news', preference: 'Reads the news in the morning' },
    }).memory_id!;
    const evidenceBefore = store.listEvidence().length;
    clock.now = '2026-05-10T09:00:00.000Z';
    const duplicate = runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: '  Person A is the   prime minister\nof Country X ', evidence_ids: [ev('u-again')] });
    expect(duplicate).toEqual({ outcome: 'duplicate', memory_id: memoryId, reason: expect.stringContaining('memory_reinforce') });
    expect(store.listWorldRevisions()).toHaveLength(1);
    expect(store.listEvidence()).toHaveLength(evidenceBefore);
    expect(store.listReinforcements()).toHaveLength(0);

    expect(runtime.worldUpdate('batch-2', { memory_id: preferenceId, fact: 'Anything', evidence_ids: [ev('u-changed')] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'not_world_update' }));
    expect(runtime.worldUpdate('batch-2', { memory_id: 'mem_missing', fact: 'Anything', evidence_ids: [ev('u-changed')] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unknown_memory' }));
    expect(runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: ' ', evidence_ids: [ev('u-changed')] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_world_update' }));
    expect(runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B leads Country X', as_of: 'May 2026', evidence_ids: [ev('u-changed')] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_as_of' }));
    expect(store.listWorldRevisions()).toHaveLength(1);
  });

  it('requires Chinese prose in the fact when the runtime requires it', () => {
    const { store, runtime } = setup({ chinese: true });
    store.appendMemory({
      schema_version: 1, memory_id: 'mem-world', subject_id: 'subject', kind: 'world_update', summary: 'Country X', participants: ['user'],
      payload: { topic: 'Country X', fact: 'Person A' }, status: 'active', observed_at: '2026-04-01T10:00:00Z', created_at: '2026-05-01T00:00:00.000Z',
      source_key: 'src-direct', dedupe_key: 'dedupe-direct',
    }, []);
    expect(runtime.worldUpdate('batch-1', { memory_id: 'mem-world', fact: 'Person B leads Country X', evidence_ids: [ev('u-changed')] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'non_chinese_semantic_prose' }));
  });
});

describe('world_update evidence rule', () => {
  const untrusted = expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'untrusted_world_source' });

  it.each(['a-belief', 'a-tool', 'note', 'meta'])('remember citing %s (alone or mixed) is rejected whole before any write', (id) => {
    const { store, runtime } = setup();
    const alone = runtime.rememberKind('batch-1', 'world_update', anchor([ev(id)]));
    expect(alone).toEqual(untrusted);
    expect(alone.reason).toContain(ev(id));
    const mixed = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first'), ev(id)]));
    expect(mixed).toEqual(untrusted);
    expect(mixed.reason).not.toContain(ev('u-first'));
    expect(store.listMemories()).toHaveLength(0);
    expect(store.listEvidence()).toHaveLength(0);
    expect(store.listWorldRevisions()).toHaveLength(0);
  });

  it.each(['a-belief', 'note'])('reinforce and world update citing %s are rejected and attach nothing', (id) => {
    const { store, runtime } = setup();
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    const evidenceBefore = store.listEvidence().length;
    const head = runtime.currentWorldUpdate(memoryId)!.world_update!.head.revision_id;
    expect(runtime.reinforce('batch-2', { memory_id: memoryId, evidence_ids: [ev(id)], world_revision_id: head })).toEqual(untrusted);
    expect(runtime.reinforce('batch-2', { memory_id: memoryId, evidence_ids: [ev('u-again'), ev(id)], world_revision_id: head })).toEqual(untrusted);
    expect(runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person D leads Country X', evidence_ids: [ev(id)] })).toEqual(untrusted);
    expect(runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B leads Country X', evidence_ids: [ev('u-changed'), ev(id)] })).toEqual(untrusted);
    expect(store.listReinforcements()).toHaveLength(0);
    expect(store.listWorldRevisions()).toHaveLength(1);
    expect(store.listEvidence()).toHaveLength(evidenceBefore);
  });

  it('keeps assistant_text citable for the five relationship kinds', () => {
    const { runtime } = setup();
    expect(runtime.rememberKind('batch-1', 'personal_experience', {
      summary: 'The assistant shared a belief', participants: ['assistant'], evidence_ids: [ev('a-belief')],
      payload: { title: 'A belief', experience: 'The assistant said what it believed about Country X.' },
    }).outcome).toBe('accepted');
  });

  it('derives source tool when a tool_result is cited', () => {
    const { store, runtime, clock } = setup();
    const toolOnly = runtime.rememberKind('batch-1', 'world_update', anchor([ev('tool-found')], {}, 'Person B is the prime minister of Country X')).memory_id!;
    expect(store.listWorldRevisionsForMemoryIds([toolOnly])[0].source).toBe('tool');
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')], { summary: 'Leader of Country X' })).memory_id!;
    clock.now = '2026-05-11T09:00:00.000Z';
    runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed'), ev('tool-found')] });
    expect(runtime.currentWorldUpdate(memoryId)!.world_update!.head.source).toBe('tool');
    // source is derived; a caller-supplied value is never read.
    clock.now = '2026-05-12T09:00:00.000Z';
    expect(runtime.worldUpdate('batch-3', { memory_id: memoryId, fact: 'Person C leads Country X', evidence_ids: [ev('u-later')], source: 'tool' } as never).outcome).toBe('accepted');
    expect(runtime.currentWorldUpdate(memoryId)!.world_update!.head.source).toBe('user');
  });

  it('leaves a linked remember intent open across the rejection and its replay', () => {
    const intents = extractAssistantRememberIntents([{
      type: 'assistant', uuid: 'asst-intent', timestamp: '2026-05-10T08:05:00Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_intent', name: ASSISTANT_REMEMBER_TOOL_NAME, input: { memory: { text: 'Country X changed leaders.' }, feel: { text: 'Good to know.' } } }] },
    }] as any[], -1, 'session-1', 'subject');
    const { store, runtime } = setup({ intents });
    const intentId = intents[0].intent_id;
    store.beginBatch('intent-batch', '2026-05-10T09:00:00.000Z');
    const bad = anchor([ev('u-changed'), ev('a-belief')], { assistant_intent_id: intentId });
    expect(runtime.rememberKind('intent-batch', 'world_update', bad)).toEqual(untrusted);
    expect(runtime.rememberKind('intent-batch', 'world_update', bad)).toEqual(untrusted);
    expect(store.getTerminalAssistantIntentOutcome(intentId)).toBeUndefined();
    const accepted = runtime.rememberKind('intent-batch', 'world_update', anchor([ev('u-changed')], { assistant_intent_id: intentId }));
    expect(accepted.outcome).toBe('accepted');
    expect(store.getTerminalAssistantIntentOutcome(intentId, 'intent-batch')).toEqual(expect.objectContaining({ outcome: 'accepted', memory_id: accepted.memory_id }));
    expect(runtime.finalizeBatch('intent-batch', true)).toBe('completed');
  });
});

describe('world_update relations', () => {
  function threeMemories() {
    const context = setup();
    const { runtime, clock } = context;
    const first = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-12T09:00:00.000Z';
    const second = runtime.rememberKind('batch-2', 'world_update', anchor([ev('u-later')], { summary: 'Country X leadership' }, 'Person C is the prime minister of Country X')).memory_id!;
    const preference = runtime.rememberKind('batch-2', 'user_preference', {
      summary: 'Reads news in the morning', participants: ['user'], evidence_ids: [ev('u-pref')],
      payload: { topic: 'news', preference: 'Reads the news in the morning' },
    }).memory_id!;
    return { ...context, first, second, preference };
  }

  it('suggest_memory_relation allows related / unrelated / same_meaning between world anchors and related / unrelated across kinds', () => {
    const { runtime, first, second, preference } = threeMemories();
    for (const relation of ['changed_over_time', 'conflict', 'context_dependent'] as const) {
      expect(runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, second], relation, reason: 'same topic' }))
        .toEqual(expect.objectContaining({ outcome: 'rejected', rejection_code: 'invalid_world_relation' }));
    }
    for (const relation of ['same_meaning', 'changed_over_time', 'conflict', 'context_dependent'] as const) {
      expect(runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, preference], relation, reason: 'mixed kinds' }))
        .toEqual(expect.objectContaining({ outcome: 'rejected', rejection_code: 'invalid_world_relation' }));
    }
    expect(runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, second], relation: 'same_meaning', reason: 'one topic' }).outcome).toBe('accepted');
    expect(runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, preference], relation: 'related', reason: 'news' }).outcome).toBe('accepted');
    // Five-kind relations are unchanged.
    const other = runtime.rememberKind('batch-3', 'personal_experience', {
      summary: 'Morning walk', participants: ['user'], evidence_ids: [ev('u-again')], payload: { title: 'Morning walk', experience: 'The user walked in the morning.' },
    }).memory_id!;
    expect(runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [preference, other], relation: 'changed_over_time', reason: 'habit' }).outcome).toBe('accepted');
  });

  it('owner resolution refuses a disallowed relation and merges same_meaning anchors into one chain, oldest first', async () => {
    const { store, runtime, clock, first, second, preference } = threeMemories();
    const mixed = runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, preference], relation: 'related', reason: 'news' }).review_id!;
    const resolution = new RelationshipMemoryResolutionControlPlane(store, () => '2026-05-20T00:00:00.000Z');
    expect(() => resolution.resolveReview(mixed, { resolution_id: 'res-mixed', relation: 'changed_over_time', target_memory_id: first })).toThrow(/invalid_world_relation/);
    expect(() => resolution.resolveReview(mixed, { resolution_id: 'res-mixed-2', relation: 'same_meaning', target_memory_id: first })).toThrow(/invalid_world_relation/);
    expect(store.listMemoryResolutionRecords()).toHaveLength(0);

    const pair = runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, second], relation: 'same_meaning', reason: 'one topic' }).review_id!;
    expect(() => resolution.resolveReview(pair, { resolution_id: 'res-conflict', relation: 'conflict' })).toThrow(/invalid_world_relation/);
    clock.now = '2026-05-13T09:00:00.000Z';
    runtime.worldUpdate('batch-4', { memory_id: first, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    resolution.resolveReview(pair, { resolution_id: 'res-merge', relation: 'same_meaning', target_memory_id: first });

    // Chain: first.r1 (05-01), second.r1 (05-12), first.r2 (05-13) — recorded_at order, one head.
    const merged = runtime.currentWorldUpdate(second)!;
    expect(merged.memory_id).toBe(first);
    expect(merged.world_update!.revisions!.map((item) => [item.memory_id, item.fact])).toEqual([
      [first, 'Person A is the prime minister of Country X'],
      [second, 'Person C is the prime minister of Country X'],
      [first, 'Person B is the prime minister of Country X'],
    ]);
    expect(merged.world_update!.head.fact).toBe('Person B is the prime minister of Country X');
    expect(merged.world_update!.revision_count).toBe(3);
    expect(materializeCurrentMemoryView(store).filter((memory) => memory.kind === 'world_update').map((memory) => memory.memory_id)).toEqual([first]);
    const hits = await runtime.memorySearchRecallHybridWithEvidence({ kind: 'world_update' });
    expect(hits.map((hit) => [hit.memory_id, hit.payload.fact])).toEqual([[first, 'Person B is the prime minister of Country X']]);
    expect(store.listWorldRevisions()).toHaveLength(3);
  });

  it('checks a world update against the merged head', () => {
    const { store, runtime, first, second } = threeMemories();
    const pair = runtime.suggestMaintenanceReview('batch-3', 'relation', { memory_ids: [first, second], relation: 'same_meaning', reason: 'one topic' }).review_id!;
    new RelationshipMemoryResolutionControlPlane(store, () => '2026-05-20T00:00:00.000Z').resolveReview(pair, { resolution_id: 'res-merge', relation: 'same_meaning', target_memory_id: first });
    expect(runtime.worldUpdate('batch-4', { memory_id: first, fact: 'Person C is the prime minister of Country X', evidence_ids: [ev('u-later')] }))
      .toEqual(expect.objectContaining({ outcome: 'duplicate', memory_id: first }));
  });
});

class CountingProvider implements EmbeddingProvider {
  readonly fingerprint = 'counting-provider-synthetic';
  readonly model = 'counting';
  readonly dimensions = 4;
  readonly maxBatchSize = 16;
  readonly embedded: string[] = [];
  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.embedded.push(...texts);
    return texts.map((text) => [text.length % 7, text.length % 5, 1, text.length % 3]);
  }
  async embedQuery(text: string): Promise<number[]> { return [text.length % 7, 1, 1, 1]; }
}

describe('world_update embedding', () => {
  it('indexes topic + head fact and re-embeds the anchor when a new head lands', async () => {
    const root = tempDir();
    const store = new RelationshipMemoryStore(root, 'subject');
    const provider = new CountingProvider();
    const clock = { now: '2026-05-01T00:00:00.000Z' };
    const runtime = new RelationshipMemoryRuntime(store, new Map(EVENTS.map((item) => [item.evidence_id!, item])), () => clock.now, new Map(), false,
      new FileBackedSemanticRetriever(provider, path.join(root, 'index', 'index.json')));
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    await runtime.prepareCurrentMemorySemanticIndex();
    expect(provider.embedded).toEqual([`${TOPIC}\nPerson A is the prime minister of Country X`]);

    await runtime.prepareCurrentMemorySemanticIndex();
    clock.now = '2026-05-02T00:00:00.000Z';
    runtime.reinforce('batch-2', { memory_id: memoryId, evidence_ids: [ev('u-again')], world_revision_id: runtime.currentWorldUpdate(memoryId)!.world_update!.head.revision_id });
    expect(store.listReinforcements()).toHaveLength(1);
    await runtime.prepareCurrentMemorySemanticIndex();
    expect(provider.embedded).toHaveLength(1);

    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-3', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    await runtime.prepareCurrentMemorySemanticIndex();
    expect(provider.embedded).toEqual([
      `${TOPIC}\nPerson A is the prime minister of Country X`,
      `${TOPIC}\nPerson B is the prime minister of Country X`,
    ]);
  });
});

describe('world_update replay', () => {
  it('replays each new write to the same outcome without writing again', () => {
    const { store, runtime, clock } = setup();
    store.beginBatch('batch-1', clock.now);
    const remember = anchor([ev('u-first')]);
    const first = runtime.rememberKind('batch-1', 'world_update', remember);
    expect(runtime.rememberKind('batch-1', 'world_update', remember)).toEqual({ outcome: 'duplicate', memory_id: first.memory_id });
    expect(store.listWorldRevisions()).toHaveLength(1);
    expect(runtime.finalizeBatch('batch-1', true)).toBe('completed');

    clock.now = '2026-05-10T09:00:00.000Z';
    store.beginBatch('batch-2', clock.now);
    const update = { memory_id: first.memory_id!, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] };
    expect(runtime.worldUpdate('batch-2', update).outcome).toBe('accepted');
    expect(runtime.worldUpdate('batch-2', update)).toEqual({ outcome: 'duplicate', memory_id: first.memory_id });
    const same = { memory_id: first.memory_id!, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('tool-found')] };
    const sameResult = runtime.worldUpdate('batch-2', same);
    expect(sameResult.outcome).toBe('duplicate');
    expect(runtime.worldUpdate('batch-2', same)).toEqual(sameResult);
    const wrongKind = { memory_id: first.memory_id!, fact: 'Person D leads Country X', evidence_ids: [ev('a-belief')] };
    const rejected = runtime.worldUpdate('batch-2', wrongKind);
    expect(runtime.worldUpdate('batch-2', wrongKind)).toEqual(rejected);
    expect(store.listWorldRevisions()).toHaveLength(2);
    expect(runtime.finalizeBatch('batch-2', true)).toBe('completed');

    // The same revision from another batch is recognised and not appended twice.
    clock.now = '2026-05-11T09:00:00.000Z';
    store.beginBatch('batch-3', clock.now);
    const otherId = runtime.rememberKind('batch-3', 'world_update', anchor([ev('u-listing')], { summary: 'Example Corp listing' }, 'Example Corp is private')).memory_id!;
    const listing = { memory_id: otherId, fact: 'Example Corp is publicly listed', as_of: '2026-05-13', evidence_ids: [ev('u-listing')] };
    expect(runtime.worldUpdate('batch-3', listing).outcome).toBe('accepted');
    expect(runtime.worldUpdate('batch-4', listing)).toEqual(expect.objectContaining({ outcome: 'duplicate' }));
    expect(store.listWorldRevisionsForMemoryIds([otherId])).toHaveLength(2);
  });
});

describe('world_update stays out of the Letta surface', () => {
  it('keeps MEMORY_KINDS and the Letta tool inventory as on main', () => {
    expect(MEMORY_KINDS).toEqual(['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference']);
    expect(CANONICAL_MEMORY_KINDS).toEqual([...MEMORY_KINDS, 'world_update']);
    const { runtime } = setup();
    expect(buildRelationshipTools(runtime, 'batch-1', (value) => value, { includeMaintenanceReviewTools: true }).map((tool) => tool.name)).toEqual([
      'memory_search', 'entity_search', 'entity_remember', 'memory_reinforce',
      'memory_remember_personal_experience', 'memory_remember_shared_experience', 'memory_remember_relationship_event',
      'memory_remember_inside_joke', 'memory_remember_user_preference', 'suggest_memory_relation',
    ]);
    expect(RELATIONSHIP_EXTERNAL_TOOLS).toEqual([
      'memory_search', 'memory_reinforce',
      'memory_remember_personal_experience', 'memory_remember_shared_experience', 'memory_remember_relationship_event',
      'memory_remember_inside_joke', 'memory_remember_user_preference', 'entity_search', 'entity_remember', 'suggest_memory_relation',
    ]);
    expect(RELATIONSHIP_MUTATION_CLIENT_TOOLS).not.toContain('memory_remember_world_update');
  });

  it('keeps world_update closed to the legacy import and to owner kind changes', () => {
    const content = { schema_version: 1, kind: 'world_update', summary: 'Country X', participants: ['user'], payload: { topic: 'Country X', fact: 'Person A' } };
    expect(validateSemanticContent(content)).toEqual(expect.objectContaining({ ok: false, code: 'invalid_kind' }));
    const { store, runtime } = setup();
    const owner = new RelationshipMemoryOwnerControlPlane(store, () => '2026-05-20T00:00:00.000Z');
    const worldId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    const preferenceId = runtime.rememberKind('batch-1', 'user_preference', {
      summary: 'Reads news in the morning', participants: ['user'], evidence_ids: [ev('u-pref')],
      payload: { topic: 'news', preference: 'Reads the news in the morning' },
    }).memory_id!;
    expect(() => owner.revise(preferenceId, { revision_id: 'rev-1', kind: 'world_update', summary: 'Country X', participants: ['user'], payload: { topic: 'Country X', fact: 'Person A' } })).toThrow(/invalid_kind/);
    expect(() => owner.revise(worldId, { revision_id: 'rev-2', kind: 'user_preference', summary: 'news', participants: ['user'], payload: { topic: 'news', preference: 'news' } })).toThrow(/invalid_kind/);
    // The fact moves only through revisions: an owner edit of it would be hidden by the head, so it is refused.
    expect(() => owner.revise(worldId, { revision_id: 'rev-3', kind: 'world_update', summary: 'Leader of Country X', participants: ['user'], payload: { topic: TOPIC, fact: 'Person Z leads Country X' } })).toThrow(/invalid_world_revision/);
    const current = owner.getEffective(worldId)!;
    expect(owner.revise(worldId, { revision_id: 'rev-4', kind: 'world_update', summary: 'Leader of Country X', participants: current.participants, payload: current.payload }).action).toBe('revise');
    expect(materializeCurrentMemoryView(store).find((memory) => memory.memory_id === worldId)!.summary).toBe('Leader of Country X');
  });

  it('leaves the Letta projection (blocks and revision) unchanged by a world_update', () => {
    const { store, runtime } = setup();
    runtime.rememberKind('batch-1', 'user_preference', {
      summary: 'Reads news in the morning', participants: ['user'], evidence_ids: [ev('u-pref')],
      payload: { topic: 'news', preference: 'Reads the news in the morning' },
    });
    const before = rebuildProjection(store);
    runtime.rememberKind('batch-2', 'world_update', anchor([ev('u-first')]));
    expect(rebuildProjection(store)).toEqual(before);
  });

  it('counts world_update in the admin summary only when one exists', () => {
    const { store, runtime } = setup();
    const owner = new RelationshipMemoryOwnerControlPlane(store);
    expect(summarizeRelationshipMemory(owner).countsByKind).not.toHaveProperty('world_update');
    runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')]));
    expect(summarizeRelationshipMemory(owner).countsByKind).toEqual(expect.objectContaining({ world_update: 1, user_preference: 0 }));
  });
});

describe('world_update review round 1', () => {
  const replayOf = (base: CanonicalMessage, conversationId: string): CanonicalMessage => ({ ...base, conversation_id: conversationId, evidence_id: `${base.evidence_id}-${conversationId}` });
  const REPLAYED = replayOf(EVENTS[0], 'conv-replay');
  const SPRUCE_AGAIN = event('u-spruce-again', 'user_text', '2026-05-15T08:00:00Z', 'Person A is back as prime minister of Country X.');

  function setupWith(extra: CanonicalMessage[], failureInjector?: FailureInjector) {
    const root = tempDir();
    const store = new RelationshipMemoryStore(root, 'subject', failureInjector);
    const clock = { now: '2026-05-01T00:00:00.000Z' };
    const runtime = new RelationshipMemoryRuntime(store, new Map([...EVENTS, ...extra].map((item) => [item.evidence_id!, item])), () => clock.now);
    return { root, store, runtime, clock };
  }
  const headOf = (runtime: RelationshipMemoryRuntime, memoryId: string) => runtime.currentWorldUpdate(memoryId)!.world_update!.head;

  it('refuses a reinforcement that confirms a revision which is no longer the head', async () => {
    const { store, runtime, clock } = setupWith([]);
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    const seen = headOf(runtime, memoryId).revision_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-b', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    clock.now = '2026-05-10T10:00:00.000Z';
    const stale = runtime.reinforce('batch-a', { memory_id: memoryId, evidence_ids: [ev('u-again')], world_revision_id: seen });
    expect(stale).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'stale_world_revision' }));
    expect(runtime.reinforce('batch-a', { memory_id: memoryId, evidence_ids: [ev('u-again')], world_revision_id: seen })).toEqual(stale);
    expect(store.listReinforcements()).toHaveLength(0);
    const [card] = await runtime.memorySearchRecallHybridWithEvidence({ kind: 'world_update' });
    expect(card.world_update!.last_confirmed).toBe('2026-05-10T08:00:00Z');
    expect(card.quote_snippets.map((snippet) => snippet.quote)).toEqual(['Country X has a new prime minister: Person B.']);

    expect(runtime.reinforce('batch-c', { memory_id: memoryId, evidence_ids: [ev('tool-found')] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'invalid_reinforcement' }));
    const head = headOf(runtime, memoryId).revision_id!;
    expect(runtime.reinforce('batch-c', { memory_id: memoryId, evidence_ids: [ev('tool-found')], world_revision_id: head })).toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(store.listReinforcements()[0].world_revision_id).toBe(head);
    expect(runtime.currentWorldUpdate(memoryId)!.world_update!.last_confirmed).toBe('2026-05-11T08:00:00Z');
  });

  it('counts only reinforcements tied to the head, whatever their write time', () => {
    const { store, runtime, clock } = setupWith([]);
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    const r1 = headOf(runtime, memoryId).revision_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    const late = EVENTS.find((item) => item.evidence_id === ev('u-again'))!;
    store.appendReinforcement({
      schema_version: 1, reinforcement_id: 'reinforce-late-r1', memory_id: memoryId, batch_id: 'direct', world_revision_id: r1,
      evidence_ids: ['ev-late'], latest_evidence_at: '2026-06-01T00:00:00Z', recorded_at: '2026-06-01T00:00:00.000Z',
    }, [{ evidence_id: 'ev-late', memory_id: memoryId, conversation_id: late.conversation_id, message_id: late.message_id, role: 'user', quote: late.quote, captured_at: '2026-06-01T00:00:00Z', source_evidence_id: late.evidence_id, event_kind: 'user_text', block_index: 0 }]);
    const view = runtime.currentWorldUpdate(memoryId)!.world_update!;
    expect(view.last_confirmed).toBe('2026-05-10T08:00:00Z');
    expect(view.head_evidence_ids).not.toContain('ev-late');
  });

  it('treats the same transcript block replayed under another conversation as a duplicate, not a new revision', () => {
    const { store, runtime, clock } = setupWith([REPLAYED, SPRUCE_AGAIN]);
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    clock.now = '2026-05-11T09:00:00.000Z';
    expect(runtime.worldUpdate('batch-3', { memory_id: memoryId, fact: 'Person A is the prime minister of Country X', evidence_ids: [REPLAYED.evidence_id!] }).outcome).toBe('duplicate');
    expect(runtime.worldUpdate('batch-3', { memory_id: memoryId, fact: 'Person A is the prime minister of Country X', as_of: '2026-04-01', evidence_ids: [REPLAYED.evidence_id!] }).outcome).toBe('duplicate');
    expect(store.listWorldRevisions()).toHaveLength(2);
    expect(headOf(runtime, memoryId).fact).toBe('Person B is the prime minister of Country X');

    clock.now = '2026-05-15T09:00:00.000Z';
    expect(runtime.worldUpdate('batch-4', { memory_id: memoryId, fact: 'Person A is the prime minister of Country X', evidence_ids: [SPRUCE_AGAIN.evidence_id!] }).outcome).toBe('accepted');
    expect(headOf(runtime, memoryId).fact).toBe('Person A is the prime minister of Country X');
    expect(store.listWorldRevisions()).toHaveLength(3);
  });

  it.each(['Person B', 'Person E', 'Person F', 'Person G', 'Person H', 'Person J'])('keeps a same-millisecond revision (%s) as head when a torn r1 is repaired later', (name) => {
    let failNext = true;
    const { store, runtime } = setupWith([], (phase) => {
      if (phase !== 'world_revision_commit' || !failNext) return false;
      failNext = false;
      return true;
    });
    const proposal = anchor([ev('u-first')]);
    expect(runtime.rememberKind('batch-torn', 'world_update', proposal).outcome).toBe('retryable_failed');
    const [torn] = store.listMemories();
    const fact = `${name} is the prime minister of Country X`;
    expect(runtime.worldUpdate('batch-other', { memory_id: torn.memory_id, fact, evidence_ids: [ev('u-changed')] }).outcome).toBe('accepted');
    expect(runtime.rememberKind('batch-torn', 'world_update', proposal).outcome).toBe('duplicate');
    const view = runtime.currentWorldUpdate(torn.memory_id)!.world_update!;
    expect(view.revisions!.map((item) => item.fact)).toEqual(['Person A is the prime minister of Country X', fact]);
    expect(view.head.fact).toBe(fact);
  });

  it('serves one current fact per card: summary is derived from topic and head, the owner view keeps the stored one', async () => {
    const { store, runtime, clock } = setupWith([]);
    const memoryId = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')], { summary: 'Person A is the prime minister of Country X' })).memory_id!;
    clock.now = '2026-05-10T09:00:00.000Z';
    runtime.worldUpdate('batch-2', { memory_id: memoryId, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    const served = `${TOPIC}：Person B is the prime minister of Country X`;
    for (const hits of [
      await runtime.memorySearchMaintenanceCurrentWithEvidence({ kind: 'world_update' }),
      await runtime.memorySearchRecallHybridWithEvidence({ kind: 'world_update' }),
      await runtime.memorySearchHybridWithEvidence({ kind: 'world_update' }),
      runtime.memorySearch({ kind: 'world_update' }),
    ]) {
      expect(hits.map((hit) => hit.summary)).toEqual([served]);
      expect(JSON.stringify(hits)).not.toContain('Person A is the prime minister');
    }
    expect(runtime.memorySearch({ query: 'Person A is' })).toEqual([]);
    expect(await runtime.memorySearchRecallHybridWithEvidence({ trigger: 'Person A is' })).toEqual([]);
    expect(new RelationshipMemoryOwnerControlPlane(store).getEffective(memoryId)!.summary).toBe('Person A is the prime minister of Country X');
    expect(materializeCurrentMemoryView(store).find((memory) => memory.memory_id === memoryId)!.summary).toBe('Person A is the prime minister of Country X');
  });

  it('shows a merged pair as one card on every search path', async () => {
    const { root, store, runtime, clock } = setupWith([]);
    const first = runtime.rememberKind('batch-1', 'world_update', anchor([ev('u-first')])).memory_id!;
    clock.now = '2026-05-12T09:00:00.000Z';
    const second = runtime.rememberKind('batch-2', 'world_update', anchor([ev('u-later')], { summary: 'Country X leadership' }, 'Quillon is the prime minister of Country X')).memory_id!;
    clock.now = '2026-05-13T09:00:00.000Z';
    runtime.worldUpdate('batch-3', { memory_id: first, fact: 'Person B is the prime minister of Country X', evidence_ids: [ev('u-changed')] });
    const pair = runtime.suggestMaintenanceReview('batch-4', 'relation', { memory_ids: [first, second], relation: 'same_meaning', reason: 'one topic' }).review_id!;
    new RelationshipMemoryResolutionControlPlane(store, () => '2026-05-20T00:00:00.000Z').resolveReview(pair, { resolution_id: 'res-merge', relation: 'same_meaning', target_memory_id: first });

    const head = 'Person B is the prime minister of Country X';
    const recall = new RelationshipMemoryRecallSession({ rootDir: root, subjectId: 'subject', transcriptRoots: [] });
    const direct = (recall.relationshipMemorySearch({ query: 'Country X' }) as any).results.filter((item: any) => item.kind === 'world_update');
    for (const hits of [
      direct,
      runtime.memorySearch({ kind: 'world_update' }),
      await runtime.memorySearchHybridWithEvidence({ kind: 'world_update' }),
      await runtime.memorySearchRecallHybridWithEvidence({ kind: 'world_update' }),
    ]) {
      expect(hits.map((hit: any) => [hit.memory_id, hit.payload.fact, hit.world_update.revision_count])).toEqual([[first, head, 3]]);
    }
    expect(runtime.memorySearch({ query: 'Quillon' })).toEqual([]);
    expect((recall.relationshipMemorySearch({ query: 'Quillon' }) as any).results.filter((item: any) => item.kind === 'world_update')).toEqual([]);
    // Owner views still inspect the raw anchors.
    expect(new RelationshipMemoryOwnerControlPlane(store).search({ kind: 'world_update' }).map((memory) => memory.memory_id).sort()).toEqual([first, second].sort());
  });
});
