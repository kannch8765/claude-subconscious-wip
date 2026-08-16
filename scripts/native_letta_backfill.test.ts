import { describe, expect, it } from 'vitest';
import {
  LEGACY_COMPLETION_TOOL_NAME,
  ensureLegacyCompletionTool,
  extractLegacyCompletion,
  reconcileLegacyCompletionRules,
  runNativeClientToolConversation,
  type NativeLettaClientLike,
} from './native_letta_backfill.js';

function fakeClient(responses: any[] = []): NativeLettaClientLike & { bodies: any[]; updates: any[]; attachments: string[]; upserts: any[] } {
  const bodies: any[] = [];
  const updates: any[] = [];
  const attachments: string[] = [];
  const upserts: any[] = [];
  const state: any = {
    tools: [],
    tool_rules: [{ type: 'continue_loop', tool_name: 'existing_tool' }],
  };
  return {
    bodies,
    updates,
    attachments,
    upserts,
    tools: {
      async upsert(body) { upserts.push(body); return { id: 'tool-native-terminal' }; },
    },
    agents: {
      async retrieve() { return state; },
      async update(_agentId, body) { updates.push(body); state.tool_rules = body.tool_rules; return state; },
      tools: {
        async attach(toolId) { attachments.push(toolId); state.tools.push({ id: toolId }); return state; },
      },
    },
    conversations: {
      messages: {
        async create(_conversationId, body) {
          bodies.push(body);
          const response = responses.shift();
          if (!response) throw new Error('unexpected native Letta request');
          return (async function* () {
            for (const message of response.messages ?? []) yield message;
            if (response.stop_reason) {
              yield typeof response.stop_reason === 'string'
                ? { message_type: 'stop_reason', stop_reason: response.stop_reason }
                : response.stop_reason;
            }
            if (response.usage) yield { message_type: 'usage_statistics', ...response.usage };
          })();
        },
      },
    },
  };
}

