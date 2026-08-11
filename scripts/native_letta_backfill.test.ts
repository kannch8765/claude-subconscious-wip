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

function terminalMessages(result: 'completed' | 'no_memory_required', toolCallId = 'terminal'): any[] {
  return [
    { message_type: 'tool_call_message', tool_call: { name: LEGACY_COMPLETION_TOOL_NAME, arguments: JSON.stringify({ result }), tool_call_id: toolCallId } },
    { message_type: 'tool_return_message', tool_call_id: toolCallId, status: 'success', tool_return: result },
  ];
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
    expect(client.upserts[0]).toEqual(expect.objectContaining({
      enable_parallel_execution: false,
      args_json_schema: expect.objectContaining({ title: 'LegacySourceCompleteArgs' }),
      source_code: expect.stringContaining('getattr(result, \"value\", result)'),
    }));
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

  it('executes local client tools through native approval returns then accepts a server terminal call', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{"query":"京都"}', tool_call_id: 'call-1' } }], stop_reason: 'requires_approval' },
      { messages: terminalMessages('no_memory_required', 'call-2'), stop_reason: 'tool_rule' },
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

  it('executes every parallel approval_request tool_calls entry exactly once', async () => {
    const parallelCalls = [
      { name: 'memory_search', arguments: '{\"query\":\"A\"}', tool_call_id: 'call-a' },
      { name: 'memory_search', arguments: '{\"query\":\"B\"}', tool_call_id: 'call-b' },
      { name: 'memory_search', arguments: '{\"query\":\"C\"}', tool_call_id: 'call-c' },
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
      { messages: terminalMessages('no_memory_required'), stop_reason: 'tool_rule' },
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
        { type: 'tool', tool_call_id: 'call-a', tool_return: '{\"results\":[]}', status: 'success' },
        { type: 'tool', tool_call_id: 'call-b', tool_return: '{\"results\":[]}', status: 'success' },
        { type: 'tool', tool_call_id: 'call-c', tool_return: '{\"results\":[]}', status: 'success' },
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
      { messages: [{ message_type: 'tool_return_message', tool_call_id: 'terminal', status: 'success', tool_return: 'completed' }], stop_reason: 'tool_rule' },
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
  it('requires a successful server tool return before accepting legacy_source_complete', async () => {
    const messages = [
      { message_type: 'tool_call_message', tool_call: { name: LEGACY_COMPLETION_TOOL_NAME, arguments: '{"result":"completed"}', tool_call_id: 'terminal-failed' } },
      { message_type: 'tool_return_message', tool_call_id: 'terminal-failed', status: 'error', tool_return: 'server tool failed' },
    ];
    expect(extractLegacyCompletion(messages)).toBeUndefined();
  });

  it('clears a malformed-arguments client-tool failure only after a later round succeeds for the same tool', async () => {
    const client = fakeClient([
      {
        messages: [{ message_type: 'approval_request_message', tool_calls: [
          { name: 'legacy_memory_create', arguments: '{bad-json', tool_call_id: 'bad' },
          { name: 'legacy_memory_create', arguments: '{"item":"other"}', tool_call_id: 'same-round-success' },
        ] }],
        stop_reason: 'requires_approval',
      },
      {
        messages: [{ message_type: 'approval_request_message', tool_call: { name: 'legacy_memory_create', arguments: '{"item":"retry"}', tool_call_id: 'retry' } }],
        stop_reason: 'requires_approval',
      },
      { messages: terminalMessages('completed'), stop_reason: 'tool_rule' },
    ]);
    const seen: unknown[] = [];
    const result = await runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{
        name: 'legacy_memory_create', description: 'create', parameters: {},
        async execute(_id, args) { seen.push(args); return { outcome: 'accepted' }; },
      }],
    });
    expect(seen).toEqual([{ item: 'other' }, { item: 'retry' }]);
    expect(result.clientToolFailure).toBe(false);
    expect(result.terminal).toBe('completed');
    expect(client.bodies[1].messages[0].tool_returns).toEqual([
      expect.objectContaining({ tool_call_id: 'bad', status: 'error' }),
      expect.objectContaining({ tool_call_id: 'same-round-success', status: 'success' }),
    ]);
  });

  it('keeps a malformed-arguments failure unresolved when the model never retries that client tool', async () => {
    const client = fakeClient([
      { messages: [{ message_type: 'approval_request_message', tool_call: { name: 'memory_search', arguments: '{bad-json', tool_call_id: 'bad' } }], stop_reason: 'requires_approval' },
      { messages: terminalMessages('no_memory_required'), stop_reason: 'tool_rule' },
    ]);
    const result = await runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{ name: 'memory_search', description: 'search', parameters: {}, async execute() { return { results: [] }; } }],
    });
    expect(result.clientToolFailure).toBe(true);
    expect(result.terminal).toBe('no_memory_required');
  });

});
