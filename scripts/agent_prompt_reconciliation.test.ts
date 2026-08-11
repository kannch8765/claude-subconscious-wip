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

async function loadAgentConfig(home: string) {
  process.env.HOME = home;
  process.env.LETTA_BASE_URL = 'http://letta.test:8283';
  vi.resetModules();
  return import('./agent_config.js');
}

function installManagedFetch(initialSystem: string, patchStatus = 200) {
  let liveSystem = initialSystem;
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
        model: 'opencode-deepseek/deepseek-v4-flash',
        embedding: 'local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768',
        context_window_limit: 400000,
        model_settings: { parallel_tool_calls: true },
        llm_config: { handle: 'opencode-deepseek/deepseek-v4-flash', model: 'deepseek-v4-flash', provider_name: 'opencode-deepseek', context_window: 400000, parallel_tool_calls: true },
      });
    }

    if (url.pathname === `/v1/agents/${MANAGED_AGENT_ID}` && method === 'PATCH') {
      if (patchStatus !== 200) return new Response('patch failed', { status: patchStatus });
      if (typeof body?.system === 'string') liveSystem = body.system;
      return jsonResponse({ id: MANAGED_AGENT_ID });
    }

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
      model_settings: { parallel_tool_calls: boolean };
      llm_config: Record<string, unknown>;
    } = {
      id: MANAGED_AGENT_ID,
      name: 'Subconscious_093B_110855',
      tags: REQUIRED_TAGS,
      system: 'obsolete prompt',
      model: 'z.ai/glm-5',
      embedding: 'openai/text-embedding-3-small',
      context_window_limit: 90000,
      model_settings: { parallel_tool_calls: false },
      llm_config: {
        handle: 'z.ai/glm-5',
        model: 'glm-5',
        provider_name: 'z.ai',
        context_window: 90000,
        parallel_tool_calls: false,
      },
    };

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
          live.model_settings = { ...live.model_settings, ...(body.model_settings as { parallel_tool_calls?: boolean }) };
        }
        return jsonResponse({ id: MANAGED_AGENT_ID });
      }
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

  it('reconciles only system for an env-selected origin-tagged managed agent', async () => {
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
  it('loads the prompt directly from Subconscious.af as the single source of truth', async () => {
    const home = makeHome();
    const mod = await loadAgentConfig(home);
    const af = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'Subconscious.af'), 'utf-8'));

    expect(mod.getCanonicalManagedSystemPrompt()).toBe(af.agents[0].system);
    expect(af.agents[0].messages[0].content[0].text.startsWith(`${af.agents[0].system}\n\n<relationship_memory_projections>`)).toBe(true);
  });

  it('matches the published observer tool boundary and separates role provenance from 琥珀 prose naming', async () => {
    const home = makeHome();
    const mod = await loadAgentConfig(home);
    const prompt = mod.getCanonicalManagedSystemPrompt();

    expect(prompt).not.toContain('Read, Grep, and Glob remain available');
    expect(prompt).toContain('no Claude builtin filesystem, shell, or task tools');
    expect(prompt).toContain('role=assistant');
    expect(prompt).toContain('琥珀');
    expect(prompt).toContain('literal Claude and Claude Code aliases');
    expect(prompt).toContain('source-faithful literal fields unchanged');
    expect(prompt).toContain('trusted current-batch evidence IDs');
    expect(prompt).not.toContain('real current-batch message IDs');
  });
});
