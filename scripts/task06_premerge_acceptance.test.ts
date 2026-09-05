import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRelationshipTools,
  RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS,
} from '../relationship-memory/src/adapter/index.js';
import {
  backfillStateNeedsFreshConversation,
  type BackfillState,
} from '../relationship-memory/src/backfill/index.js';
import {
  validateProposal,
  type CanonicalMessage,
  type MemoryKind,
} from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import {
  MEMORY_REMEMBER_TOOL_NAMES,
  RelationshipMemoryRuntime,
} from '../relationship-memory/src/tools/index.js';
import {
  getConversationRetryMarkerFile,
  getOrCreateConversation,
  loadSyncState,
  saveSyncState,
  type SyncState,
} from './conversation_utils.js';
import { runRelationshipObserverBatch } from './relationship_observer_runner.js';
import { runNativeWorkerPayloadFile } from './send_worker_native.js';
import type { NativeLettaClientLike } from './native_letta_backfill.js';

const roots: string[] = [];
const envKeys = ['RELATIONSHIP_MEMORY_DIR', 'RELATIONSHIP_MEMORY_SUBJECT_ID', 'LETTA_API_KEY', 'LETTA_HOME'] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllGlobals();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function canonicalEvidence(): CanonicalMessage {
  return {
    conversation_id: 'conversation-evidence',
    message_id: 'message-evidence',
    evidence_id: 'evidence-user-1',
    event_kind: 'user_text',
    role: 'user',
    quote: '猫明确说自己偏好安静的咖啡店。',
    captured_at: '2026-09-05T00:00:00.000Z',
  };
}

function fakeClient(responses: any[]): NativeLettaClientLike & { bodies: Array<{ conversationId: string; body: any }> } {
  const bodies: Array<{ conversationId: string; body: any }> = [];
  return {
    bodies,
    tools: {
      async upsert() { return { id: 'unused-tool' }; },
    },
    agents: {
      async retrieve() { return { tools: [] }; },
      async update() { return { tools: [] }; },
      tools: { async attach() { return {}; } },
    },
    conversations: {
      messages: {
        async create(conversationId, body) {
          bodies.push({ conversationId, body });
          const response = responses.shift();
          if (!response) throw new Error(`unexpected native Letta request for ${conversationId}`);
          return (async function* () {
            for (const message of response.messages ?? []) yield message;
            if (response.stop_reason) {
              yield typeof response.stop_reason === 'string'
                ? { message_type: 'stop_reason', stop_reason: response.stop_reason }
                : response.stop_reason;
            }
          })();
        },
      },
    },
  } as NativeLettaClientLike & { bodies: Array<{ conversationId: string; body: any }> };
}

function validProposal(kind: MemoryKind): Record<string, unknown> {
  const base = {
    schema_version: 1,
    kind,
    summary: '猫明确表达了一项稳定偏好。',
    participants: ['user'],
    evidence_message_ids: ['message-evidence'],
  };
  const payloads: Record<MemoryKind, Record<string, unknown>> = {
    personal_experience: { title: '一次明确表达偏好的对话', experience: '猫明确说自己偏好安静的咖啡店。' },
    shared_experience: { title: '一起讨论咖啡店', event: '猫和琥珀讨论适合坐下来的咖啡店。', shared_meaning: '讨论内容是选择更安静的咖啡店。' },
    relationship_event: { event: '猫向琥珀明确说明咖啡店偏好。', meaning: '琥珀获得了一项明确的稳定偏好信息。' },
    inside_joke: { name: '安静咖啡店', meaning: '关于选店时避开嘈杂环境的固定说法。', trigger_phrases: ['安静咖啡店'] },
    user_preference: { topic: '咖啡店环境', preference: '猫偏好安静的咖啡店。' },
  };
  return { ...base, payload: payloads[kind] };
}

