import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MANAGED_AGENT_ID = 'agent-8c9329b5-63e0-4a45-98e4-1770a61521df';
const EXTERNAL_AGENT_ID = 'agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const REQUIRED_TAGS = ['git-memory-enabled', 'origin:claude-subconcious'];

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'subcon-agent-config-'));
}

function writeSavedAgent(home: string, agentId = MANAGED_AGENT_ID): void {
  const dir = path.join(home, '.letta', 'claude-subconscious');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agentId }), 'utf-8');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function canonicalSurfaceFixtures() {
  const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf-8'));
  const agent = af.agents[0];
  const blocks = agent.block_ids.map((id: string, i: number) => {
    const block = af.blocks.find((item: any) => item.id === id);
    return { id: `block-fixture-${i}`, label: block.label, value: block.value };
  });
  const tools = agent.tool_ids.map((id: string, i: number) => {
    const tool = af.tools.find((item: any) => item.id === id);
    return { id: `tool-fixture-${i}`, name: tool.name };
  });
  return { blocks, tools };
}

async function loadAgentConfig(home: string) {
  process.env.HOME = home;
  process.env.LETTA_BASE_URL = 'http://letta.test:8283';
  vi.resetModules();
  return import('./agent_config.js');
}

function installManagedFetch(initialSystem: string, patchStatus = 200) {
  let liveSystem = initialSystem;
  const surface = canonicalSurfaceFixtures();
  const requests: Array<{ method: string; pathname: string; body?: Record<string, unknown> }> = [];

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ method, pathname: url.pathname, body });

    if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}` && method === 'GET') {
      return jsonResponse({
        id: MANAGED_AGENT_ID,
        name: 'Subconscious_093B_110855',
        tags: REQUIRED_TAGS,
        system: liveSystem,
        model: 'openai-proxy/mimo-v2.5',
        embedding: 'local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768',
        context_window_limit: 400000,
        model_settings: { provider_type: 'openai', parallel_tool_calls: true },
        llm_config: { handle: 'openai-proxy/mimo-v2.5', model: 'mimo-v2.5', provider_name: 'opencode-go-openai', context_window: 400000, parallel_tool_calls: true },
      });
    }

    if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}` && method === 'PATCH') {
      if (patchStatus !== 200) return new Response('patch failed', { status: patchStatus });
      if (typeof body?.system === 'string') liveSystem = body.system;
      return jsonResponse({ id: MANAGED_AGENT_ID });
    }

    if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}/core-memory/blocks` && method === 'GET') return jsonResponse(surface.blocks);
    if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}/tools` && method === 'GET') return jsonResponse(surface.tools);
    if (url.pathname === '/v1/tools/' && method === 'GET') return jsonResponse(surface.tools);

    if (url.pathname === '/v1/models/' && method === 'GET') {
      return jsonResponse([
        { model: 'gpt-5.2', name: 'gpt-5.2', provider_type: 'openai', handle: 'openai/gpt-5.2' },
      ]);
    }

    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock, getLiveSystem: () => liveSystem };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_MODEL;
  delete process.env.LETTA_CONTEXT_WINDOW;
  delete process.env.LETTA_BASE_URL;
});

function expectAttachedBlockSnapshotsMatch(af: any): void {
  const agent = af.agents[0];
  const compiled = agent.messages[0].content[0].text as string;
  expect(compiled.startsWith(`${agent.system}\n\n<memory_blocks>`)).toBe(true);
  const byId = new Map(af.blocks.map((block: any) => [block.id, block]));
  for (const blockId of agent.block_ids as string[]) {
    const block: any = byId.get(blockId);
    expect(block, `missing attached block ${blockId}`).toBeTruthy();
    const open = `<${block.label}>`;
    const close = `</${block.label}>`;
    const start = compiled.indexOf(open);
    const end = compiled.indexOf(close, start);
    expect(start, `compiled snapshot missing ${block.label}`).toBeGreaterThanOrEqual(0);
    expect(end, `compiled snapshot missing close tag for ${block.label}`).toBeGreaterThan(start);
    const segment = compiled.slice(start, end + close.length);
    const description = segment.match(/<description>\n([\s\S]*?)\n<\/description>/)?.[1];
    const charsCurrent = Number(segment.match(/- chars_current=(\d+)/)?.[1]);
    const value = segment.match(/<value>\n([\s\S]*?)\n<\/value>/)?.[1];
    expect(description, `${block.label} compiled description drift`).toBe(block.description || '');
    expect(charsCurrent, `${block.label} compiled chars_current drift`).toBe(block.value.length);
    expect(value, `${block.label} compiled value drift`).toBe(block.value);
  }
}

