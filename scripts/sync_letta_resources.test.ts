import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCompletedSyncResources, createSyncConversation, createToolStrippedSyncAgent } from './sync_letta_resources.js';

const originalFetch = globalThis.fetch;
const originalAgentId = process.env.LETTA_AGENT_ID;
const originalForegroundProfile = process.env.SUBCON_FOREGROUND_PROFILE;

function fakeBlocks() {
  const labels = ['core_directives', 'guidance', 'pending_items', 'project_context', 'self_improvement', 'session_patterns', 'tool_guidelines', 'user_preferences'];
  return labels.map((label, index) => ({ id: `block-${index}`, label, value: `value-${index}` }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentId === undefined) delete process.env.LETTA_AGENT_ID;
  else process.env.LETTA_AGENT_ID = originalAgentId;
  if (originalForegroundProfile === undefined) delete process.env.SUBCON_FOREGROUND_PROFILE;
  else process.env.SUBCON_FOREGROUND_PROFILE = originalForegroundProfile;
});

describe('tool-stripped sync sibling agent', () => {
  it('copies current canonical block values into new blocks and attaches no server tools', async () => {
    process.env.LETTA_AGENT_ID = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      if (method === 'GET' && url.includes('/agents/agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) {
        return new Response(JSON.stringify({
          id: process.env.LETTA_AGENT_ID,
          blocks: [{ label: 'guidance', value: 'LIVE GUIDANCE', limit: 20000 }],
          model_settings: { provider_type: 'openai', parallel_tool_calls: true, max_output_tokens: 16384, temperature: 1.0 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && /\/v1\/agents\/?$/.test(url)) {
        return new Response(JSON.stringify({
          id: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tools: [],
          blocks: fakeBlocks(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const result = await createToolStrippedSyncAgent('test-key', 'sync_test_turn');
    expect(result).toEqual({
      sourceAgentId: 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      syncAgentId: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      syncBlockIds: fakeBlocks().map((block) => block.id),
    });
    const create = requests.find((request) => request.method === 'POST')!;
    expect(create.body.tool_ids).toEqual([]);
    expect(create.body.tools).toEqual([]);
    expect(create.body.tool_rules).toEqual([]);
    expect(create.body.include_base_tools).toBe(false);
    expect(create.body.include_multi_agent_tools).toBe(false);
    expect(create.body.include_base_tool_rules).toBe(false);
    expect(create.body.model).toBe('openai-proxy/mimo-v2.5');
    expect(create.body.context_window_limit).toBe(400000);
    expect(create.body.model_settings).toEqual(expect.objectContaining({ provider_type: 'openai', parallel_tool_calls: true, max_output_tokens: 16384, temperature: 1.0 }));
    const guidance = create.body.memory_blocks.find((block: any) => block.label === 'guidance');
    expect(guidance.value).toBe('LIVE GUIDANCE');
    expect(create.body.block_ids).toBeUndefined();
  });

  it('projects thin-v1 as the canonical system with zero background memory blocks', async () => {
    process.env.LETTA_AGENT_ID = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    process.env.SUBCON_FOREGROUND_PROFILE = 'thin-v1';
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      if (method === 'GET' && url.includes('/agents/agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) {
        return new Response(JSON.stringify({
          id: process.env.LETTA_AGENT_ID,
          blocks: fakeBlocks(),
          model_settings: { provider_type: 'openai', parallel_tool_calls: true },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && /\/v1\/agents\/?$/.test(url)) {
        return new Response(JSON.stringify({
          id: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tools: [],
          blocks: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const result = await createToolStrippedSyncAgent('test-key', 'sync_thin_turn');
    expect(result).toEqual({
      sourceAgentId: 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      syncAgentId: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      syncBlockIds: [],
    });
    const create = requests.find((request) => request.method === 'POST')!;
    expect(create.body.memory_blocks).toEqual([]);
    expect(create.body.system).toEqual(expect.any(String));
    expect(create.body.system.length).toBeGreaterThan(1000);
    expect(create.body.model).toBe('openai-proxy/mimo-v2.5');
    expect(create.body.context_window_limit).toBe(400000);
    expect(create.body.tools).toEqual([]);
    expect(create.body.tool_ids).toEqual([]);
  });

  it('fails closed on an unknown foreground profile instead of silently changing semantics', async () => {
    process.env.LETTA_AGENT_ID = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    process.env.SUBCON_FOREGROUND_PROFILE = 'mystery';
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if ((init.method ?? 'GET') === 'GET' && url.includes('/agents/agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) {
        return new Response(JSON.stringify({ id: process.env.LETTA_AGENT_ID, blocks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`);
    }) as typeof fetch;
    await expect(createToolStrippedSyncAgent('test-key', 'sync_bad_profile')).rejects.toThrow('unsupported SUBCON_FOREGROUND_PROFILE: mystery');
  });

  it('fails closed and deletes the sibling if Letta unexpectedly attaches a server tool', async () => {
    process.env.LETTA_AGENT_ID = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let deleted = false;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        return new Response(JSON.stringify({ id: process.env.LETTA_AGENT_ID, blocks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST') {
        return new Response(JSON.stringify({
          id: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tools: [{ id: 'tool-x', name: 'memory' }],
          blocks: fakeBlocks(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'DELETE' && url.includes('agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')) {
        deleted = true;
        return new Response('', { status: 200 });
      }
      if (method === 'DELETE' && url.includes('/blocks/')) return new Response('', { status: 200 });
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await expect(createToolStrippedSyncAgent('test-key', 'sync_test_turn')).rejects.toThrow('unexpectedly has 1 server tools');
    expect(deleted).toBe(true);
  });

  it('recovers the exact tool-stripped sibling when the create response is lost after server commit', async () => {
    process.env.LETTA_AGENT_ID = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let createAttempted = false;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (method === 'GET' && url.includes('agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) {
        return new Response(JSON.stringify({ id: process.env.LETTA_AGENT_ID, blocks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && /\/v1\/agents\/?$/.test(new URL(url).pathname)) {
        createAttempted = true;
        throw new TypeError('synthetic lost create response');
      }
      if (method === 'GET' && new URL(url).pathname.endsWith('/v1/agents/')) {
        return new Response(JSON.stringify([{ id: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Subconscious Sync sync_recover' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'GET' && url.includes('agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')) {
        return new Response(JSON.stringify({ id: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Subconscious Sync sync_recover', tools: [], blocks: fakeBlocks() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await expect(createToolStrippedSyncAgent('test-key', 'sync_recover')).resolves.toEqual({
      sourceAgentId: 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      syncAgentId: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      syncBlockIds: fakeBlocks().map((block) => block.id),
    });
    expect(createAttempted).toBe(true);
  });

  it('recovers the exact conversation by its per-turn sibling agent when the create response is lost', async () => {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (method === 'POST' && new URL(url).pathname.endsWith('/v1/conversations/')) {
        throw new TypeError('synthetic lost conversation response');
      }
      if (method === 'GET' && new URL(url).pathname.endsWith('/v1/conversations/')) {
        return new Response(JSON.stringify([{
          id: 'conv-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          agent_id: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await expect(createSyncConversation('test-key', 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
      .resolves.toBe('conv-cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });


  it('deletes completed sync resources in conversation -> agent -> block order', async () => {
    const deletes: string[] = [];
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if ((init.method ?? 'GET') !== 'DELETE') throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`);
      deletes.push(new URL(url).pathname);
      return new Response('', { status: 200 });
    }) as typeof fetch;

    await cleanupCompletedSyncResources(
      'test-key',
      'conv-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ['block-one', 'block-two'],
    );
    expect(deletes).toEqual([
      '/v1/conversations/conv-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '/v1/agents/agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '/v1/blocks/block-one',
      '/v1/blocks/block-two',
    ]);
  });

});