describe('task 06 pre-merge validator and dispatch acceptance', () => {
  it('preserves the schema-v1 legal set plus exact representative rejection codes/reasons', () => {
    const kinds: MemoryKind[] = ['personal_experience', 'shared_experience', 'relationship_event', 'inside_joke', 'user_preference'];
    for (const kind of kinds) expect(validateProposal(validProposal(kind))).toEqual(expect.objectContaining({ ok: true }));

    const relationship = validProposal('relationship_event');
    const cases = [
      {
        value: { ...relationship, payload: { event: '事件', meaning: '含义', emotional_tone: '不属于此 kind' } },
        code: 'unknown_payload_field',
        reason: 'Unknown relationship_event payload field: emotional_tone',
      },
      {
        value: { ...relationship, payload: { event: '事件' } },
        code: 'invalid_payload_field',
        reason: 'relationship_event.meaning must be a non-empty string.',
      },
      {
        value: { ...relationship, payload: { event: '事件', meaning: '含义', prior_context: null } },
        code: 'invalid_optional_null',
        reason: 'relationship_event.prior_context must be omitted rather than null.',
      },
      {
        value: { ...validProposal('inside_joke'), payload: { name: '梗', meaning: '含义', trigger_phrases: [] } },
        code: 'invalid_payload_field',
        reason: 'inside_joke.trigger_phrases must be a valid non-empty unique string array.',
      },
      {
        value: { ...validProposal('personal_experience'), payload: { title: '标题', experience: '经历', themes: ['咖啡', '咖啡'] } },
        code: 'invalid_payload_field',
        reason: 'personal_experience.themes must be a unique non-empty string array.',
      },
    ];
    for (const item of cases) expect(validateProposal(item.value)).toEqual(expect.objectContaining({ ok: false, code: item.code, reason: item.reason }));
  });

  it('keeps rejected payload fields at zero canonical memory/evidence writes', () => {
    const root = tempRoot('task06-validator-');
    const evidence = canonicalEvidence();
    const store = new RelationshipMemoryStore(root, 'subject-acceptance');
    const runtime = new RelationshipMemoryRuntime(store, new Map([[evidence.message_id, evidence]]), () => '2026-09-05T00:00:01.000Z');
    store.beginBatch('batch-reject', '2026-09-05T00:00:00.000Z');

    const result = runtime.rememberKind('batch-reject', 'relationship_event', {
      summary: '猫明确表达了一项信息。',
      participants: ['user'],
      evidence_ids: [evidence.evidence_id],
      payload: { event: '事件', meaning: '含义', emotional_tone: 'wrong-kind field' },
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'permanently_rejected', rejection_code: 'unknown_payload_field' }));
    expect(store.listMemories()).toHaveLength(0);
    expect(store.listEvidence()).toHaveLength(0);
  });

  it('fixes kind at the tool dispatcher and preserves runtime.remember source_key/idempotency', async () => {
    const evidence = canonicalEvidence();
    const toolInput = {
      summary: '猫明确说自己偏好安静的咖啡店。',
      participants: ['user'],
      evidence_ids: [evidence.evidence_id],
      payload: { topic: '咖啡店环境', preference: '猫偏好安静的咖啡店。' },
      kind: 'relationship_event',
      schema_version: 999,
    };

    const toolRoot = tempRoot('task06-tool-dispatch-');
    const toolStore = new RelationshipMemoryStore(toolRoot, 'subject-acceptance');
    const toolRuntime = new RelationshipMemoryRuntime(toolStore, new Map([[evidence.message_id, evidence]]), () => '2026-09-05T00:00:01.000Z');
    toolStore.beginBatch('batch-source', '2026-09-05T00:00:00.000Z');
    const tool = buildRelationshipTools(toolRuntime, 'batch-source').find((item) => item.name === 'memory_remember_user_preference')!;
    const first = await tool.execute('call-1', toolInput) as any;
    const duplicate = await tool.execute('call-2', toolInput) as any;
    expect(first).toEqual(expect.objectContaining({ outcome: 'accepted' }));
    expect(duplicate).toEqual(expect.objectContaining({ outcome: 'duplicate', memory_id: first.memory_id }));
    expect(toolStore.listMemories()).toHaveLength(1);
    expect(toolStore.listMemories()[0].kind).toBe('user_preference');

    const directRoot = tempRoot('task06-direct-remember-');
    const directStore = new RelationshipMemoryStore(directRoot, 'subject-acceptance');
    const directRuntime = new RelationshipMemoryRuntime(directStore, new Map([[evidence.message_id, evidence]]), () => '2026-09-05T00:00:01.000Z');
    directStore.beginBatch('batch-source', '2026-09-05T00:00:00.000Z');
    const direct = directRuntime.remember('batch-source', {
      summary: toolInput.summary,
      participants: toolInput.participants,
      evidence_ids: toolInput.evidence_ids,
      payload: toolInput.payload,
      schema_version: 1,
      kind: 'user_preference',
    });
    expect(direct).toEqual(expect.objectContaining({ outcome: 'accepted', memory_id: first.memory_id }));
    expect(directStore.listMemories()[0].source_key).toBe(toolStore.listMemories()[0].source_key);
    expect(directStore.listMemories()[0].dedupe_key).toBe(toolStore.listMemories()[0].dedupe_key);
  });

  it('keeps sync relationship tools read-only at the exported runtime allowlist', () => {
    expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).toEqual(['memory_search', 'entity_search']);
    for (const name of MEMORY_REMEMBER_TOOL_NAMES) expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).not.toContain(name as any);
    expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).not.toContain('memory_reinforce' as any);
    expect(RELATIONSHIP_SYNC_ALLOWED_CLIENT_TOOLS).not.toContain('entity_remember' as any);
  });
});

