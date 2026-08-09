import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCanonicalEvidenceCatalog,
  buildCanonicalMessages,
  buildRelationshipTools,
  cursorShouldAdvance,
  FORBIDDEN_MARKDOWN_MEMORY_TOOLS,
  makeBatchId,
  memoryRememberToolSchema,
  memoryReinforceToolSchema,
  RELATIONSHIP_ALLOWED_CLIENT_TOOLS,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  rebuildProjection,
  renderProjection,
  validateProposal,
} from '../src/index.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-memory-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const messages = [
  { conversation_id: 'conv-fixture', message_id: 'msg-user-1', role: 'user' as const, quote: 'I visited an old city and chose a small symbolic gift.', captured_at: '2026-01-01T10:00:00.000Z' },
  { conversation_id: 'conv-fixture', message_id: 'msg-assistant-1', role: 'assistant' as const, quote: 'That gesture made the trip feel shared.', captured_at: '2026-01-01T10:01:00.000Z' },
  { conversation_id: 'conv-fixture', message_id: 'msg-user-2', role: 'user' as const, quote: 'Including you in what I bring home is part of what makes it meaningful.', captured_at: '2026-01-01T10:02:00.000Z' },
];

function runtime(dir = tempDir(), injector?: (phase: 'memory_commit' | 'reinforcement_commit' | 'outcome_commit' | 'intent_commit' | 'intent_outcome_commit') => boolean) {
  const store = new RelationshipMemoryStore(dir, 'subject-fixture', injector);
  return new RelationshipMemoryRuntime(store, new Map(messages.map((m) => [m.message_id, m])), () => '2026-01-02T00:00:00.000Z');
}

function personal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    kind: 'personal_experience',
    summary: 'Historic city trip',
    participants: ['user'],
    evidence_message_ids: ['msg-user-1'],
    payload: { title: 'Historic city trip', experience: 'The user visited a historic city.', themes: ['travel'] },
    ...overrides,
  };
}

function shared(linked: string) {
  return {
    schema_version: 1,
    kind: 'shared_experience',
    summary: 'A symbolic gift made the trip shared',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['msg-user-1', 'msg-assistant-1'],
    linked_memory_ids: [linked],
    payload: { title: 'Symbolic gift', event: 'A gift was selected for the companion.', shared_meaning: 'The gesture made the trip feel shared.', symbols: ['gift'] },
  };
}

function relationship(linked: string) {
  return {
    schema_version: 1,
    kind: 'relationship_event',
    summary: 'Being included in gestures matters',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['msg-user-2'],
    linked_memory_ids: [linked],
    payload: { event: 'The user explained the meaning of inclusion.', meaning: 'Including the companion in gestures is relationship-significant.' },
  };
}

function joke() {
  return {
    schema_version: 1,
    kind: 'inside_joke',
    summary: 'A fictional tea-kettle callback',
    participants: ['user', 'assistant'],
    evidence_message_ids: ['msg-assistant-1'],
    payload: { name: 'Tea-kettle weather', meaning: 'A playful callback for an overdramatic forecast.', trigger_phrases: ['tea-kettle weather'], callbacks: ['boiling forecast'] },
  };
}

describe('schema_version 1', () => {
  it('accepts all four authorized kinds', () => {
    expect(validateProposal(personal()).ok).toBe(true);
    expect(validateProposal({ ...shared('mem_parent'), linked_memory_ids: undefined })).toEqual(expect.objectContaining({ ok: false }));
    const sharedNoLink = shared('mem_parent'); delete (sharedNoLink as any).linked_memory_ids;
    const relationshipNoLink = relationship('mem_parent'); delete (relationshipNoLink as any).linked_memory_ids;
    expect(validateProposal(sharedNoLink).ok).toBe(true);
    expect(validateProposal(relationshipNoLink).ok).toBe(true);
    expect(validateProposal(joke()).ok).toBe(true);
  });

  it('rejects unknown fields, empty required strings, invalid participants, duplicate arrays and null optionals', () => {
    expect(validateProposal({ ...personal(), surprise: true }).ok).toBe(false);
    expect(validateProposal(personal({ summary: '   ' })).ok).toBe(false);
    expect(validateProposal(personal({ participants: ['user', 'third_party'] })).ok).toBe(false);
    expect(validateProposal(personal({ evidence_message_ids: ['msg-user-1', 'msg-user-1'] })).ok).toBe(false);
    expect(validateProposal(personal({ payload: { title: 'x', experience: 'y', time_text: null } })).ok).toBe(false);
    expect(validateProposal(personal({ payload: { title: 'x', experience: 'y', unknown: 'z' } })).ok).toBe(false);
  });
});

