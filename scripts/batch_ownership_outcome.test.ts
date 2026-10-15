import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNativeWorkerPayloadFile, sendViaNativeClient, type LiveWorkerPayload } from './send_worker_native.js';
import { readPendingSubconWhispers } from './subcon_whisper_queue.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';

// End-to-end through the real native client-tool loop: only the Letta stream is faked.

const dirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

type ToolCall = { name: string; args: unknown };
type Step = (toolReturns: any[]) => ToolCall[];

/** Each step sees the previous round's tool returns and emits the next approval requests. */
function scriptedLetta(steps: Step[]) {
  const bodies: any[] = [];
  let round = 0;
  return {
    bodies,
    client: {
      conversations: {
        messages: {
          async create(_conversationId: string, body: any) {
            bodies.push(body);
            const returns = body.messages?.[0]?.tool_returns ?? [];
            const step = steps[round];
            const calls = step ? step(returns) : [];
            round += 1;
            return (async function* () {
              if (calls.length > 0) {
                yield {
                  message_type: 'approval_request_message',
                  tool_calls: calls.map((call, index) => ({
                    name: call.name,
                    arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
                    tool_call_id: `call-${round}-${index}`,
                  })),
                };
                yield { message_type: 'stop_reason', stop_reason: 'requires_approval' };
              } else {
                yield { message_type: 'stop_reason', stop_reason: 'end_turn' };
              }
            })();
          },
        },
      },
    },
  };
}

function setup(): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-ownership-'));
  dirs.push(root);
  process.env.RELATIONSHIP_MEMORY_DIR = root;
  process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'kohaku';
  process.env.LETTA_API_KEY = 'test-only';
  process.env.TMPDIR = root;
  seedMemory(root);
  return { root };
}

function seedMemory(root: string): void {
  new RelationshipMemoryStore(root, 'kohaku').appendMemory({
    schema_version: 1,
    memory_id: 'mem-tea',
    subject_id: 'kohaku',
    kind: 'shared_experience',
    summary: '猫和琥珀聊到绿茶。',
    participants: ['user', 'assistant'],
    payload: { title: '绿茶', event: '猫和琥珀聊到绿茶。', shared_meaning: '关于绿茶的共同片段。' },
    status: 'active',
    observed_at: '2026-08-02T10:00:00.000Z',
    created_at: '2026-08-02T10:00:00.000Z',
    source_key: 'source-mem-tea',
    dedupe_key: 'dedupe-mem-tea',
  }, [{
    evidence_id: 'evidence-mem-tea',
    memory_id: 'mem-tea',
    conversation_id: 'conv-old',
    message_id: 'message-mem-tea',
    role: 'user',
    quote: '猫以前说过绿茶。',
    captured_at: '2026-08-02T10:00:00.000Z',
    event_kind: 'user_text',
  }]);
}

const evidence = {
  conversation_id: 'conversation-now', message_id: 'message-now', evidence_id: 'evidence-now',
  event_kind: 'user_text' as const, role: 'user' as const,
  quote: '猫明确说自己偏好安静的咖啡店。', captured_at: '2026-10-15T12:00:00.000Z',
};

const rememberArgs = {
  summary: '猫明确说自己偏好安静的咖啡店。', participants: ['user'], evidence_ids: [evidence.evidence_id],
  payload: { topic: '咖啡店环境', preference: '猫偏好安静的咖啡店。' },
};

function asyncPayload(root: string, batchId: string): LiveWorkerPayload {
  return {
    agentId: 'agent-test', conversationId: 'conversation-test', sessionId: 'session-ownership',
    message: '<claude_code_session_update>test</claude_code_session_update>', cwd: root,
    batchId, canonicalMessages: [evidence], assistantIntents: [], latestUserMessage: '绿茶',
    newLastProcessedIndex: 7,
  };
}

const search = (purpose: string): ToolCall => ({ name: 'memory_search', args: { purpose, query: '绿茶' } });
const parse = (toolReturn: any) => JSON.parse(toolReturn.tool_return);
const firstSnippet = (returns: any[]) => parse(returns[0]).results.find((hit: any) => hit.memory_id === 'mem-tea').quote_snippets[0].snippet_id;