describe('task 06 pre-merge old-tool and paused-backfill recovery acceptance', () => {
  it('fails closed on an old memory_remember pending call, arms rotation, then completes the held batch after a real retry rotation', async () => {
    const cwd = tempRoot('task06-live-recovery-');
    const memoryRoot = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_DIR = memoryRoot;
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'subject-acceptance';
    process.env.LETTA_API_KEY = 'test-only';
    delete process.env.LETTA_HOME;

    const sessionId = 'session-old-tool';
    const oldConversationId = 'conversation-old';
    const throughIndex = 5;
    const state: SyncState = { lastProcessedIndex: 0, sessionId, conversationId: oldConversationId };
    saveSyncState(cwd, state);

    const poisonedClient = fakeClient([{
      messages: [{
        message_type: 'approval_request_message',
        tool_call: { name: 'memory_remember', arguments: '{}', tool_call_id: 'legacy-pending-call' },
      }],
      stop_reason: 'requires_approval',
    }]);
    const firstPayload = path.join(cwd, 'payload-first.json');
    fs.writeFileSync(firstPayload, JSON.stringify({
      agentId: 'agent-test', conversationId: oldConversationId, sessionId,
      message: '<claude_code_session_update>old pending call</claude_code_session_update>',
      cwd, batchId: 'batch-held', canonicalMessages: [], assistantIntents: [], latestUserMessage: '',
      newLastProcessedIndex: throughIndex,
    }));
    await runNativeWorkerPayloadFile(firstPayload, {
      createClient: () => poisonedClient,
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
    });

    expect(poisonedClient.bodies).toHaveLength(1);
    expect(poisonedClient.bodies[0].conversationId).toBe(oldConversationId);
    expect(poisonedClient.bodies[0].body.client_tools.map((tool: any) => tool.name)).not.toContain('memory_remember');
    expect(loadSyncState(cwd, sessionId).lastProcessedIndex).toBe(0);
    const markerFile = getConversationRetryMarkerFile(cwd, sessionId);
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    expect(marker).toEqual(expect.objectContaining({ conversationId: oldConversationId, throughIndex }));

    marker.markedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return { id: 'conversation-new' }; },
      async text() { return ''; },
    })));
    const rotated = await getOrCreateConversation('test-only', 'agent-test', sessionId, cwd, state);
    expect(rotated).toBe('conversation-new');
    expect(loadSyncState(cwd, sessionId).conversationId).toBe('conversation-new');
    expect(fs.existsSync(markerFile)).toBe(false);

    const retryClient = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: { name: 'memory_search', arguments: '{"query":"恢复测试"}', tool_call_id: 'search-after-rotation' },
        }],
        stop_reason: 'requires_approval',
      },
      { messages: [], stop_reason: 'end_turn' },
    ]);
    const retryPayload = path.join(cwd, 'payload-retry.json');
    fs.writeFileSync(retryPayload, JSON.stringify({
      agentId: 'agent-test', conversationId: rotated, sessionId,
      message: '<claude_code_session_update>retry after rotation</claude_code_session_update>',
      cwd, batchId: 'batch-held', canonicalMessages: [], assistantIntents: [], latestUserMessage: '恢复测试',
      newLastProcessedIndex: throughIndex,
    }));
    await runNativeWorkerPayloadFile(retryPayload, {
      createClient: () => retryClient,
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
    });

    const retryToolNames = retryClient.bodies[0].body.client_tools.map((tool: any) => tool.name);
    expect(retryClient.bodies.every((item) => item.conversationId === 'conversation-new')).toBe(true);
    expect(retryToolNames).toEqual(expect.arrayContaining([...MEMORY_REMEMBER_TOOL_NAMES]));
    expect(retryToolNames).not.toContain('memory_remember');
    expect(loadSyncState(cwd, sessionId)).toEqual(expect.objectContaining({ lastProcessedIndex: throughIndex, conversationId: 'conversation-new' }));
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it('reuses a clean paused backfill conversation and executes a new kind-specific create tool on that same conversation', async () => {
    const root = tempRoot('task06-backfill-resume-');
    const state: BackfillState = {
      schema_version: 1,
      backfill_session_id: 'backfill-session',
      conversation_id: 'conversation-paused-clean',
      agent_id: 'agent-test',
      sources: {},
    };
    expect(backfillStateNeedsFreshConversation(state)).toBe(false);

    const evidence = canonicalEvidence();
    const client = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: {
            name: 'memory_remember_user_preference',
            arguments: JSON.stringify({
              summary: '猫明确说自己偏好安静的咖啡店。',
              participants: ['user'],
              evidence_ids: [evidence.evidence_id],
              payload: { topic: '咖啡店环境', preference: '猫偏好安静的咖啡店。' },
            }),
            tool_call_id: 'new-kind-after-pause',
          },
        }],
        stop_reason: 'requires_approval',
      },
      { messages: [], stop_reason: 'end_turn' },
    ]);
    const completion = await runRelationshipObserverBatch({
      agentId: state.agent_id!,
      conversationId: state.conversation_id!,
      message: '<relationship_memory_historical_backfill>resume</relationship_memory_historical_backfill>',
      cwd: root,
      batchId: 'batch-clean-pause',
      canonicalMessages: [evidence],
      rootDir: path.join(root, 'canonical'),
      subjectId: 'subject-acceptance',
      client,
    });

    expect(completion).toBe('completed');
    expect(client.bodies.every((item) => item.conversationId === state.conversation_id)).toBe(true);
    const toolNames = client.bodies[0].body.client_tools.map((tool: any) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([...MEMORY_REMEMBER_TOOL_NAMES]));
    expect(toolNames).not.toContain('memory_remember');
    const store = new RelationshipMemoryStore(path.join(root, 'canonical'), 'subject-acceptance');
    expect(store.listMemories()).toEqual([expect.objectContaining({ kind: 'user_preference' })]);
  });
});