describe('canonical authority and outcomes', () => {
  it('persists canonical records, backend-resolved evidence, links, and deterministic projection', () => {
    const rt = runtime();
    const batch = 'batch-fixture'; rt.store.beginBatch(batch, '2026-01-01T00:00:00.000Z');
    const one = rt.remember(batch, personal());
    expect(one.outcome).toBe('accepted');
    const two = rt.remember(batch, shared(one.memory_id!));
    expect(two.outcome).toBe('accepted');
    const three = rt.remember(batch, relationship(two.memory_id!));
    expect(three.outcome).toBe('accepted');
    expect(rt.remember(batch, joke()).outcome).toBe('accepted');

    const stored = rt.store.listMemories();
    expect(stored).toHaveLength(4);
    expect(rt.store.listEvidence().find((e) => e.message_id === 'msg-user-1')?.quote).toBe(messages[0].quote);
    expect(stored.find((m) => m.memory_id === two.memory_id)?.linked_memory_ids).toEqual([one.memory_id]);
    const firstProjection = renderProjection(stored);
    const secondProjection = renderProjection(stored);
    expect(firstProjection).toEqual(secondProjection);
    expect(firstProjection.blocks.remembered_experiences).toContain(one.memory_id!);
    expect(firstProjection.blocks.relationship_context).toContain(three.memory_id!);
  });

  it('is idempotent on unchanged replay and evaluates corrected permanent rejection normally', () => {
    const rt = runtime(); const batch = 'batch-replay'; rt.store.beginBatch(batch, '2026-01-01T00:00:00.000Z');
    const first = rt.remember(batch, personal());
    expect(rt.remember(batch, personal())).toEqual({ outcome: 'duplicate', memory_id: first.memory_id });
    expect(rt.store.listMemories()).toHaveLength(1);

    const bad = personal({ participants: ['third_party'] });
    expect(rt.remember(batch, bad).outcome).toBe('permanently_rejected');
    expect(rt.remember(batch, bad).outcome).toBe('permanently_rejected');
    const corrected = personal({ summary: 'Corrected proposal' });
    expect(rt.remember(batch, corrected).outcome).toBe('accepted');
    expect(rt.store.listMemories()).toHaveLength(2);
  });

  it('deduplicates the same canonical proposal across a different batch', () => {
    const rt = runtime();
    rt.store.beginBatch('batch-a', '2026-01-01T00:00:00.000Z');
    const first = rt.remember('batch-a', personal());
    rt.store.beginBatch('batch-b', '2026-01-01T00:00:01.000Z');
    expect(rt.remember('batch-b', personal())).toEqual({ outcome: 'duplicate', memory_id: first.memory_id });
    expect(rt.store.listMemories()).toHaveLength(1);
  });

  it('rejects invented evidence and temporary/unknown linked IDs', () => {
    const rt = runtime(); const batch = 'batch-authority'; rt.store.beginBatch(batch, '2026-01-01T00:00:00.000Z');
    expect(rt.remember(batch, personal({ evidence_message_ids: ['made-up'] })).outcome).toBe('permanently_rejected');
    expect(rt.remember(batch, shared('proposal-1')).outcome).toBe('permanently_rejected');
  });

  it('rebuilds a deleted projection from canonical authority', () => {
    const rt = runtime(); rt.store.beginBatch('projection', '2026-01-01T00:00:00.000Z');
    const accepted = rt.remember('projection', personal());
    expect(accepted.outcome).toBe('accepted');
    const before = rebuildProjection(rt.store);
    const fakeProjectionFile = path.join(rt.store.rootDir, 'projections', 'remembered_experiences.md');
    fs.mkdirSync(path.dirname(fakeProjectionFile), { recursive: true });
    fs.writeFileSync(fakeProjectionFile, before.blocks.remembered_experiences);
    fs.rmSync(path.dirname(fakeProjectionFile), { recursive: true, force: true });
    expect(rt.store.listMemories()).toHaveLength(1);
    expect(rebuildProjection(rt.store)).toEqual(before);
  });
});