describe('native Letta legacy backfill harness', () => {
  it('reconciles required-before-exit plus terminal rules without deleting unrelated rules', () => {
    expect(reconcileLegacyCompletionRules([
      { type: 'continue_loop', tool_name: 'existing_tool' },
      { type: 'required_before_exit', tool_name: LEGACY_COMPLETION_TOOL_NAME, prompt_template: 'old' },
    ])).toEqual([
      { type: 'continue_loop', tool_name: 'existing_tool' },
      { type: 'required_before_exit', tool_name: LEGACY_COMPLETION_TOOL_NAME },
      { type: 'exit_loop', tool_name: LEGACY_COMPLETION_TOOL_NAME },
    ]);
  });

  it('upserts and attaches the native terminal tool once and makes rule reconciliation idempotent', async () => {
    const client = fakeClient();
    const first = await ensureLegacyCompletionTool(client, 'agent-test');
    expect(first).toMatchObject({ toolId: 'tool-native-terminal', attached: true, rulesChanged: true });
    expect(client.attachments).toEqual(['tool-native-terminal']);
    expect(client.upserts[0]).toEqual(expect.objectContaining({ enable_parallel_execution: false }));
    expect(client.updates).toHaveLength(1);
    expect((client.updates[0].tool_rules as any[]).slice(-2)).toEqual([
      { type: 'required_before_exit', tool_name: LEGACY_COMPLETION_TOOL_NAME },
      { type: 'exit_loop', tool_name: LEGACY_COMPLETION_TOOL_NAME },
    ]);

    const second = await ensureLegacyCompletionTool(client, 'agent-test');
    expect(second).toMatchObject({ attached: false, rulesChanged: false });
    expect(client.attachments).toHaveLength(1);
    expect(client.updates).toHaveLength(1);
  });

  it('fails closed on terminal stop_reason=error even without a stream error event', async () => {
    const client = fakeClient([{ messages: [], stop_reason: 'error' }]);

    await expect(runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: 'source',
      tools: [],
    })).rejects.toThrow('Letta native conversation terminated with stop_reason=error');

    expect(client.bodies).toHaveLength(1);
  });

  it('fails closed when a required live memory_search never completes', async () => {
    const client = fakeClient([{ messages: [], stop_reason: 'end_turn' }]);

    await expect(runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: '今天又在喝咖啡><🐾',
      tools: [{
        name: 'memory_search', description: 'search', parameters: { type: 'object' },
        async execute() { return { results: [] }; },
      }],
      requiredClientToolNames: ['memory_search'],
    })).rejects.toThrow('ended before required client tool completion: memory_search');
  });

  it('does not count a failed required memory_search execution as completion', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{\"query\":\"咖啡\"}', tool_call_id: 'coffee-fail' } }], stop_reason: 'requires_approval' },
      { messages: [], stop_reason: 'end_turn' },
    ]);

    await expect(runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: '今天又在喝咖啡><🐾',
      tools: [{
        name: 'memory_search', description: 'search', parameters: { type: 'object' },
        async execute() { throw new Error('search backend unavailable'); },
      }],
      requiredClientToolNames: ['memory_search'],
    })).rejects.toThrow('ended before required client tool completion: memory_search');

    expect(client.bodies[1].messages[0].tool_returns[0]).toEqual(expect.objectContaining({
      tool_call_id: 'coffee-fail',
      status: 'error',
    }));
  });

  it('accepts a model-authored semantic memory_search query and allows follow-up searches', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"咖啡 喝咖啡 相关回忆"}', tool_call_id: 'coffee-1' } }], stop_reason: 'requires_approval' },
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"京都 咖啡 高木珈琲"}', tool_call_id: 'coffee-2' } }], stop_reason: 'requires_approval' },
      { messages: [], stop_reason: 'end_turn' },
    ]);
    const seen: unknown[] = [];
    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: '今天又在喝咖啡><🐾',
      tools: [{
        name: 'memory_search', description: 'search', parameters: { type: 'object' },
        async execute(_id, args) { seen.push(args); return { results: [] }; },
      }],
      requiredClientToolNames: ['memory_search'],
    });

    expect(seen).toEqual([
      { query: '咖啡 喝咖啡 相关回忆' },
      { query: '京都 咖啡 高木珈琲' },
    ]);
    expect(seen[0]).not.toEqual({ query: '今天又在喝咖啡><🐾' });
    expect(result.clientToolFailure).toBe(false);
  });

  it('executes local client tools through native approval returns then accepts a server terminal call', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"京都"}', tool_call_id: 'call-1' } }], stop_reason: 'requires_approval' },
      { messages: [{ message_type: 'tool_call_message', tool_call: { name: LEGACY_COMPLETION_TOOL_NAME, arguments: '{"result":"no_memory_required"}', tool_call_id: 'call-2' } }], stop_reason: 'tool_rule' },
    ]);
    const seen: unknown[] = [];
    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: 'source',
      tools: [{
        name: 'memory_search', description: 'search', parameters: { type: 'object' },
        async execute(_id, args) { seen.push(args); return { results: [] }; },
      }],
    });

    expect(seen).toEqual([{ query: '京都' }]);
    expect(result.clientToolFailure).toBe(false);
    expect(extractLegacyCompletion(result.response.messages)).toBe('no_memory_required');
    expect(client.bodies).toHaveLength(2);
    expect(client.bodies[0].client_tools).toEqual([{ name: 'memory_search', description: 'search', parameters: { type: 'object' } }]);
    expect(client.bodies[0]).toEqual(expect.objectContaining({ streaming: true }));
    expect(client.bodies[1].messages).toEqual([{ type: 'tool_return', tool_returns: [{ type: 'tool', tool_call_id: 'call-1', tool_return: '{"results":[]}', status: 'success' }] }]);
  });

  it('optionally retries only the transient same-conversation 409 before sending one tool return', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"京都"}', tool_call_id: 'call-busy' } }], stop_reason: 'requires_approval' },
      { messages: [], stop_reason: 'end_turn' },
    ]);
    const originalCreate = client.conversations.messages.create.bind(client.conversations.messages);
    let continuationCalls = 0;
    client.conversations.messages.create = async (conversationId, body) => {
      if ((body.messages as any[])?.[0]?.type === 'tool_return') {
        continuationCalls += 1;
        if (continuationCalls === 1) {
          throw new Error('409 {"detail":"CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation."}');
        }
      }
      return originalCreate(conversationId, body);
    };
    let toolCalls = 0;
    const result = await runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{
        name: 'memory_search', description: 'search', parameters: {},
        async execute() { toolCalls += 1; return { results: [] }; },
      }],
      requiredClientToolNames: ['memory_search'],
      continuationBusyRetry: { maxWaitMs: 50, intervalMs: 1 },
    });
    expect(result.clientToolFailure).toBe(false);
    expect(toolCalls).toBe(1);
    expect(continuationCalls).toBe(2);
  });

  it('does not retry an unrelated 409 even when continuation busy retry is enabled', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"京都"}', tool_call_id: 'call-other-409' } }], stop_reason: 'requires_approval' },
    ]);
    const originalCreate = client.conversations.messages.create.bind(client.conversations.messages);
    let continuationCalls = 0;
    client.conversations.messages.create = async (conversationId, body) => {
      if ((body.messages as any[])?.[0]?.type === 'tool_return') {
        continuationCalls += 1;
        throw new Error('409 {"detail":"some other conflict"}');
      }
      return originalCreate(conversationId, body);
    };
    await expect(runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{ name: 'memory_search', description: 'search', parameters: {}, async execute() { return { results: [] }; } }],
      continuationBusyRetry: { maxWaitMs: 50, intervalMs: 1 },
    })).rejects.toThrow('some other conflict');
    expect(continuationCalls).toBe(1);
  });

  it('executes every parallel approval_request tool_calls entry exactly once', async () => {
    const parallelCalls = [
      { name: 'memory_search', arguments: '{"query":"A"}', tool_call_id: 'call-a' },
      { name: 'memory_search', arguments: '{"query":"B"}', tool_call_id: 'call-b' },
      { name: 'memory_search', arguments: '{"query":"C"}', tool_call_id: 'call-c' },
    ];
    const client = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: parallelCalls[0],
          tool_calls: parallelCalls,
        }],
        stop_reason: 'requires_approval',
      },
      { messages: [{ message_type: 'tool_call_message', tool_call: { name: LEGACY_COMPLETION_TOOL_NAME, arguments: '{"result":"no_memory_required"}', tool_call_id: 'terminal' } }], stop_reason: 'tool_rule' },
    ]);
    const seen: unknown[] = [];
    const result = await runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{
        name: 'memory_search', description: 'search', parameters: {},
        async execute(_id, args) { seen.push(args); return { results: [] }; },
      }],
    });

    expect(seen).toEqual([{ query: 'A' }, { query: 'B' }, { query: 'C' }]);
    expect(result.terminal).toBe('no_memory_required');
    expect(client.bodies[1].messages).toEqual([{
      type: 'tool_return',
      tool_returns: [
        { type: 'tool', tool_call_id: 'call-a', tool_return: '{"results":[]}', status: 'success' },
        { type: 'tool', tool_call_id: 'call-b', tool_return: '{"results":[]}', status: 'success' },
        { type: 'tool', tool_call_id: 'call-c', tool_return: '{"results":[]}', status: 'success' },
      ],
    }]);
  });

  it('drains client approvals before accepting a terminal emitted in the same model turn', async () => {
    const client = fakeClient([
      {
        messages: [
          { message_type: 'tool_call_message', tool_call: { name: LEGACY_COMPLETION_TOOL_NAME, arguments: '{"result":"completed"}', tool_call_id: 'terminal' } },
          { message_type: 'approval_request_message', tool_call: { name: 'legacy_memory_create', arguments: '{"content":"memory"}', tool_call_id: 'mutation' } },
        ],
        stop_reason: 'requires_approval',
      },
      { messages: [], stop_reason: 'tool_rule' },
    ]);
    const seen: unknown[] = [];
    const result = await runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{
        name: 'legacy_memory_create', description: 'create', parameters: {},
        async execute(_id, args) { seen.push(args); return { outcome: 'accepted' }; },
      }],
    });
    expect(seen).toEqual([{ content: 'memory' }]);
    expect(result.terminal).toBe('completed');
    expect(result.clientToolFailure).toBe(false);
    expect(client.bodies).toHaveLength(2);
    expect(client.bodies[1].messages).toEqual([{
      type: 'tool_return',
      tool_returns: [{ type: 'tool', tool_call_id: 'mutation', tool_return: '{"outcome":"accepted"}', status: 'success' }],
    }]);
  });
});

