import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LettaReadError,
  RelationshipMemoryOwnerControlPlane,
  RelationshipMemoryStore,
  SubconsciousAdminReadModel,
  composeSubconsciousAdminSnapshot,
  type LettaReadTransport,
  type ProviderUsageSlot,
} from '../src/index.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

class FixtureTransport implements LettaReadTransport {
  calls: Array<{ path: string; query: Record<string, unknown> }> = [];
  constructor(private readonly fixtures: Record<string, unknown | Error>) {}
  async getJson<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, query });
    const value = this.fixtures[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`missing fixture ${path}`);
    return value as T;
  }
}

function memoryFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-admin-'));
  tempDirs.push(dir);
  const store = new RelationshipMemoryStore(dir, 'subject-a');
  store.appendMemory({
    schema_version: 1,
    memory_id: 'mem-1',
    subject_id: 'subject-a',
    kind: 'personal_experience',
    summary: 'genesis summary one',
    participants: ['user'],
    payload: { title: 'Genesis', experience: 'SECRET MEMORY PAYLOAD' },
    status: 'active',
    observed_at: '2026-08-08T10:00:00Z',
    created_at: '2026-08-08T10:00:00Z',
    source_key: 'source-1',
    dedupe_key: 'dedupe-1',
  }, [{
    evidence_id: 'ev-1', memory_id: 'mem-1', conversation_id: 'memory-c1', message_id: 'memory-m1', role: 'user',
    quote: 'SECRET EVIDENCE QUOTE', captured_at: '2026-08-08T10:00:00Z',
  }]);
  store.appendMemory({
    schema_version: 1,
    memory_id: 'mem-2',
    subject_id: 'subject-a',
    kind: 'inside_joke',
    summary: 'genesis joke',
    participants: ['user', 'assistant'],
    payload: { name: 'joke', meaning: 'SECRET JOKE PAYLOAD', trigger_phrases: ['beep'] },
    status: 'active',
    observed_at: '2026-08-08T10:01:00Z',
    created_at: '2026-08-08T10:01:00Z',
    source_key: 'source-2',
    dedupe_key: 'dedupe-2',
  }, [{
    evidence_id: 'ev-2', memory_id: 'mem-2', conversation_id: 'memory-c2', message_id: 'memory-m2', role: 'assistant',
    quote: 'SECRET SECOND EVIDENCE', captured_at: '2026-08-08T10:01:00Z',
  }]);

  let now = '2026-08-08T11:00:00Z';
  const owner = new RelationshipMemoryOwnerControlPlane(store, () => now);
  owner.revise('mem-1', {
    revision_id: 'rev-1',
    kind: 'relationship_event',
    summary: 'corrected shared meaning',
    participants: ['user', 'assistant'],
    payload: { event: 'Correction', meaning: 'owner corrected meaning' },
    linked_memory_ids: ['mem-2'],
  });
  now = '2026-08-08T12:00:00Z';
  owner.deactivate('mem-2', { revision_id: 'rev-2' });
  return { store, owner };
}

