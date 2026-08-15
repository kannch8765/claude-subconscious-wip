import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCanonicalEvidenceCatalog,
  assertRelationshipClientToolInventory,
  buildCanonicalMessages,
  buildRelationshipTools,
  cursorShouldAdvance,
  FORBIDDEN_MARKDOWN_MEMORY_TOOLS,
  makeBatchId,
  memoryRememberToolSchema,
  memoryReinforceToolSchema,
  RELATIONSHIP_ALLOWED_CLIENT_TOOLS,
  RELATIONSHIP_DISALLOWED_CLIENT_TOOLS,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
  LegacyMemorySourceStore,
  rebuildProjection,
  stableId,
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


  it('lets a fresh successful attempt supersede stale retryables without deleting audit history', () => {
    const dir = tempDir();
    const first = runtime(dir, (phase) => phase === 'memory_commit');
    const firstPending = first.store.beginBatch('attempt-scope', '2026-01-01T00:00:00.000Z');
    expect(firstPending.attempt_id).toBeTruthy();
    expect(first.remember('attempt-scope', joke()).outcome).toBe('retryable_failed');
    expect(first.finalizeBatch('attempt-scope', true)).toBe('retryable_failure');

    const retry = runtime(dir);
    const retryPending = retry.store.beginBatch('attempt-scope', '2026-01-01T00:01:00.000Z');
    expect(retryPending.attempt_id).toBeTruthy();
    expect(retryPending.attempt_id).not.toBe(firstPending.attempt_id);
    expect(retry.remember('attempt-scope', personal()).outcome).toBe('accepted');
    expect(retry.finalizeBatch('attempt-scope', true)).toBe('completed');

    const outcomes = retry.store.listOutcomes().filter((item) => item.batch_id === 'attempt-scope');
    expect(outcomes.map((item) => [item.attempt_id, item.outcome])).toEqual([
      [firstPending.attempt_id, 'retryable_failed'],
      [retryPending.attempt_id, 'accepted'],
    ]);
    expect(retry.store.listBatches().at(-1)).toEqual(expect.objectContaining({
      batch_id: 'attempt-scope', attempt_id: retryPending.attempt_id, status: 'completed', created_at: '2026-01-01T00:01:00.000Z',
    }));
  });

  it('keeps a retry attempt fail-closed when that current attempt is retryable', () => {
    const dir = tempDir();
    const first = runtime(dir, (phase) => phase === 'memory_commit');
    first.store.beginBatch('attempt-current-failure', '2026-01-01T00:00:00.000Z');
    expect(first.remember('attempt-current-failure', joke()).outcome).toBe('retryable_failed');
    expect(first.finalizeBatch('attempt-current-failure', true)).toBe('retryable_failure');

    const retry = runtime(dir, (phase) => phase === 'memory_commit');
    const pending = retry.store.beginBatch('attempt-current-failure', '2026-01-01T00:01:00.000Z');
    expect(retry.remember('attempt-current-failure', personal()).outcome).toBe('retryable_failed');
    expect(retry.finalizeBatch('attempt-current-failure', true)).toBe('retryable_failure');
    expect(retry.store.listOutcomes().at(-1)).toEqual(expect.objectContaining({ attempt_id: pending.attempt_id, outcome: 'retryable_failed' }));
  });

  it('preserves fail-closed legacy behavior for pending batches without attempt provenance', () => {
    const rt = runtime();
    rt.store.finalizeBatch({ batch_id: 'legacy-attemptless', status: 'pending', created_at: '2025-12-31T23:59:00.000Z' });
    rt.store.appendOutcome({
      batch_id: 'legacy-attemptless', source_key: 'legacy-retryable', outcome: 'retryable_failed', reason: 'legacy failure', recorded_at: '2025-12-31T23:59:30.000Z',
    });
    expect(rt.finalizeBatch('legacy-attemptless', true)).toBe('retryable_failure');
  });


  it('upgrades an attemptless retry history at the next pending boundary', () => {
    const dir = tempDir();
    const legacy = runtime(dir);
    legacy.store.finalizeBatch({ batch_id: 'legacy-upgrade', status: 'pending', created_at: '2025-12-31T23:58:00.000Z' });
    legacy.store.appendOutcome({
      batch_id: 'legacy-upgrade', source_key: 'old-retryable-a', outcome: 'retryable_failed', reason: 'old failure a', recorded_at: '2025-12-31T23:58:10.000Z',
    });
    legacy.store.finalizeBatch({ batch_id: 'legacy-upgrade', status: 'retryable_failure', created_at: '2025-12-31T23:58:00.000Z', finalized_at: '2025-12-31T23:58:20.000Z' });
    legacy.store.finalizeBatch({ batch_id: 'legacy-upgrade', status: 'pending', created_at: '2025-12-31T23:59:00.000Z' });
    legacy.store.appendOutcome({
      batch_id: 'legacy-upgrade', source_key: 'old-retryable-b', outcome: 'retryable_failed', reason: 'old failure b', recorded_at: '2025-12-31T23:59:10.000Z',
    });
    legacy.store.finalizeBatch({ batch_id: 'legacy-upgrade', status: 'retryable_failure', created_at: '2025-12-31T23:59:00.000Z', finalized_at: '2025-12-31T23:59:20.000Z' });

    const upgraded = runtime(dir);
    const pending = upgraded.store.beginBatch('legacy-upgrade', '2026-01-01T00:00:00.000Z');
    expect(pending.attempt_id).toBeTruthy();
    expect(upgraded.remember('legacy-upgrade', personal()).outcome).toBe('accepted');
    expect(upgraded.finalizeBatch('legacy-upgrade', true)).toBe('completed');

    const oldRetryables = upgraded.store.listOutcomes().filter((item) => item.batch_id === 'legacy-upgrade' && item.outcome === 'retryable_failed');
    expect(oldRetryables).toHaveLength(2);
    expect(oldRetryables.every((item) => item.attempt_id === undefined)).toBe(true);
    expect(upgraded.store.listBatches().at(-1)).toEqual(expect.objectContaining({ attempt_id: pending.attempt_id, status: 'completed' }));
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
    expect(sdkVisible.required).toEqual(['schema_version', 'kind', 'summary', 'participants', 'payload']);
    expect((schema as any).oneOf).toEqual([{ required: ['evidence_ids'] }, { required: ['evidence_message_ids'] }]);
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

    expect(observerMessage).toContain('<relationship_memory_evidence_semantics>');
    expect(observerMessage).toContain('<relationship_memory_evidence_catalog trusted="transcript_provenance_only">');
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
  it('registers only relationship semantic tools and denies every builtin tool', async () => {
    const rt = runtime(); rt.store.beginBatch('tools', '2026-01-01T00:00:00.000Z');
    const tools = buildRelationshipTools(rt, 'tools');
    expect(tools.map((t) => t.name)).toEqual(['memory_search', 'entity_search', 'entity_remember', 'memory_reinforce', 'memory_remember']);
    expect(RELATIONSHIP_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember']);
    for (const forbidden of FORBIDDEN_MARKDOWN_MEMORY_TOOLS) expect(RELATIONSHIP_ALLOWED_CLIENT_TOOLS).not.toContain(forbidden as any);
    expect(RELATIONSHIP_DISALLOWED_CLIENT_TOOLS).toEqual(expect.arrayContaining(['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Task', 'Skill', 'TodoWrite']));
    for (const allowed of RELATIONSHIP_ALLOWED_CLIENT_TOOLS) expect(RELATIONSHIP_DISALLOWED_CLIENT_TOOLS).not.toContain(allowed as any);
    expect(() => assertRelationshipClientToolInventory([
      'Bash', 'TaskOutput', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'TaskStop', 'Read', 'Skill', 'Task', 'TodoWrite', 'Write',
      'memory_search', 'memory_reinforce', 'memory_remember', 'entity_search', 'entity_remember',
    ])).not.toThrow();
    expect(() => assertRelationshipClientToolInventory(['Read', 'FutureUnknownBuiltin'])).toThrow(/FutureUnknownBuiltin/);
    const remembered = await tools.find((tool) => tool.name === 'memory_remember')!.execute('call-1', personal());
    expect(remembered).toEqual(expect.objectContaining({ outcome: 'accepted' }));
    const searched = await tools[0].execute('call-2', { query: 'historic city' });
    expect((searched as any).results).toHaveLength(1);
  });

  it('keeps the dedicated backfill observer boundary isolated from the live Subconscious AgentFile', () => {
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'SubconsciousBackfill.af'), 'utf8'));
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
    const canonical = buildCanonicalMessages(transcript, 0, 'conv-1');
    expect(canonical).toEqual([
      { evidence_id: stableId('transcript_ev', { conversation_id: 'conv-1', message_id: 'u-1', block_index: 0, event_kind: 'user_text' }), conversation_id: 'conv-1', message_id: 'u-1', block_index: 0, role: 'user', event_kind: 'user_text', quote: 'hello', captured_at: '2026-01-01T00:00:00Z' },
      { evidence_id: stableId('transcript_ev', { conversation_id: 'conv-1', message_id: 'a-1', block_index: 0, event_kind: 'assistant_text' }), conversation_id: 'conv-1', message_id: 'a-1', block_index: 0, role: 'assistant', event_kind: 'assistant_text', quote: 'hi', captured_at: '2026-01-01T00:00:01Z' },
    ]);
    expect(buildCanonicalMessages(transcript, 0, 'conv-1')).toEqual(canonical);
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

  it('treats evidence already bound by the canonical memory as a duplicate no-op', () => {
    const rt = runtime();
    rt.store.beginBatch('seed-evidence', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('seed-evidence', personal());
    expect(rt.store.listEvidence().filter((e) => e.memory_id === original.memory_id)).toHaveLength(1);

    rt.store.beginBatch('reinforce-old-evidence', '2026-01-01T00:00:01.000Z');
    expect(rt.reinforce('reinforce-old-evidence', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-1'] }))
      .toEqual({ outcome: 'duplicate', memory_id: original.memory_id });
    expect(rt.store.listReinforcements()).toHaveLength(0);
    expect(rt.store.listEvidence().filter((e) => e.memory_id === original.memory_id)).toHaveLength(1);
  });

  it('reinforces only the genuinely new subset when requested evidence mixes old and new', () => {
    const rt = runtime();
    rt.store.beginBatch('seed-mixed-evidence', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('seed-mixed-evidence', personal());

    rt.store.beginBatch('reinforce-mixed-evidence', '2026-01-01T00:00:01.000Z');
    expect(rt.reinforce('reinforce-mixed-evidence', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-1', 'msg-user-2'] }))
      .toEqual({ outcome: 'accepted', memory_id: original.memory_id });
    const reinforcement = rt.store.listReinforcements()[0];
    expect(reinforcement.evidence_ids).toHaveLength(1);
    expect(rt.store.listEvidence().find((e) => e.evidence_id === reinforcement.evidence_ids[0]))
      .toEqual(expect.objectContaining({ message_id: 'msg-user-2' }));
    expect(rt.store.listEvidence().filter((e) => e.memory_id === original.memory_id)).toHaveLength(2);
  });

  it('still rejects an untrusted evidence id before filtering an already-bound trusted id', () => {
    const rt = runtime();
    rt.store.beginBatch('reinforce-old-plus-untrusted', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('reinforce-old-plus-untrusted', personal());
    expect(rt.reinforce('reinforce-old-plus-untrusted', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-1', 'not-in-batch'] }))
      .toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unresolvable_evidence' }));
    expect(rt.store.listReinforcements()).toHaveLength(0);
  });

  it('repairs a crash after reinforcement evidence append but before the reinforcement row', () => {
    const rt = runtime();
    rt.store.beginBatch('seed-half-commit', '2026-01-01T00:00:00.000Z');
    const original = rt.remember('seed-half-commit', personal());
    const evidenceId = stableId('ev', { memory_id: original.memory_id!, message_id: 'msg-user-2' });
    fs.appendFileSync(path.join(rt.store.rootDir, 'evidence.jsonl'), `${JSON.stringify({
      evidence_id: evidenceId,
      memory_id: original.memory_id!,
      conversation_id: messages[2].conversation_id,
      message_id: messages[2].message_id,
      role: messages[2].role,
      quote: messages[2].quote,
      captured_at: messages[2].captured_at,
    })}\n`);
    expect(rt.store.listEvidence().filter((item) => item.evidence_id === evidenceId)).toHaveLength(1);
    expect(rt.store.listReinforcements()).toHaveLength(0);

    rt.store.beginBatch('repair-half-commit', '2026-01-01T00:00:01.000Z');
    expect(rt.reinforce('repair-half-commit', { memory_id: original.memory_id!, evidence_message_ids: ['msg-user-2'] }))
      .toEqual({ outcome: 'accepted', memory_id: original.memory_id });
    expect(rt.store.listEvidence().filter((item) => item.evidence_id === evidenceId)).toHaveLength(1);
    expect(rt.store.listReinforcements()).toHaveLength(1);
    expect(rt.store.listReinforcements()[0].evidence_ids).toEqual([evidenceId]);
    expect(rt.finalizeBatch('repair-half-commit', true)).toBe('completed');
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

  it('accepts first transcript reinforcement for a durable legacy-provenance memory with no canonical transcript evidence', () => {
    const dir = tempDir();
    const rt = runtime(dir);
    const memoryId = 'mem-legacy-zero-evidence';
    rt.store.appendMemory({
      schema_version: 1, memory_id: memoryId, subject_id: 'subject-fixture', kind: 'inside_joke', summary: 'Legacy callback',
      participants: ['user', 'assistant'], payload: { name: 'Legacy callback', meaning: 'Imported durable relationship context.' },
      status: 'active', observed_at: '2025-12-31T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      source_key: 'legacy_memory_src_fixture', dedupe_key: stableId('dedupe', { legacy: memoryId }),
    }, []);
    new LegacyMemorySourceStore(dir).appendProvenance({
      legacy_source_id: 'legacy_source_fixture', canonical_memory_id: memoryId, disposition: 'created', recorded_at: '2026-01-01T00:00:00.000Z',
    });

    rt.store.beginBatch('legacy-reinforce', '2026-01-02T00:00:00.000Z');
    expect(rt.reinforce('legacy-reinforce', { memory_id: memoryId, evidence_message_ids: ['msg-user-2'] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(rt.store.listEvidence().filter((item) => item.memory_id === memoryId)).toHaveLength(1);
    expect(rt.store.listReinforcements().filter((item) => item.memory_id === memoryId)).toHaveLength(1);
    expect(rt.finalizeBatch('legacy-reinforce', true)).toBe('completed');
  });

  it('keeps legacy-created memories reinforceable after their first transcript reinforcement adds canonical evidence', () => {
    const dir = tempDir();
    const memoryId = 'mem-legacy-second-reinforce';
    const rt = runtime(dir);
    rt.store.appendMemory({
      schema_version: 1, memory_id: memoryId, subject_id: 'subject-fixture', kind: 'inside_joke', summary: 'Legacy callback',
      participants: ['user', 'assistant'], payload: { name: 'Legacy callback', meaning: 'Imported durable relationship context.' },
      status: 'active', observed_at: '2025-12-31T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      source_key: 'legacy_memory_src_second_fixture', dedupe_key: stableId('dedupe', { legacy: memoryId }),
    }, []);
    new LegacyMemorySourceStore(dir).appendProvenance({
      legacy_source_id: 'legacy_source_second_fixture', canonical_memory_id: memoryId, disposition: 'created', recorded_at: '2026-01-01T00:00:00.000Z',
    });

    rt.store.beginBatch('legacy-second-a', '2026-01-02T00:00:00.000Z');
    expect(rt.reinforce('legacy-second-a', { memory_id: memoryId, evidence_message_ids: ['msg-user-2'] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(rt.finalizeBatch('legacy-second-a', true)).toBe('completed');
    expect(rt.store.listEvidence().filter((item) => item.memory_id === memoryId)).toHaveLength(1);

    rt.store.beginBatch('legacy-second-b', '2026-01-02T00:01:00.000Z');
    expect(rt.reinforce('legacy-second-b', { memory_id: memoryId, evidence_message_ids: ['msg-user-1'] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(rt.finalizeBatch('legacy-second-b', true)).toBe('completed');
    expect(rt.store.listEvidence().filter((item) => item.memory_id === memoryId)).toHaveLength(2);
    expect(rt.store.listReinforcements().filter((item) => item.memory_id === memoryId)).toHaveLength(2);
  });

  it('keeps duplicate-link-only zero-evidence memories retryable', () => {
    const dir = tempDir();
    const rt = runtime(dir);
    const memoryId = 'mem-duplicate-link-only-zero-evidence';
    rt.store.appendMemory({
      schema_version: 1, memory_id: memoryId, subject_id: 'subject-fixture', kind: 'inside_joke', summary: 'Linked-only callback',
      participants: ['user', 'assistant'], payload: { name: 'Linked-only callback', meaning: 'Legacy provenance only linked to an existing canonical memory.' },
      status: 'active', observed_at: '2025-12-31T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      source_key: 'existing_nonlegacy_src_fixture', dedupe_key: stableId('dedupe', { duplicateLinkOnly: memoryId }),
    }, []);
    new LegacyMemorySourceStore(dir).appendProvenance({
      legacy_source_id: 'legacy_source_duplicate_link_fixture', canonical_memory_id: memoryId, disposition: 'duplicate_link', recorded_at: '2026-01-01T00:01:00.000Z',
    });

    rt.store.beginBatch('duplicate-link-only-reinforce', '2026-01-02T00:00:00.000Z');
    expect(rt.reinforce('duplicate-link-only-reinforce', { memory_id: memoryId, evidence_message_ids: ['msg-user-2'] }))
      .toEqual(expect.objectContaining({ outcome: 'retryable_failed', reason: expect.stringContaining('Unable to reconstruct canonical evidence provenance') }));
    expect(rt.store.listEvidence().filter((item) => item.memory_id === memoryId)).toHaveLength(0);
    expect(rt.store.listReinforcements().filter((item) => item.memory_id === memoryId)).toHaveLength(0);
    expect(rt.finalizeBatch('duplicate-link-only-reinforce', true)).toBe('retryable_failure');
  });

  it('keeps zero-evidence memories without durable legacy provenance retryable', () => {
    const rt = runtime();
    const memoryId = 'mem-corrupt-zero-evidence';
    rt.store.appendMemory({
      schema_version: 1, memory_id: memoryId, subject_id: 'subject-fixture', kind: 'inside_joke', summary: 'Unprovenanced callback',
      participants: ['user', 'assistant'], payload: { name: 'Unprovenanced callback', meaning: 'No durable origin is available.' },
      status: 'active', observed_at: '2025-12-31T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      source_key: 'unknown_src_fixture', dedupe_key: stableId('dedupe', { corrupt: memoryId }),
    }, []);

    rt.store.beginBatch('zero-evidence-no-provenance', '2026-01-02T00:00:00.000Z');
    expect(rt.reinforce('zero-evidence-no-provenance', { memory_id: memoryId, evidence_message_ids: ['msg-user-2'] }))
      .toEqual(expect.objectContaining({ outcome: 'retryable_failed', reason: expect.stringContaining('Unable to reconstruct canonical evidence provenance') }));
    expect(rt.store.listEvidence().filter((item) => item.memory_id === memoryId)).toHaveLength(0);
    expect(rt.store.listReinforcements().filter((item) => item.memory_id === memoryId)).toHaveLength(0);
    expect(rt.finalizeBatch('zero-evidence-no-provenance', true)).toBe('retryable_failure');
  });

  it('allows a same-batch retry to heal a prior provenance failure once durable legacy provenance exists', () => {
    const dir = tempDir();
    const memoryId = 'mem-legacy-retry';
    const first = runtime(dir);
    first.store.appendMemory({
      schema_version: 1, memory_id: memoryId, subject_id: 'subject-fixture', kind: 'inside_joke', summary: 'Legacy retry callback',
      participants: ['user', 'assistant'], payload: { name: 'Legacy retry callback', meaning: 'Retry should heal after provenance becomes available.' },
      status: 'active', observed_at: '2025-12-31T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      source_key: 'legacy_memory_src_retry_fixture', dedupe_key: stableId('dedupe', { retry: memoryId }),
    }, []);
    first.store.beginBatch('legacy-retry-batch', '2026-01-02T00:00:00.000Z');
    expect(first.reinforce('legacy-retry-batch', { memory_id: memoryId, evidence_message_ids: ['msg-user-2'] }).outcome).toBe('retryable_failed');
    expect(first.finalizeBatch('legacy-retry-batch', true)).toBe('retryable_failure');

    new LegacyMemorySourceStore(dir).appendProvenance({
      legacy_source_id: 'legacy_source_retry_fixture', canonical_memory_id: memoryId, disposition: 'created', recorded_at: '2026-01-02T00:01:00.000Z',
    });
    const retry = runtime(dir);
    retry.store.beginBatch('legacy-retry-batch', '2026-01-02T00:02:00.000Z');
    expect(retry.reinforce('legacy-retry-batch', { memory_id: memoryId, evidence_message_ids: ['msg-user-2'] }))
      .toEqual({ outcome: 'accepted', memory_id: memoryId });
    expect(retry.finalizeBatch('legacy-retry-batch', true)).toBe('completed');
    expect(retry.store.listEvidence().filter((item) => item.memory_id === memoryId)).toHaveLength(1);
    expect(retry.store.listReinforcements().filter((item) => item.memory_id === memoryId)).toHaveLength(1);
    const outcomes = retry.store.listOutcomes().filter((item) => item.batch_id === 'legacy-retry-batch');
    expect(outcomes.map((item) => item.outcome)).toEqual(['retryable_failed', 'accepted']);
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
    expect(schema.required).toEqual(['memory_id']);
    expect(schema.oneOf).toEqual([{ required: ['evidence_ids'] }, { required: ['evidence_message_ids'] }]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.evidence_message_ids.minItems).toBe(1);
  });
});
