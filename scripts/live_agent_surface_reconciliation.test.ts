import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCanonicalManagedAgentSurface, reconcileManagedLiveAgentSurface } from './agent_config.js';

const AGENT = 'agent-11111111-1111-4111-8111-111111111111';
const LIVE_AF = path.join(process.cwd(), 'Subconscious.af');
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('managed live agent surface reconciliation', () => {
  it('restores missing live blocks/tools in-place and detaches observer-only surface', async () => {
    const canonical = getCanonicalManagedAgentSurface(LIVE_AF);
    const guidance = canonical.blocks.find((block) => block.label === 'guidance')!;
    const globalTools = canonical.toolNames.map((name, i) => ({ id: `tool-global-${i}`, name }));
    const calls: Array<{ method: string; pathname: string; body?: any }> = [];
    let created = 0;

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, pathname: url.pathname, body });

      if (method === 'GET' && url.pathname.endsWith(`/agents/${AGENT}/core-memory/blocks`)) {
        return response([
          { id: 'block-existing-guidance', label: 'guidance', value: 'keep my learned guidance' },
          { id: 'block-old-projection', label: 'relationship_context', value: 'observer projection' },
          { id: 'block-custom', label: 'operator_notes', value: 'preserve me' },
        ]);
      }
      if (method === 'POST' && url.pathname.endsWith('/blocks/')) {
        created += 1;
        return response({ id: `block-created-${created}`, ...body });
      }
      if (method === 'GET' && url.pathname.endsWith(`/agents/${AGENT}/tools`)) {
        return response([
          { id: globalTools.find((tool) => tool.name === 'memory')!.id, name: 'memory' },
          { id: 'tool-obsolete', name: 'legacy_source_complete' },
          { id: 'tool-custom', name: 'operator_custom_tool' },
        ]);
      }
      if (method === 'GET' && url.pathname.endsWith('/tools/')) return response(globalTools);
      if (method === 'PATCH') return response({ ok: true });
      throw new Error(`unexpected fetch ${method} ${url.pathname}`);
    }));

    await expect(reconcileManagedLiveAgentSurface('key', AGENT, () => {}, LIVE_AF)).resolves.toBeUndefined();

    const creates = calls.filter((call) => call.method === 'POST' && call.pathname.endsWith('/blocks/'));
    expect(creates).toHaveLength(canonical.blocks.length - 1);
    expect(creates.some((call) => call.body?.label === guidance.label)).toBe(false);
    expect(calls.some((call) => call.pathname.endsWith('/core-memory/blocks/detach/block-old-projection'))).toBe(true);
    expect(calls.some((call) => call.pathname.endsWith('/tools/detach/tool-obsolete'))).toBe(true);
    expect(calls.some((call) => call.pathname.endsWith('/core-memory/blocks/detach/block-custom'))).toBe(false);
    expect(calls.some((call) => call.pathname.endsWith('/tools/detach/tool-custom'))).toBe(false);
    expect(calls.filter((call) => call.pathname.includes('/core-memory/blocks/attach/'))).toHaveLength(canonical.blocks.length - 1);
    expect(calls.filter((call) => call.pathname.includes('/tools/attach/'))).toHaveLength(canonical.toolNames.length - 1);
  });

  it('is idempotent when the adopted live agent already has the canonical surface', async () => {
    const canonical = getCanonicalManagedAgentSurface(LIVE_AF);
    const blocks = canonical.blocks.map((block, i) => ({ id: `block-${i}`, label: block.label, value: `learned-${block.label}` }));
    const tools = canonical.toolNames.map((name, i) => ({ id: `tool-${i}`, name }));
    const mutations: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method !== 'GET') mutations.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname.endsWith(`/agents/${AGENT}/core-memory/blocks`)) return response(blocks);
      if (method === 'GET' && url.pathname.endsWith(`/agents/${AGENT}/tools`)) return response(tools);
      if (method === 'GET' && url.pathname.endsWith('/tools/')) return response(tools);
      if (method === 'PATCH') return response({ ok: true });
      throw new Error(`unexpected fetch ${method} ${url.pathname}`);
    }));

    await reconcileManagedLiveAgentSurface('key', AGENT, () => {}, LIVE_AF);
    expect(mutations).toEqual([]);
  });

  it('fails closed rather than silently omitting a required live tool', async () => {
    const canonical = getCanonicalManagedAgentSurface(LIVE_AF);
    const blocks = canonical.blocks.map((block, i) => ({ id: `block-${i}`, label: block.label }));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/agents/${AGENT}/core-memory/blocks`)) return response(blocks);
      if (url.pathname.endsWith(`/agents/${AGENT}/tools`)) return response([]);
      if (url.pathname.endsWith('/tools/')) return response([]);
      throw new Error(`unexpected fetch GET ${url.pathname}`);
    }));
    await expect(reconcileManagedLiveAgentSurface('key', AGENT, () => {}, LIVE_AF)).rejects.toThrow('Required live Subconscious tool is unavailable');
  });
});
