import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRelationshipObserverBatch } from './relationship_observer_runner.js';
import type { NativeLettaClientLike } from './native_letta_backfill.js';

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-native-observer-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeClient(responses: any[], serverTools: any[] = []): NativeLettaClientLike & { bodies: any[] } {
  const bodies: any[] = [];
  return {
    bodies,
    agents: {
      async retrieve() { return { tools: serverTools }; },
      async update() { return {}; },
      tools: { async attach() { return {}; } },
    },
    tools: { async upsert() { return { id: 'unused' }; } },
    runs: { async retrieve(runId) { throw new Error(`unexpected run retrieve: ${runId}`); } },
    conversations: {
      messages: {
        async stream() { throw new Error('unexpected recovery stream'); },
        async create(_conversationId, body) {
          bodies.push(body);
          const response = responses.shift();
          if (!response) throw new Error('unexpected native Letta request');
          return (async function* () {
            for (const message of response.messages ?? []) yield message;
            if (response.stop_reason) yield { message_type: 'stop_reason', stop_reason: response.stop_reason };
          })();
        },
      },
    },
  };
}

describe('realtime relationship observer native Letta client lane', () => {
  it('sends only relationship client tools and drains native approval returns', async () => {
    const client = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: { name: 'memory_search', arguments: '{"query":"京都"}', tool_call_id: 'call-search' },
        }],
        stop_reason: 'requires_approval',
      },
      { messages: [], stop_reason: 'end_turn' },
    ]);

    const result = await runRelationshipObserverBatch({
      agentId: 'agent-test',
      conversationId: 'conversation-test',
      message: 'observe this batch',
      cwd: '/unused-by-native-client',
      batchId: 'batch-native-realtime',
      canonicalMessages: [],
      rootDir: tempRoot(),
      subjectId: 'kohaku',
      client,
    });

    expect(result).toBe('completed');
    expect(client.bodies).toHaveLength(2);
    expect(client.bodies[0]).toEqual(expect.objectContaining({ agent_id: 'agent-test', streaming: true }));
    expect(client.bodies[0].client_tools.map((tool: any) => tool.name).sort()).toEqual([
      'entity_remember', 'entity_search', 'memory_reinforce', 'memory_remember', 'memory_search',
    ].sort());
    expect(client.bodies[1].messages).toEqual([{
      type: 'tool_return',
      tool_returns: [{ type: 'tool', tool_call_id: 'call-search', tool_return: '{"results":[]}', status: 'success' }],
    }]);
  });

  it('fails closed when the persistent relationship agent has server tools attached', async () => {
    const logs: string[] = [];
    const client = fakeClient([], [{ id: 'tool-shell', name: 'Bash' }]);
    const result = await runRelationshipObserverBatch({
      agentId: 'agent-test',
      conversationId: 'conversation-test',
      message: 'observe this batch',
      cwd: '/unused-by-native-client',
      batchId: 'batch-native-boundary',
      canonicalMessages: [],
      rootDir: tempRoot(),
      subjectId: 'kohaku',
      client,
      log: (message) => logs.push(message),
    });

    expect(result).toBe('retryable_failure');
    expect(client.bodies).toHaveLength(0);
    expect(logs.join('\n')).toContain('unexpected server tools attached: Bash');
  });
});
