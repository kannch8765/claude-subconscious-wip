import { describe, expect, it } from 'vitest';
import {
  LEGACY_COMPLETION_TOOL_NAME,
  ensureLegacyCompletionTool,
  extractLegacyCompletion,
  reconcileLegacyCompletionRules,
  runNativeClientToolConversation,
  type NativeLettaClientLike,
} from './native_letta_backfill.js';

function fakeClient(responses: any[] = []): NativeLettaClientLike & { bodies: any[]; updates: any[]; attachments: string[] } {
  const bodies: any[] = [];
  const updates: any[] = [];
  const attachments: string[] = [];
  const state: any = {
    tools: [],
    tool_rules: [{ type: 'continue_loop', tool_name: 'existing_tool' }],
  };
  return {
    bodies,
    updates,
    attachments,
    tools: {
      async upsert() { return { id: 'tool-native-terminal' }; },
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
          return response;
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
    expect(client.bodies[1].messages).toEqual([{ type: 'approval', approvals: [{ type: 'tool', tool_call_id: 'call-1', tool_return: '{"results":[]}', status: 'success' }] }]);
  });

  it('fails closed instead of running local mutations after a terminal call with pending approvals', async () => {
    const client = fakeClient([{
      messages: [
        { message_type: 'tool_call_message', tool_call: { name: LEGACY_COMPLETION_TOOL_NAME, arguments: '{"result":"completed"}', tool_call_id: 'terminal' } },
        { message_type: 'approval_request_message', tool_call: { name: 'legacy_memory_create', arguments: '{}', tool_call_id: 'mutation' } },
      ],
    }]);
    let executed = false;
    await expect(runNativeClientToolConversation({
      client, agentId: 'agent-test', conversationId: 'conv-test', message: 'source',
      tools: [{ name: 'legacy_memory_create', description: 'create', parameters: {}, async execute() { executed = true; return {}; } }],
    })).rejects.toThrow(/pending client tool approvals/);
    expect(executed).toBe(false);
  });
});