describe('managed adopted-agent system prompt reconciliation', () => {
  it('patches a stale saved managed agent exactly once with the canonical .af system', async () => {
    const home = makeHome();
    writeSavedAgent(home);
    const mod = await loadAgentConfig(home);
    const canonical = mod.getCanonicalManagedSystemPrompt();
    const { requests, getLiveSystem } = installManagedFetch('obsolete four-kind prompt');

    await expect(mod.getAgentId('test-key', () => undefined)).resolves.toBe(MANAGED_AGENT_ID);

    const systemPatches = requests.filter((request) => request.method === 'PATCH' && request.body?.system !== undefined);
    expect(systemPatches).toHaveLength(1);
    expect(systemPatches[0].body).toEqual({ system: canonical });
    expect(getLiveSystem()).toBe(canonical);
    expect(requests.some((request) => request.pathname === '/v1/agents/import')).toBe(false);
  });

  it('does not let availability fallback undo canonical managed runtime reconciliation', async () => {
    const home = makeHome();
    writeSavedAgent(home);
    const mod = await loadAgentConfig(home);
    const canonical = mod.getCanonicalManagedAgentConfig();
    const requests: Array<{ method: string; pathname: string; body?: Record<string, unknown> }> = [];
    const live: {
      id: string;
      name: string;
      tags: string[];
      system: string;
      model: string;
      embedding: string;
      context_window_limit: number;
      model_settings: { provider_type: string; parallel_tool_calls: boolean };
      llm_config: Record<string, unknown>;
    } = {
      id: MANAGED_AGENT_ID,
      name: 'Subconscious_093B_110855',
      tags: REQUIRED_TAGS,
      system: 'obsolete prompt',
      model: 'z.ai/glm-5',
      embedding: 'openai/text-embedding-3-small',
      context_window_limit: 90000,
      model_settings: { provider_type: 'zai', parallel_tool_calls: false },
      llm_config: {
        handle: 'z.ai/glm-5',
        model: 'glm-5',
        provider_name: 'z.ai',
        context_window: 90000,
        parallel_tool_calls: false,
      },
    };

    const surface = canonicalSurfaceFixtures();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ method, pathname: url.pathname, body });

      if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}` && method === 'GET') {
        return jsonResponse(live);
      }
      if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}` && method === 'PATCH') {
        if (body?.system !== undefined) live.system = body.system as string;
        if (body?.model !== undefined) live.model = body.model as string;
        if (body?.embedding !== undefined) live.embedding = body.embedding as string;
        if (body?.context_window_limit !== undefined) live.context_window_limit = body.context_window_limit as number;
        if (body?.model_settings !== undefined) {
          live.model_settings = { ...live.model_settings, ...(body.model_settings as { provider_type?: string; parallel_tool_calls?: boolean }) };
          if ((body.model_settings as { provider_type?: string }).provider_type !== undefined) {
            live.llm_config.model_endpoint_type = (body.model_settings as { provider_type?: string }).provider_type;
          }
          if ((body.model_settings as { parallel_tool_calls?: boolean }).parallel_tool_calls !== undefined) {
            live.llm_config.parallel_tool_calls = (body.model_settings as { parallel_tool_calls?: boolean }).parallel_tool_calls;
          }
        }
        return jsonResponse({ id: MANAGED_AGENT_ID });
      }
      if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}/core-memory/blocks` && method === 'GET') return jsonResponse(surface.blocks);
      if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}/tools` && method === 'GET') return jsonResponse(surface.tools);
      if (url.pathname === '/v1/tools/' && method === 'GET') return jsonResponse(surface.tools);
      if (url.pathname === '/v1/models/' && method === 'GET') {
        // The canonical DeepSeek handle is deliberately absent. Before R1 this
        // caused ensureModelAvailable() to PATCH the just-reconciled agent back
        // to the first available model in the same getAgentId() call.
        return jsonResponse([
          { model: 'gpt-5.2', name: 'gpt-5.2', provider_type: 'openai', handle: 'openai/gpt-5.2' },
        ]);
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(mod.getAgentId('test-key', () => undefined)).resolves.toBe(MANAGED_AGENT_ID);

    expect(live.system).toBe(canonical.system);
    expect(live.model).toBe(canonical.model);
    expect(live.embedding).toBe(canonical.embedding);
    expect(live.context_window_limit).toBe(canonical.contextWindowLimit);
    expect(live.model_settings.parallel_tool_calls).toBe(canonical.parallelToolCalls);
    expect(live.llm_config.parallel_tool_calls).toBe(canonical.parallelToolCalls);

    const modelPatches = requests.filter((request) => request.method === 'PATCH' && request.body?.model !== undefined);
    expect(modelPatches).toHaveLength(1);
    expect(modelPatches[0].body?.model).toBe(canonical.model);
    expect(modelPatches.some((request) => request.body?.model === 'openai/gpt-5.2')).toBe(false);
    expect(requests.filter((request) => request.pathname === '/v1/models/')).toHaveLength(1);
  });

  it('does not patch system when the saved managed agent is already canonical', async () => {
    const home = makeHome();
    writeSavedAgent(home);
    const mod = await loadAgentConfig(home);
    const canonical = mod.getCanonicalManagedSystemPrompt();
    const { requests } = installManagedFetch(canonical);

    await expect(mod.getAgentId('test-key', () => undefined)).resolves.toBe(MANAGED_AGENT_ID);

    expect(requests.filter((request) => request.method === 'PATCH' && request.body?.system !== undefined)).toHaveLength(0);
  });

  it('reconciles runtime without replacing an env-selected origin-tagged managed agent', async () => {
    const home = makeHome();
    process.env.LETTA_AGENT_ID = MANAGED_AGENT_ID;
    const mod = await loadAgentConfig(home);
    const canonical = mod.getCanonicalManagedSystemPrompt();
    const { requests } = installManagedFetch('obsolete env-managed prompt');

    await expect(mod.getAgentId('test-key', () => undefined)).resolves.toBe(MANAGED_AGENT_ID);

    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ system: canonical });
    expect(requests.some((request) => request.pathname === '/v1/models/')).toBe(false);
  });

  it('treats an env-selected ordinary untagged agent as external and performs zero PATCHes', async () => {
    const home = makeHome();
    process.env.LETTA_AGENT_ID = EXTERNAL_AGENT_ID;
    const mod = await loadAgentConfig(home);
    const requests: Array<{ method: string; pathname: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      requests.push({ method, pathname: url.pathname });
      if (url.pathname === `/v1/agents/${EXTERNAL_AGENT_ID}` && method === 'GET') {
        return jsonResponse({ id: EXTERNAL_AGENT_ID, name: 'Ordinary Agent', tags: [], system: 'external prompt' });
      }
      throw new Error(`ordinary external agent must not receive managed request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(mod.getAgentId('test-key', () => undefined)).resolves.toBe(EXTERNAL_AGENT_ID);
    expect(requests).toEqual([{ method: 'GET', pathname: `/v1/agents/${EXTERNAL_AGENT_ID}` }]);
  });

  it('fails closed on managed prompt PATCH failure without importing a replacement agent', async () => {
    const home = makeHome();
    writeSavedAgent(home);
    const mod = await loadAgentConfig(home);
    const { requests } = installManagedFetch('obsolete prompt', 500);

    await expect(mod.getAgentId('test-key', () => undefined)).rejects.toThrow('Failed to reconcile managed Subconscious runtime configuration');
    expect(requests.some((request) => request.pathname === '/v1/agents/import')).toBe(false);
  });
});

describe('canonical Subconscious prompt contract', () => {
  it('loads the live prompt directly from Subconscious.af as the default source of truth', async () => {
    const home = makeHome();
    const mod = await loadAgentConfig(home);
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf-8'));

    expect(mod.getCanonicalManagedSystemPrompt()).toBe(af.agents[0].system);
    expectAttachedBlockSnapshotsMatch(af);
  });

  it('restores the live guidance/context role instead of the historical observer contract', async () => {
    const home = makeHome();
    const mod = await loadAgentConfig(home);
    const live = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf-8'));
    const prompt = mod.getCanonicalManagedSystemPrompt();
    const labels = live.agents[0].block_ids.map((id: string) => live.blocks.find((block: any) => block.id === id)?.label);
    const toolNames = live.agents[0].tool_ids.map((id: string) => live.tools.find((tool: any) => tool.id === id)?.name);

    expect(prompt).toContain('persistent agent that whispers to Claude Code');
    expect(prompt).toContain('Write to guidance when you have something useful to whisper back');
    expect(prompt).toContain('keep this secondary to your live Subconscious role');
    expect(prompt).not.toContain('reconfigured as a relationship-memory observer');
    expect(labels).toEqual(expect.arrayContaining(['guidance', 'user_preferences', 'project_context', 'session_patterns', 'pending_items']));
    expect(toolNames).toEqual(expect.arrayContaining(['memory', 'memory_insert', 'memory_replace', 'memory_rethink', 'conversation_search']));
  });

  it('keeps the strict observer prompt in the dedicated backfill AgentFile', async () => {
    const home = makeHome();
    const mod = await loadAgentConfig(home);
    const file = path.join(process.cwd(), 'SubconsciousBackfill.af');
    const af = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const prompt = mod.getCanonicalManagedSystemPrompt(file);

    expect(prompt).toBe(af.agents[0].system);
    expect(prompt).toContain('reconfigured as a relationship-memory observer');
    expect(prompt).toContain('no Claude builtin filesystem, shell, or task tools');
    expect(prompt).toContain('role=assistant');
    expect(prompt).toContain('琥珀');
    expect(prompt).toContain('trusted current-batch evidence IDs');
    expect(prompt).toContain("speak from Kohaku's own subconscious perspective");
  });
});