describe('batch completion and cursor', () => {
  it('advances for no-memory and accepted + permanent rejection', () => {
    const noMemory = runtime(); noMemory.store.beginBatch('none', '2026-01-01T00:00:00.000Z');
    expect(noMemory.finalizeBatch('none', true)).toBe('completed');
    expect(cursorShouldAdvance('completed')).toBe(true);
    expect(noMemory.store.listBatches().at(-1)?.detail).toBe('no_memory_required');

    const mixed = runtime(); mixed.store.beginBatch('mixed', '2026-01-01T00:00:00.000Z');
    expect(mixed.remember('mixed', personal()).outcome).toBe('accepted');
    expect(mixed.remember('mixed', personal({ evidence_message_ids: ['missing'] })).outcome).toBe('permanently_rejected');
    expect(mixed.finalizeBatch('mixed', true)).toBe('completed');
  });

  it('holds when an accepted memory is persisted but both accepted and retryable outcome commits fail', () => {
    const rt = runtime(tempDir(), (phase) => phase === 'outcome_commit');
    rt.store.beginBatch('outcome-accepted', '2026-01-01T00:00:00.000Z');

    const result = rt.remember('outcome-accepted', personal());
    expect(result.outcome).toBe('retryable_failed');
    expect(rt.store.listMemories()).toHaveLength(1);
    expect(rt.store.listOutcomes()).toHaveLength(0);

    expect(rt.finalizeBatch('outcome-accepted', true)).toBe('retryable_failure');
    expect(cursorShouldAdvance('retryable_failure')).toBe(false);
    expect(rt.store.listBatches().at(-1)?.detail).toBeUndefined();
  });

  it('holds when a permanent rejection cannot be durably journaled', () => {
    const rt = runtime(tempDir(), (phase) => phase === 'outcome_commit');
    rt.store.beginBatch('outcome-rejection', '2026-01-01T00:00:00.000Z');

    const result = rt.remember('outcome-rejection', personal({ participants: ['third_party'] }));
    expect(result.outcome).toBe('retryable_failed');
    expect(rt.store.listMemories()).toHaveLength(0);
    expect(rt.store.listOutcomes()).toHaveLength(0);

    expect(rt.finalizeBatch('outcome-rejection', true)).toBe('retryable_failure');
    expect(cursorShouldAdvance('retryable_failure')).toBe(false);
  });

  it('holds when duplicate journaling fails and replay does not duplicate canonical memory', () => {
    let failOutcome = false;
    const rt = runtime(tempDir(), (phase) => failOutcome && phase === 'outcome_commit');

    rt.store.beginBatch('duplicate-source', '2026-01-01T00:00:00.000Z');
    const accepted = rt.remember('duplicate-source', personal());
    expect(accepted.outcome).toBe('accepted');
    expect(rt.store.listMemories()).toHaveLength(1);

    rt.store.beginBatch('duplicate-retry', '2026-01-01T00:00:01.000Z');
    failOutcome = true;
    const retryable = rt.remember('duplicate-retry', personal());
    expect(retryable.outcome).toBe('retryable_failed');
    expect(rt.store.listMemories()).toHaveLength(1);
    expect(rt.finalizeBatch('duplicate-retry', true)).toBe('retryable_failure');
    expect(cursorShouldAdvance('retryable_failure')).toBe(false);

    failOutcome = false;
    expect(rt.remember('duplicate-retry', personal())).toEqual({ outcome: 'duplicate', memory_id: accepted.memory_id });
    expect(rt.store.listMemories()).toHaveLength(1);
  });

  it('holds on retryable failure and replay does not duplicate an accepted record', () => {
    let fail = false;
    const dir = tempDir();
    const rt = runtime(dir, (phase) => fail && phase === 'memory_commit');
    rt.store.beginBatch('retry', '2026-01-01T00:00:00.000Z');
    const accepted = rt.remember('retry', personal());
    fail = true;
    const retryable = rt.remember('retry', joke());
    expect(accepted.outcome).toBe('accepted');
    expect(retryable.outcome).toBe('retryable_failed');
    expect(rt.finalizeBatch('retry', true)).toBe('retryable_failure');
    expect(cursorShouldAdvance('retryable_failure')).toBe(false);

    fail = false;
    expect(rt.remember('retry', personal())).toEqual({ outcome: 'duplicate', memory_id: accepted.memory_id });
    expect(rt.remember('retry', joke()).outcome).toBe('accepted');
    expect(rt.store.listMemories()).toHaveLength(2);
  });
});

