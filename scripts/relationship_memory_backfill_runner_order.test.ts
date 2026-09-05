import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  checkpoint: {} as Record<string, any>,
  retry: false,
  verifyError: undefined as Error | undefined,
  agentError: undefined as Error | undefined,
  agentId: 'agent-22222222-2222-4222-8222-222222222222',
}));

vi.mock('./backfill_runtime_safety.js', () => ({
  assertPrivilegedSnapshotRuntimeSafety: vi.fn(() => { fixture.order.push('preflight'); }),
}));
vi.mock('../relationship-memory/src/backfill/snapshot.js', () => ({
  resolveBackfillTranscriptInput: vi.fn(() => {
    fixture.order.push('resolve-transcript');
    return '/tmp/transcript.jsonl';
  }),
}));
vi.mock('../relationship-memory/src/adapter/index.js', () => ({
  relationshipMemoryRoot: vi.fn(() => '/tmp/relationship-memory'),
}));
vi.mock('./backfill_agent_config.js', () => ({
  getBackfillAgentId: vi.fn(async (_apiKey: string, _log: unknown, options: { runtime?: string }) => {
    fixture.order.push(`agent:${options.runtime ?? 'default'}`);
    if (fixture.agentError) throw fixture.agentError;
    return fixture.agentId;
  }),
  configureVerifiedOmenBackfillRuntime: vi.fn(async () => {
    fixture.order.push('verify-omen');
    if (fixture.verifyError) throw fixture.verifyError;
  }),
}));
vi.mock('./conversation_utils.js', () => ({
  createConversation: vi.fn(async () => {
    fixture.order.push('create-conversation');
    return 'conv-new';
  }),
}));
vi.mock('./relationship_observer_runner.js', () => ({
  runRelationshipObserverBatch: vi.fn(async (input: { conversationId: string }) => {
    fixture.order.push(`observer:${input.conversationId}`);
    return { status: 'completed' };
  }),
}));
vi.mock('../relationship-memory/src/backfill/index.js', () => ({
  loadBackfillState: vi.fn(() => {
    fixture.order.push('load-state');
    return fixture.checkpoint;
  }),
  saveBackfillState: vi.fn((_statePath: string, state: Record<string, any>) => {
    fixture.order.push(`save-state:${String(state.agent_id)}:${String(state.conversation_id)}`);
  }),
  backfillStateNeedsFreshConversation: vi.fn(() => {
    fixture.order.push('retry-check');
    return fixture.retry;
  }),
  runHistoricalBackfill: vi.fn(async (options: { processor: (batch: Record<string, any>) => Promise<unknown> }) => {
    fixture.order.push('run-history');
    await options.processor({
      observerMessage: 'historical batch',
      batchId: 'batch-1',
      canonicalMessages: [],
    });
    return { status: 'completed' };
  }),
}));

import { runRelationshipMemoryBackfill } from './relationship_memory_backfill_runner.js';

const args = {
  transcript: '/tmp/transcript.jsonl',
  state: '/tmp/checkpoint.json',
  root: '/tmp/relationship-memory',
  maxBatches: 1,
  maxRecords: 40,
  maxBytes: 1024,
};

beforeEach(() => {
  fixture.order.length = 0;
  fixture.retry = false;
  fixture.verifyError = undefined;
  fixture.agentError = undefined;
  fixture.checkpoint = {
    schema_version: 1,
    backfill_session_id: 'relationship-memory-backfill-fixture',
    sources: {},
  };
  process.env.LETTA_API_KEY = 'test-key';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.LETTA_API_KEY;
  vi.restoreAllMocks();
});

describe('relationship-memory shared runner ordering', () => {
  it('binds a legacy checkpoint to the resolved agent before batch execution and reuses its conversation', async () => {
    fixture.checkpoint.conversation_id = 'conv-old';

    await runRelationshipMemoryBackfill('default', args);

    expect(fixture.checkpoint.agent_id).toBe(fixture.agentId);
    expect(fixture.checkpoint.conversation_id).toBe('conv-old');
    expect(fixture.order).toEqual([
      'preflight',
      'resolve-transcript',
      'load-state',
      'agent:default',
      `save-state:${fixture.agentId}:conv-old`,
      'retry-check',
      'run-history',
      'observer:conv-old',
    ]);
  });

  it('rotates only a retryable checkpoint conversation and persists the new binding before batch execution', async () => {
    fixture.checkpoint.agent_id = fixture.agentId;
    fixture.checkpoint.conversation_id = 'conv-old';
    fixture.retry = true;

    await runRelationshipMemoryBackfill('default', args);

    expect(fixture.checkpoint.conversation_id).toBe('conv-new');
    expect(fixture.order).toEqual([
      'preflight',
      'resolve-transcript',
      'load-state',
      'agent:default',
      'retry-check',
      'create-conversation',
      `save-state:${fixture.agentId}:conv-new`,
      'run-history',
      'observer:conv-new',
    ]);
  });

  it('never enters checkpoint rotation or batch execution when Omen verification fails', async () => {
    fixture.checkpoint.agent_id = fixture.agentId;
    fixture.checkpoint.conversation_id = 'conv-old';
    fixture.verifyError = new Error('Omen verification failed');

    await expect(runRelationshipMemoryBackfill('omen', args)).rejects.toThrow('Omen verification failed');

    expect(fixture.order).toEqual([
      'preflight',
      'resolve-transcript',
      'load-state',
      'agent:omen',
      'verify-omen',
    ]);
  });

  it('rejects a checkpoint bound to another agent before conversation or batch execution', async () => {
    fixture.checkpoint.agent_id = 'agent-33333333-3333-4333-8333-333333333333';
    fixture.checkpoint.conversation_id = 'conv-old';

    await expect(runRelationshipMemoryBackfill('default', args)).rejects.toThrow('Backfill state is bound to a different agent');

    expect(fixture.order).toEqual([
      'preflight',
      'resolve-transcript',
      'load-state',
      'agent:default',
    ]);
  });
});
