import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendViaNativeClient, type LiveWorkerPayload } from './send_worker_native.js';

const dirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

function basePayload(cwd: string): LiveWorkerPayload {
  return {
    agentId: 'agent-11111111-1111-4111-8111-111111111111',
    conversationId: 'conv-11111111-1111-4111-8111-111111111111',
    sessionId: 'session-a',
    message: '<claude_code_session_update><latest_user_message>hello</latest_user_message></claude_code_session_update>',
    cwd,
    batchId: 'batch-a',
    canonicalMessages: [],
    assistantIntents: [],
    latestUserMessage: 'hello',
    latestUserMessageId: 'user-1',
  };
}

describe('async foreground receipt reuse', () => {
  it('removes duplicate surfacing and search quota when the exact latest foreground turn already resolved', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'async-receipt-resolved-'));
    dirs.push(cwd);
    process.env.LETTA_API_KEY = 'test-key';
    process.env.RELATIONSHIP_MEMORY_DIR = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'subject-a';
    delete process.env.SUBCON_STDIO_MCP_SERVERS_JSON;
    const seen: any[] = [];
    const payload = basePayload(cwd);
    payload.foregroundRecallTurns = [{
      message_id: 'user-1', turn_id: 'turn-1', delivery_state: 'emitted',
      receipt: {
        schema_version: 1, session_id: 'session-a', turn_id: 'turn-1', bundle_id: 'bundle-1',
        recorded_at: '2026-08-25T00:00:00.000Z', decision: 'selected',
        searches: [{ kind: 'prefetch', query_sha256: 'query-hash', memory_ids: ['mem-1'] }],
        selected: { memory_id: 'mem-1', snippet_ids: ['snippet-1'] }, whisper_id: 'whisper-1',
      },
    }];

    const completion = await sendViaNativeClient(payload, {
      createClient: () => ({}),
      runConversation: (async (input: any) => {
        seen.push(input);
        return { clientToolFailure: false, response: { stop_reason: { stop_reason: 'end_turn' } } };
      }) as any,
    });

    expect(completion).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0].tools.map((tool: any) => tool.name)).toContain('memory_search');
    expect(seen[0].tools.map((tool: any) => tool.name)).not.toContain('deliver_whisper');
    expect(seen[0].requiredClientToolNames).toEqual([]);
    expect(seen[0].message).toContain('<foreground_recall_receipt_catalog');
    expect(seen[0].message).toContain('decision="selected"');
  });

  it.each(['pending', 'missing'] as const)('keeps async fallback when selected foreground delivery is %s', async (deliveryState) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `async-receipt-${deliveryState}-`));
    dirs.push(cwd);
    process.env.LETTA_API_KEY = 'test-key';
    process.env.RELATIONSHIP_MEMORY_DIR = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'subject-a';
    delete process.env.SUBCON_STDIO_MCP_SERVERS_JSON;
    const payload = basePayload(cwd);
    payload.foregroundRecallTurns = [{
      message_id: 'user-1', turn_id: 'turn-1', delivery_state: deliveryState,
      receipt: {
        schema_version: 1, session_id: 'session-a', turn_id: 'turn-1', bundle_id: 'bundle-1',
        recorded_at: '2026-08-25T00:00:00.000Z', decision: 'selected', searches: [],
        selected: { memory_id: 'mem-1', snippet_ids: ['snippet-1'] }, whisper_id: 'whisper-1',
      },
    }];
    const seen: any[] = [];
    await sendViaNativeClient(payload, {
      createClient: () => ({}),
      runConversation: (async (input: any) => {
        seen.push(input);
        return { clientToolFailure: false, response: { stop_reason: { stop_reason: 'end_turn' } } };
      }) as any,
    });
    expect(seen[0].tools.map((tool: any) => tool.name)).toContain('deliver_whisper');
  });

  it('treats decision=none as resolved without requiring an emitted whisper', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'async-receipt-none-'));
    dirs.push(cwd);
    process.env.LETTA_API_KEY = 'test-key';
    process.env.RELATIONSHIP_MEMORY_DIR = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'subject-a';
    delete process.env.SUBCON_STDIO_MCP_SERVERS_JSON;
    const payload = basePayload(cwd);
    payload.foregroundRecallTurns = [{
      message_id: 'user-1', turn_id: 'turn-1', delivery_state: 'not_applicable',
      receipt: {
        schema_version: 1, session_id: 'session-a', turn_id: 'turn-1', bundle_id: 'bundle-1',
        recorded_at: '2026-08-25T00:00:00.000Z', decision: 'none', searches: [],
      },
    }];
    const seen: any[] = [];
    await sendViaNativeClient(payload, {
      createClient: () => ({}),
      runConversation: (async (input: any) => {
        seen.push(input);
        return { clientToolFailure: false, response: { stop_reason: { stop_reason: 'end_turn' } } };
      }) as any,
    });
    expect(seen[0].tools.map((tool: any) => tool.name)).not.toContain('deliver_whisper');
  });

  it('keeps legacy async whisper fallback available when no exact foreground receipt exists', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'async-receipt-missing-'));
    dirs.push(cwd);
    process.env.LETTA_API_KEY = 'test-key';
    process.env.RELATIONSHIP_MEMORY_DIR = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'subject-a';
    delete process.env.SUBCON_STDIO_MCP_SERVERS_JSON;
    const seen: any[] = [];

    const completion = await sendViaNativeClient(basePayload(cwd), {
      createClient: () => ({}),
      runConversation: (async (input: any) => {
        seen.push(input);
        return { clientToolFailure: false, response: { stop_reason: { stop_reason: 'end_turn' } } };
      }) as any,
    });

    expect(completion).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0].tools.map((tool: any) => tool.name)).toContain('memory_search');
    expect(seen[0].tools.map((tool: any) => tool.name)).toContain('deliver_whisper');
    expect(seen[0].requiredClientToolNames).toEqual([]);
    expect(seen[0].message).not.toContain('<foreground_recall_receipt_catalog');
  });
});