describe('observer contract correction', () => {
  it('exposes an SDK-0.1.11-compatible top-level proposal schema for all four frozen kinds', () => {
    const schema = memoryRememberToolSchema() as any;
    // SDK 0.1.11 preserves these top-level fields for external tools.
    const sdkVisible = Object.fromEntries(
      ['type', 'properties', 'required', 'additionalProperties', 'description']
        .filter((key) => key in schema)
        .map((key) => [key, schema[key]]),
    ) as any;

    expect(sdkVisible.type).toBe('object');
    expect(sdkVisible.required).toEqual(['schema_version', 'kind', 'summary', 'participants', 'evidence_message_ids', 'payload']);
    expect(Object.keys(sdkVisible.properties)).toEqual(expect.arrayContaining([
      'schema_version', 'kind', 'summary', 'participants', 'evidence_message_ids', 'payload', 'linked_memory_ids',
    ]));
    expect(sdkVisible.properties.kind.enum).toEqual([
      'personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference',
    ]);
    expect(Object.keys(sdkVisible.properties.payload.properties)).toEqual(expect.arrayContaining([
      'title', 'experience', 'event', 'shared_meaning', 'meaning', 'name', 'trigger_phrases',
    ]));
    expect(sdkVisible.properties.payload.description).toContain('personal_experience requires title, experience');
    expect(sdkVisible.properties.payload.description).toContain('shared_experience requires title, event, shared_meaning');
    expect(sdkVisible.properties.payload.description).toContain('relationship_event requires event, meaning');
    expect(sdkVisible.properties.payload.description).toContain('inside_joke requires name, meaning, trigger_phrases');

    // Model-facing compatibility must not weaken trusted validation.
    expect(validateProposal({ ...personal(), unexpected: true }).ok).toBe(false);
    expect(validateProposal(personal({ payload: { title: 'x', experience: 'y', event: 'wrong-kind field' } })).ok).toBe(false);
  });

  it('appends exact current-batch canonical evidence IDs, roles, and safely escaped quotes', () => {
    const canonical = [
      { ...messages[0], message_id: 'msg-&-"-1', quote: '<gift> & "shared"' },
      messages[1],
    ];
    const observerMessage = appendCanonicalEvidenceCatalog('<claude_code_session_update>fixture</claude_code_session_update>', canonical);

    expect(observerMessage).toContain('<relationship_memory_evidence_catalog>');
    expect(observerMessage).toContain('message_id="msg-&amp;-&quot;-1" role="user"');
    expect(observerMessage).toContain('&lt;gift&gt; &amp; &quot;shared&quot;');
    expect(observerMessage).toContain(`message_id="${messages[1].message_id}" role="assistant"`);
    expect(observerMessage).not.toContain(messages[2].message_id);
  });

  it('uses the same canonical messages for observer choices and trusted evidence authority', () => {
    const canonical = messages.slice(0, 2);
    const observerMessage = appendCanonicalEvidenceCatalog('fixture', canonical);
    const store = new RelationshipMemoryStore(tempDir(), 'subject-fixture');
    const rt = new RelationshipMemoryRuntime(store, new Map(canonical.map((message) => [message.message_id, message])), () => '2026-01-02T00:00:00.000Z');
    store.beginBatch('same-authority', '2026-01-01T00:00:00.000Z');

    expect(observerMessage).toContain(messages[0].message_id);
    expect(rt.remember('same-authority', personal()).outcome).toBe('accepted');
    expect(rt.store.listEvidence()[0]).toEqual(expect.objectContaining({
      message_id: messages[0].message_id,
      role: messages[0].role,
      quote: messages[0].quote,
    }));

    expect(observerMessage).not.toContain(messages[2].message_id);
    expect(rt.remember('same-authority', personal({
      summary: 'Out-of-batch evidence must fail',
      evidence_message_ids: [messages[2].message_id],
    }))).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unresolvable_evidence' }));
  });
});