function healthyFixtures(stepOverrides: Record<string, unknown | Error> = {}) {
  return {
    '/agents/agent-a': {
      id: 'agent-a',
      name: 'Subconscious',
      llm_config: {
        model: 'deepseek-v4-flash',
        handle: 'opencode-deepseek/deepseek-v4-flash',
        provider_category: 'byok',
        context_window: 1000000,
        system: 'SECRET SYSTEM PROMPT',
      },
      core_memory: 'SECRET CORE MEMORY',
    },
    '/agents/agent-a/context': {
      context_window_size_max: 1000000,
      context_window_size_current: 250000,
      num_messages: 22,
      num_archival_memory: 3,
      num_recall_memory: 5,
      num_tokens_system: 1200,
      num_tokens_core_memory: 900,
      num_tokens_messages: 12000,
      system_prompt: 'SECRET SYSTEM BODY',
      core_memory: 'SECRET CORE BODY',
      messages: [{ content: 'SECRET RAW MESSAGE' }],
      reasoning: 'SECRET HIDDEN REASONING',
    },
    '/runs/active': [],
    '/runs/': [
      {
        id: 'run-2', agent_id: 'agent-a', conversation_id: 'conversation-a', status: 'completed', stop_reason: 'end_turn',
        created_at: '2026-08-08T13:05:00Z', completed_at: '2026-08-08T13:05:02Z', prompt: 'SECRET RAW PROMPT',
      },
      {
        id: 'run-1', agent_id: 'agent-a', conversation_id: 'conversation-a', status: 'completed', stop_reason: 'end_turn',
        created_at: '2026-08-08T13:00:00Z', completed_at: '2026-08-08T13:00:02Z', messages: ['SECRET RUN MESSAGE'],
      },
    ],
    '/runs/run-2/usage': { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cache_read_tokens: 80 } },
    '/runs/run-2/metrics': { num_steps: 1, tools_used: ['memory_search'], raw_tool_args: 'SECRET TOOL ARGS', raw_tool_return: 'SECRET TOOL RETURN' },
    '/runs/run-1/usage': { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cache_read_tokens: 0 } },
    '/runs/run-1/metrics': { num_steps: 1, tools_used: [] },
    '/runs/run-2/steps': [{
      id: 'step-2', run_id: 'run-2', model: 'deepseek-v4-flash', model_handle: 'opencode/deepseek-v4-flash',
      prompt_tokens: 100, completion_tokens: 10, cached_input_tokens: 80, context_window_limit: 400000,
      reasoning: 'SECRET STEP REASONING', tool_args: 'SECRET STEP TOOL ARGS', tool_return: 'SECRET STEP TOOL RETURN',
    }],
    '/runs/run-1/steps': [{ id: 'step-1', run_id: 'run-1', prompt_tokens: 100, cached_input_tokens: 0 }],
    ...stepOverrides,
  };
}

const providerUsage: ProviderUsageSlot = {
  quality: 'provider_reported',
  source: 'provider-fixture',
  observedAt: '2026-08-08T13:10:00Z',
  remaining: 42,
  limit: 100,
  unit: 'requests',
};