async function runAsync(root: string, batchId: string, steps: Step[]) {
  const letta = scriptedLetta(steps);
  const completion = await sendViaNativeClient(asyncPayload(root, batchId), {
    createClient: () => letta.client,
    openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
  });
  const batch = new RelationshipMemoryStore(root, 'kohaku').listBatches().filter((item) => item.batch_id === batchId).at(-1);
  return { completion, batch, bodies: letta.bodies };
}

const toolReturnsOf = (body: any) => body.messages?.[0]?.tool_returns ?? [];

describe('ownership-based batch outcome', () => {
  it('completes the batch when only an optional whisper call was rejected and the model recovered', async () => {
    const { root } = setup();
    const { completion, batch, bodies } = await runAsync(root, 'batch-whisper-recovered', [
      () => [search('foreground_recall')],
      () => [{ name: 'deliver_whisper', args: { memory_id: 'mem-from-an-earlier-turn', snippet_ids: ['snippet-old'] } }],
      (returns) => {
        expect(returns[0].status).toBe('error');
        expect(returns[0].tool_return).toContain('Surfaced this turn: mem-tea (snippet_ids: ');
        return [{ name: 'memory_remember_user_preference', args: rememberArgs }];
      },
    ]);
    expect(completion).toBe('completed');
    expect(batch).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(batch).not.toHaveProperty('retry_reasons');
    expect(parse(toolReturnsOf(bodies[3])[0]).outcome).toBe('accepted');
  });

  it('advances the transcript cursor through the payload-file entrypoint after a rejected whisper', async () => {
    const { root } = setup();
    const letta = scriptedLetta([
      () => [search('foreground_recall')],
      () => [{ name: 'deliver_whisper', args: { memory_id: 'mem-unknown', snippet_ids: ['snippet-x'] } }],
    ]);
    const payloadFile = path.join(root, 'payload.json');
    fs.writeFileSync(payloadFile, JSON.stringify(asyncPayload(root, 'batch-cursor')));
    await runNativeWorkerPayloadFile(payloadFile, {
      createClient: () => letta.client,
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
    });
    const stateDir = path.join(root, '.letta', 'claude');
    const stateFile = fs.readdirSync(stateDir).find((name) => name.includes('session-ownership'));
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, stateFile!), 'utf8')).lastProcessedIndex).toBe(7);
  });

  it('lets the ledger win: a retryable memory outcome still holds the batch even with a clean turn', async () => {
    const { root } = setup();
    vi.spyOn(RelationshipMemoryStore.prototype, 'appendMemory').mockImplementation(() => { throw new Error('disk full'); });
    const { completion, batch } = await runAsync(root, 'batch-ledger-wins', [
      () => [{ name: 'memory_remember_user_preference', args: rememberArgs }],
      () => [search('foreground_recall')],
    ]);
    expect(completion).toBe('retryable_failure');
    expect(batch?.retry_reasons).toEqual(expect.arrayContaining(['memory_retryable']));
    expect(batch?.retry_reasons).not.toContain('turn_failed');
  });

  it('holds the batch when an owned-work tool throws an unrecorded exception', async () => {
    const { root } = setup();
    vi.spyOn(RelationshipMemoryRuntime.prototype, 'rememberKind').mockImplementation(() => { throw new Error('unexpected store state'); });
    const { completion, batch } = await runAsync(root, 'batch-owned-throw', [
      () => [search('foreground_recall')],
      () => [{ name: 'memory_remember_user_preference', args: rememberArgs }],
    ]);
    expect(completion).toBe('retryable_failure');
    expect(batch?.retry_reasons).toEqual(['attempt_retryable']);
  });

  it('holds the batch when an owned-work call has unparseable arguments', async () => {
    const { root } = setup();
    const { completion, batch } = await runAsync(root, 'batch-bad-json', [
      () => [search('foreground_recall')],
      () => [{ name: 'memory_remember_user_preference', args: '{"summary": ' }],
    ]);
    expect(completion).toBe('retryable_failure');
    expect(batch?.retry_reasons).toEqual(['attempt_retryable']);
  });

  it('does not hold the batch for a rejected relation suggestion (model-input validation)', async () => {
    const { root } = setup();
    const { completion, bodies } = await runAsync(root, 'batch-suggest-rejected', [
      () => [search('foreground_recall')],
      () => [{ name: 'suggest_memory_relation', args: { memory_ids: ['mem-tea', 'mem-unsearched'], relation: 'related', reason: 'test' } }],
    ]);
    expect(toolReturnsOf(bodies[2])[0].status).toBe('error');
    expect(completion).toBe('completed');
  });

  it('holds the batch when a maintenance search fails but not when a foreground_recall search fails', async () => {
    const { root } = setup();
    const spy = vi.spyOn(RelationshipMemoryRuntime.prototype, 'memorySearchMaintenanceCurrentWithEvidence')
      .mockImplementation(async () => { throw new Error('index unavailable'); });
    const maintenance = await runAsync(root, 'batch-maintenance-search-down', [
      () => [search('foreground_recall')],
      () => [search('maintenance')],
    ]);
    expect(maintenance.completion).toBe('retryable_failure');
    expect(maintenance.batch?.retry_reasons).toEqual(['attempt_retryable']);
    spy.mockRestore();

    const original = RelationshipMemoryRuntime.prototype.memorySearchRecallHybridWithEvidence;
    let calls = 0;
    vi.spyOn(RelationshipMemoryRuntime.prototype, 'memorySearchRecallHybridWithEvidence')
      .mockImplementation(async function (this: RelationshipMemoryRuntime, ...args: any[]) {
        calls += 1;
        if (calls === 1) throw new Error('semantic provider timeout');
        return original.apply(this, args as any);
      });
    const foreground = await runAsync(root, 'batch-foreground-search-down', [
      () => [search('foreground_recall')],
      () => [search('foreground_recall')],
    ]);
    expect(foreground.completion).toBe('completed');
  });

  it('keeps transport failures retryable as turn_failed', async () => {
    const { root } = setup();
    const { completion, batch } = await runAsync(root, 'batch-no-search', []);
    expect(completion).toBe('retryable_failure');
    expect(batch?.retry_reasons).toEqual(['turn_failed']);
  });

  it('answers a second deliver_whisper with already_resolved instead of a tool error', async () => {
    const { root } = setup();
    let snippetId = '';
    const { completion, bodies } = await runAsync(root, 'batch-double-whisper', [
      () => [search('foreground_recall')],
      (returns) => {
        snippetId = firstSnippet(returns);
        return [{ name: 'deliver_whisper', args: { memory_id: 'mem-tea', snippet_ids: [snippetId] } }];
      },
      () => [{ name: 'deliver_whisper', args: { memory_id: 'mem-tea', snippet_ids: [snippetId] } }],
    ]);
    expect(parse(toolReturnsOf(bodies[2])[0]).status).toBe('ok');
    const second = toolReturnsOf(bodies[3])[0];
    expect(second.status).toBe('success');
    expect(parse(second).status).toBe('already_resolved');
    expect(completion).toBe('completed');
    expect(readPendingSubconWhispers(root, 'session-ownership')).toHaveLength(1);
  });

  it('applies the same rule in sync mode: a recovered whisper rejection completes and cleans up', async () => {
    const { root } = setup();
    const checkpointFile = path.join(root, 'checkpoint.json');
    const letta = scriptedLetta([
      () => [search('foreground_recall')],
      () => [{ name: 'deliver_whisper', args: { memory_id: 'mem-unknown', snippet_ids: ['snippet-x'] } }],
    ]);
    let cleaned = 0;
    const completion = await sendViaNativeClient({
      mode: 'sync', agentId: 'agent-sync', syncAgentId: 'agent-sync', syncBlockIds: [],
      conversationId: 'conversation-sync', sessionId: 'session-sync',
      message: '<subcon_sync_foreground_turn>绿茶</subcon_sync_foreground_turn>', cwd: root,
      batchId: 'batch-sync', canonicalMessages: [], assistantIntents: [], latestUserMessage: '绿茶',
      syncCheckpointFile: checkpointFile, syncTurnId: 'turn-sync', cleanupSyncResourcesOnFinish: true,
    }, {
      createClient: () => letta.client,
      cleanupCompleted: async () => { cleaned += 1; },
    });
    expect(completion).toBe('completed');
    expect(cleaned).toBe(1);
    expect(JSON.parse(fs.readFileSync(checkpointFile, 'utf8')).status).toBe('no_whisper');
  });
});