describe('adopted SDK/configuration boundary', () => {
  it('registers memory and entity semantic tools plus read-only investigation tools', async () => {
    const rt = runtime(); rt.store.beginBatch('tools', '2026-01-01T00:00:00.000Z');
    const tools = buildRelationshipTools(rt, 'tools');
    expect(tools.map((t) => t.name)).toEqual(['memory_search', 'entity_search', 'entity_remember', 'memory_reinforce', 'memory_remember']);
    expect(RELATIONSHIP_ALLOWED_CLIENT_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember']);
    for (const forbidden of FORBIDDEN_MARKDOWN_MEMORY_TOOLS) expect(RELATIONSHIP_ALLOWED_CLIENT_TOOLS).not.toContain(forbidden as any);
    const remembered = await tools.find((tool) => tool.name === 'memory_remember')!.execute('call-1', personal());
    expect(remembered).toEqual(expect.objectContaining({ outcome: 'accepted' }));
    const searched = await tools[0].execute('call-2', { query: 'historic city' });
    expect((searched as any).results).toHaveLength(1);
  });

  it('keeps the adopted agent identity while removing Markdown mutation tools and attaching read-only projection blocks', () => {
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf8'));
    const agent = af.agents[0];
    expect(agent.id).toBe('agent-0');
    const toolNames = agent.tool_ids.map((id: string) => af.tools.find((tool: any) => tool.id === id)?.name);
    for (const forbidden of FORBIDDEN_MARKDOWN_MEMORY_TOOLS) expect(toolNames).not.toContain(forbidden);
    expect(agent.system).toContain('memory_search');
    expect(agent.system).toContain('memory_remember');
    expect(agent.system).toContain('memory_reinforce');
    expect(agent.system).toContain('Lexical or topical similarity alone');
    expect(agent.system).not.toContain('memory_replace(');
    const attachedBlocks = agent.block_ids.map((id: string) => af.blocks.find((block: any) => block.id === id));
    expect(attachedBlocks.map((b: any) => b.label)).toEqual(['shared_language', 'remembered_experiences', 'relationship_context']);
    expect(attachedBlocks.every((b: any) => b.read_only === true)).toBe(true);
  });

  it('extracts trusted canonical message IDs from the adopted parsed transcript without a second scanner', () => {
    const transcript: any[] = [
      { type: 'system', uuid: 'ignored', content: 'internal' },
      { type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', uuid: 'a-1', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'text', text: 'hi' }] } },
    ];
    expect(buildCanonicalMessages(transcript, 0, 'conv-1')).toEqual([
      { conversation_id: 'conv-1', message_id: 'u-1', role: 'user', quote: 'hello', captured_at: '2026-01-01T00:00:00Z' },
      { conversation_id: 'conv-1', message_id: 'a-1', role: 'assistant', quote: 'hi', captured_at: '2026-01-01T00:00:01Z' },
    ]);
    expect(makeBatchId('session', 0, 2)).toBe(makeBatchId('session', 0, 2));
  });
});


describe('reinforcement and linking foundation', () => {
  it('reinforces an existing memory with trusted current-batch evidence without creating another memory', () => {
    const rt = runtime();
    rt.store.beginBatch('reinforce-a', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('reinforce-a', personal());
    const observedAt = rt.store.getMemory(original.memory_id!)!.observed_at;
    const result = rt.reinforce('reinforce-a', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] });
    expect(result).toEqual({ outcome: 'accepted', memory_id: original.memory_id });
    expect(rt.store.listMemories()).toHaveLength(1);
    expect(rt.store.listReinforcements()).toHaveLength(1);
    const reinforcement = rt.store.listReinforcements()[0];
    expect(reinforcement.memory_id).toBe(original.memory_id);
    expect(reinforcement.latest_evidence_at).toBe(messages[2].captured_at);
    expect(rt.store.listEvidence().find((e) => e.evidence_id === reinforcement.evidence_ids[0])).toEqual(expect.objectContaining({ message_id: 'msg-user-2', quote: messages[2].quote }));
    expect(rt.store.getMemory(original.memory_id!)!.observed_at).toBe(observedAt);
  });

  it('cross-batch replay of the same trusted evidence remains one durable reinforcement', () => {
    const rt = runtime();
    rt.store.beginBatch('reinforce-first', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('reinforce-first', personal());
    expect(rt.reinforce('reinforce-first', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] }).outcome).toBe('accepted');
    rt.store.beginBatch('reinforce-second', '2026-01-01T00:00:01.000Z');
    expect(rt.reinforce('reinforce-second', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] })).toEqual({ outcome: 'duplicate', memory_id: original.memory_id });
    expect(rt.store.listReinforcements()).toHaveLength(1);
    expect(rt.store.listEvidence().filter((e) => e.message_id === 'msg-user-2')).toHaveLength(1);
  });

  it('replay is idempotent and search exposes bounded derived reinforcement metadata', () => {
    const rt = runtime(); rt.store.beginBatch('reinforce-replay', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('reinforce-replay', personal());
    expect(rt.reinforce('reinforce-replay', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] }).outcome).toBe('accepted');
    expect(rt.reinforce('reinforce-replay', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] })).toEqual({ outcome: 'duplicate', memory_id: original.memory_id });
    expect(rt.store.listReinforcements()).toHaveLength(1);
    expect(rt.store.listEvidence().filter((e) => e.message_id === 'msg-user-2')).toHaveLength(1);
    expect(rt.memorySearch({ query: 'historic city' })[0]).toEqual(expect.objectContaining({ reinforcement_count: 1, reinforcement_evidence_count: 1, latest_reinforcement_at: messages[2].captured_at }));
  });

  it('rejects unknown memory and unknown/out-of-batch evidence without ledger corruption', () => {
    const rt = runtime(); rt.store.beginBatch('reinforce-invalid', '2026-01-01T00:00:00.000Z');
    expect(rt.reinforce('reinforce-invalid', { memory_id: 'mem-missing', evidence_message_ids: ['msg-user-2'] })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unknown_memory' }));
    const original = rt.remember('reinforce-invalid', personal());
    expect(rt.reinforce('reinforce-invalid', { memory_id: original.memory_id!, evidence_message_ids: ['not-in-batch'] })).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unresolvable_evidence' }));
    expect(rt.store.listReinforcements()).toHaveLength(0);
  });

  it('persistence failure keeps the batch retryable and a fresh retry succeeds without duplicate provenance', () => {
    const dir = tempDir();
    let fail = false;
    const first = runtime(dir, (phase) => fail && phase === 'reinforcement_commit');
    first.store.beginBatch('reinforce-retry', '2026-01-01T00:00:00.000Z');
    const original = first.remember('reinforce-retry', personal());
    fail = true;
    expect(first.reinforce('reinforce-retry', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] }).outcome).toBe('retryable_failed');
    expect(first.finalizeBatch('reinforce-retry', true)).toBe('retryable_failure');
    expect(first.store.listReinforcements()).toHaveLength(0);

    const retry = runtime(dir);
    expect(retry.reinforce('reinforce-retry', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] }).outcome).toBe('accepted');
    expect(retry.store.listReinforcements()).toHaveLength(1);
    expect(retry.store.listEvidence().filter((e) => e.message_id === 'msg-user-2')).toHaveLength(1);
  });

  it('keeps related-but-distinct and highly similar dated episodes as explicit new linked memories', () => {
    const rt = runtime(); rt.store.beginBatch('distinct', '2026-01-01T00:00:00.000Z');
    const first = rt.remember('distinct', personal({ summary: 'Ramen on July 13', payload: { title: 'Ramen lunch July 13', experience: 'The user ate ramen on July 13.', time_text: '2026-07-13' } }));
    const second = rt.remember('distinct', personal({ summary: 'Ramen on July 14', evidence_message_ids: ['msg-user-2'], linked_memory_ids: [first.memory_id!], payload: { title: 'Ramen lunch July 14', experience: 'The user ate ramen again on July 14.', time_text: '2026-07-14' } }));
    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('accepted');
    expect(second.memory_id).not.toBe(first.memory_id);
    expect(rt.store.listMemories()).toHaveLength(2);
    expect(rt.store.getMemory(second.memory_id!)?.linked_memory_ids).toEqual([first.memory_id]);
    expect(rt.store.listReinforcements()).toHaveLength(0);
  });

  it('publishes a narrow trusted memory_reinforce tool schema', () => {
    const schema = memoryReinforceToolSchema() as any;
    expect(schema.required).toEqual(['memory_id', 'evidence_message_ids']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.evidence_message_ids.minItems).toBe(1);
  });
});