import { syncClientToolRoundGate } from './sync_client_tool_gate.js';

describe('sync client-tool cross-round dependencies', () => {
  it('defers a same-round deliver_whisper until a prior round memory_search has completed', async () => {
    const client = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: { name: 'deliver_whisper', arguments: '{"text":"premature"}', tool_call_id: 'whisper-1' },
          tool_calls: [
            { name: 'deliver_whisper', arguments: '{"text":"premature"}', tool_call_id: 'whisper-1' },
            { name: 'memory_search', arguments: '{"query":"咖啡"}', tool_call_id: 'search-1' },
          ],
        }],
        stop_reason: 'requires_approval',
      },
      {
        messages: [{ message_type: 'approval_request_message', tool_call: { name: 'deliver_whisper', arguments: '{"text":"grounded"}', tool_call_id: 'whisper-2' } }],
        stop_reason: 'requires_approval',
      },
      { messages: [], stop_reason: 'end_turn' },
    ]);
    const searches: unknown[] = [];
    const whispers: string[] = [];
    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: '咖啡',
      tools: [
        {
          name: 'memory_search', description: 'search', parameters: {},
          async execute(_id, args) { searches.push(args); return { results: [{ summary: 'remembered' }] }; },
        },
        {
          name: 'deliver_whisper', description: 'whisper', parameters: {},
          async execute(_id, args) { whispers.push((args as any).text); return { status: 'ok' }; },
        },
      ],
      requiredClientToolNames: ['memory_search'],
      clientToolRoundGate: syncClientToolRoundGate,
    });

    expect(searches).toEqual([{ query: '咖啡' }]);
    expect(whispers).toEqual(['grounded']);
    expect(result.clientToolFailure).toBe(false);
    expect(client.bodies[1].messages[0].tool_returns[0]).toEqual(expect.objectContaining({
      tool_call_id: 'whisper-1', status: 'success',
    }));
    expect(JSON.parse(client.bodies[1].messages[0].tool_returns[0].tool_return)).toEqual(expect.objectContaining({ status: 'deferred' }));
  });

  it('defers same-round memory_search so the query can use the current foreground entity result', async () => {
    const client = fakeClient([
      {
        messages: [{
          message_type: 'approval_request_message',
          tool_call: { name: 'memory_search', arguments: '{"query":"晴"}', tool_call_id: 'search-1' },
          tool_calls: [
            { name: 'memory_search', arguments: '{"query":"晴"}', tool_call_id: 'search-1' },
            { name: 'entity_search', arguments: '{"query":"晴","purpose":"foreground_grounding"}', tool_call_id: 'entity-1' },
          ],
        }],
        stop_reason: 'requires_approval',
      },
      {
        messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"GPT ChatGPT 晴"}', tool_call_id: 'search-2' } }],
        stop_reason: 'requires_approval',
      },
      { messages: [], stop_reason: 'end_turn' },
    ]);
    const order: string[] = [];
    const result = await runNativeClientToolConversation({
      client,
      agentId: 'agent-test',
      conversationId: 'conv-test',
      message: '晴是谁',
      tools: [
        {
          name: 'memory_search', description: 'search', parameters: {},
          async execute() { order.push('memory_search'); return { results: [] }; },
        },
        {
          name: 'entity_search', description: 'entity', parameters: {},
          async execute() { order.push('entity_search'); return { results: [{ canonical_name: '晴' }] }; },
        },
      ],
      requiredClientToolNames: ['memory_search'],
      clientToolRoundGate: syncClientToolRoundGate,
    });

    expect(order).toEqual(['entity_search', 'memory_search']);
    expect(result.clientToolFailure).toBe(false);
    expect(JSON.parse(client.bodies[1].messages[0].tool_returns[0].tool_return)).toEqual(expect.objectContaining({ status: 'deferred' }));
  });
  it('does not let an older unrelated entity_search unlock a new same-round foreground grounding dependency', async () => {
    const gate = syncClientToolRoundGate;
    const requests = [
      { name: 'memory_search', arguments: '{"query":"晴"}', toolCallId: 'search-now' },
      { name: 'entity_search', arguments: '{"query":"晴","purpose":"foreground_grounding"}', toolCallId: 'entity-now' },
    ];
    expect(gate({
      request: requests[0],
      round: 3,
      completedBeforeRound: new Set(['entity_search']),
      batchRequests: requests,
    })).toContain('deferred');
  });

});