describe('Subconscious admin read-model composition', () => {
  it('composes healthy runtime, recent runs, cache effectiveness, and relationship-memory summary', async () => {
    const { owner } = memoryFixture();
    const transport = new FixtureTransport(healthyFixtures());
    const snapshot = await composeSubconsciousAdminSnapshot({
      owner,
      transport,
      agentId: 'agent-a',
      providerUsage,
      now: () => new Date('2026-08-08T13:10:00Z'),
    }, { recentRunLimit: 2, cacheRunLimit: 2 });

    expect(snapshot.runtime).toMatchObject({
      availability: 'available',
      overview: {
        agentId: 'agent-a', agentName: 'Subconscious', model: 'deepseek-v4-flash',
        modelHandle: 'opencode-deepseek/deepseek-v4-flash', providerCategory: 'byok',
        configuredContextLimit: 1000000, activity: 'idle', activeRunIds: [], providerUsage,
        context: { currentTokens: 250000, maxTokens: 1000000, utilizationRatio: 0.25 },
      },
    });
    expect(snapshot.recentRuns.items.map(run => run.runId)).toEqual(['run-2', 'run-1']);
    expect(snapshot.promptCache.availability).toBe('available');
    expect(snapshot.promptCache.aggregate).toMatchObject({
      eligibleSteps: 2, coveredSteps: 2, uncoveredSteps: 0, cachedInputRatio: 0.4, coverageRatio: 1, tokenCoverageRatio: 1,
    });
    expect(snapshot.promptCache.lastRun).toEqual({
      runId: 'run-2',
      stepCount: 1,
      peakPromptStep: {
        stepId: 'step-2',
        runId: 'run-2',
        promptTokens: 100,
        completionTokens: 10,
        cachedInputTokens: 80,
        cachedInputRatio: 0.8,
        contextWindowLimit: 400000,
        model: 'deepseek-v4-flash',
        modelHandle: 'opencode/deepseek-v4-flash',
      },
    });
    expect(snapshot.promptCache.conversations).toEqual([
      expect.objectContaining({
        conversationId: 'conversation-a',
        runIds: ['run-2', 'run-1'],
        runs: [
          { runId: 'run-2', aggregate: expect.objectContaining({ cachedInputRatio: 0.8 }) },
          { runId: 'run-1', aggregate: expect.objectContaining({ cachedInputRatio: 0 }) },
        ],
        aggregate: expect.objectContaining({ cachedInputRatio: 0.4 }),
      }),
    ]);
    expect(snapshot.relationshipMemory.summary).toEqual({
      genesisMemoryCount: 2,
      effectiveMemoryCount: 2,
      activeMemoryCount: 1,
      inactiveMemoryCount: 1,
      ownerCorrectedCount: 2,
      countsByKind: {
        personal_experience: 0,
        shared_experience: 0,
        relationship_event: 1,
        inside_joke: 1,
        user_preference: 0,
      },
      ownerRevisionCount: 2,
      latestOwnerRevisionAt: '2026-08-08T12:00:00Z',
    });
  });

  it('uses the owner control-plane effective search and projects compact rows without payload/evidence', () => {
    const { owner } = memoryFixture();
    const admin = new SubconsciousAdminReadModel({ owner, transport: new FixtureTransport({}), agentId: 'agent-a' });
    const rows = admin.queryMemories({ query: 'corrected shared', kind: 'relationship_event', active: true });
    expect(rows).toEqual([{
      memoryId: 'mem-1',
      kind: 'relationship_event',
      summary: 'corrected shared meaning',
      status: 'active',
      ownerCorrected: true,
      latestRevisionId: 'rev-1',
      latestRevisionAt: '2026-08-08T11:00:00Z',
      participants: ['user', 'assistant'],
      linkedMemoryIds: ['mem-2'],
    }]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('SECRET MEMORY PAYLOAD');
    expect(serialized).not.toContain('SECRET EVIDENCE QUOTE');
  });

  it('projects the last run peak LLM prompt context instead of the agent retained-context snapshot', async () => {
    const { owner } = memoryFixture();
    const fixtures = healthyFixtures({
      '/runs/run-2/steps': [
        { id: 'step-2a', run_id: 'run-2', prompt_tokens: 120, completion_tokens: 3, cached_input_tokens: 100, context_window_limit: 400000 },
        { id: 'step-2b', run_id: 'run-2', prompt_tokens: 900, completion_tokens: 11, cached_input_tokens: 810, context_window_limit: 400000 },
      ],
    });
    const snapshot = await composeSubconsciousAdminSnapshot({ owner, transport: new FixtureTransport(fixtures), agentId: 'agent-a' });

    expect(snapshot.runtime.overview.context?.currentTokens).toBe(250000);
    expect(snapshot.promptCache.lastRun).toEqual({
      runId: 'run-2',
      stepCount: 2,
      peakPromptStep: {
        stepId: 'step-2b',
        runId: 'run-2',
        promptTokens: 900,
        completionTokens: 11,
        cachedInputTokens: 810,
        cachedInputRatio: 0.9,
        contextWindowLimit: 400000,
      },
    });
  });

  it('preserves provider usage provenance unchanged and keeps unavailable usage unknown', async () => {
    const { owner } = memoryFixture();
    const reported = await composeSubconsciousAdminSnapshot({ owner, transport: new FixtureTransport(healthyFixtures()), agentId: 'agent-a', providerUsage });
    expect(reported.runtime.overview.providerUsage).toEqual(providerUsage);

    const unavailable = await composeSubconsciousAdminSnapshot({
      owner,
      transport: new FixtureTransport(healthyFixtures()),
      agentId: 'agent-a',
      now: () => new Date('2026-08-08T13:10:00Z'),
    });
    expect(unavailable.runtime.overview.providerUsage.quality).toBe('unavailable');
    expect(unavailable.runtime.overview.providerUsage.remaining).toBeUndefined();
    expect(unavailable.runtime.overview.providerUsage.limit).toBeUndefined();
  });

  it('preserves uncovered prompt-cache telemetry as unknown instead of zero cache', async () => {
    const { owner } = memoryFixture();
    const fixtures = healthyFixtures({
      '/runs/run-2/steps': [{ id: 'step-2', run_id: 'run-2', prompt_tokens: 100 }],
      '/runs/run-1/steps': [{ id: 'step-1', run_id: 'run-1', prompt_tokens: 100 }],
    });
    const snapshot = await composeSubconsciousAdminSnapshot({ owner, transport: new FixtureTransport(fixtures), agentId: 'agent-a' });
    expect(snapshot.promptCache.aggregate).toMatchObject({ eligibleSteps: 2, coveredSteps: 0, uncoveredSteps: 2, coverageRatio: 0, tokenCoverageRatio: 0 });
    expect(snapshot.promptCache.aggregate?.cachedInputRatio).toBeUndefined();
  });

  it('keeps local memory available when Letta is unreachable and marks remote sections explicitly', async () => {
    const { owner } = memoryFixture();
    const unreachable = new LettaReadError('unreachable', 'connection refused');
    const transport = new FixtureTransport({ '/agents/agent-a': unreachable, '/runs/': unreachable });
    const snapshot = await composeSubconsciousAdminSnapshot({ owner, transport, agentId: 'agent-a' });

    expect(snapshot.relationshipMemory.availability).toBe('available');
    expect(snapshot.relationshipMemory.summary.genesisMemoryCount).toBe(2);
    expect(snapshot.relationshipMemory.rows).toHaveLength(2);
    expect(snapshot.runtime.availability).toBe('unreachable');
    expect(snapshot.runtime.overview.activity).toBe('unreachable');
    expect(snapshot.recentRuns).toMatchObject({ availability: 'unreachable', items: [] });
    expect(snapshot.promptCache.availability).toBe('unreachable');
    expect(snapshot.promptCache.aggregate).toBeUndefined();
  });

  it('represents cache-query failure explicitly without turning it into a healthy zero-cache result', async () => {
    const { owner } = memoryFixture();
    const fixtures = healthyFixtures({ '/runs/run-2/steps': new LettaReadError('http', 'steps failed', 500) });
    const snapshot = await composeSubconsciousAdminSnapshot({ owner, transport: new FixtureTransport(fixtures), agentId: 'agent-a' });

    expect(snapshot.runtime.availability).toBe('available');
    expect(snapshot.recentRuns.availability).toBe('available');
    expect(snapshot.promptCache.availability).toBe('error');
    expect(snapshot.promptCache.error).toMatchObject({ kind: 'query_error', message: 'steps failed' });
    expect(snapshot.promptCache.aggregate).toBeUndefined();
    expect(snapshot.promptCache.conversations).toEqual([]);
  });

  it('does not serialize remote secret fixture fields or local evidence/payload content', async () => {
    const { owner } = memoryFixture();
    const snapshot = await composeSubconsciousAdminSnapshot({ owner, transport: new FixtureTransport(healthyFixtures()), agentId: 'agent-a' });
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      'SECRET SYSTEM PROMPT', 'SECRET CORE MEMORY', 'SECRET SYSTEM BODY', 'SECRET CORE BODY', 'SECRET RAW MESSAGE',
      'SECRET HIDDEN REASONING', 'SECRET RAW PROMPT', 'SECRET RUN MESSAGE', 'SECRET TOOL ARGS', 'SECRET TOOL RETURN',
      'SECRET STEP REASONING', 'SECRET STEP TOOL ARGS', 'SECRET STEP TOOL RETURN', 'SECRET MEMORY PAYLOAD',
      'SECRET EVIDENCE QUOTE', 'SECRET JOKE PAYLOAD', 'SECRET SECOND EVIDENCE',
    ]) expect(serialized).not.toContain(secret);
  });

  it('never calls owner mutation/write methods while composing or querying', async () => {
    const { owner, store } = memoryFixture();
    const revise = vi.spyOn(owner, 'revise');
    const deactivate = vi.spyOn(owner, 'deactivate');
    const restore = vi.spyOn(owner, 'restore');
    const appendRevision = vi.spyOn(store, 'appendOwnerRevision');
    const appendMemory = vi.spyOn(store, 'appendMemory');
    const admin = new SubconsciousAdminReadModel({ owner, transport: new FixtureTransport(healthyFixtures()), agentId: 'agent-a' });

    await admin.snapshot();
    admin.queryMemories({ active: false });

    expect(revise).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(appendRevision).not.toHaveBeenCalled();
    expect(appendMemory).not.toHaveBeenCalled();
  });
});
