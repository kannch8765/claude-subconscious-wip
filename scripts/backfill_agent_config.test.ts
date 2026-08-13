import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCanonicalManagedAgentConfig, getCanonicalManagedSystemPrompt } from './agent_config.js';
import { BACKFILL_PURPOSE_TAG, configureVerifiedLegacyFillRuntime, getBackfillAgentId, LEGACY_FILL_VERIFIED_RUNTIME } from './backfill_agent_config.js';

const LIVE = 'agent-11111111-1111-4111-8111-111111111111';
const BACKFILL = 'agent-22222222-2222-4222-8222-222222222222';
const REQUIRED = ['git-memory-enabled', 'origin:claude-subconcious', BACKFILL_PURPOSE_TAG];
const BACKFILL_AF = path.join(process.cwd(), 'SubconsciousBackfill.af');
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_BACKFILL_AGENT_ID;
  delete process.env.LETTA_BACKFILL_CONFIG_FILE;
});

describe('dedicated historical backfill agent resolver', () => {
  it('uses the dedicated override and never falls through to live LETTA_AGENT_ID', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = BACKFILL;
    const canonical = getCanonicalManagedSystemPrompt(BACKFILL_AF); const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url); expect(url).toContain(`/agents/${BACKFILL}`);
      const runtime = getCanonicalManagedAgentConfig(BACKFILL_AF); return jsonResponse({ id: BACKFILL, name: 'backfill', tags: REQUIRED, system: canonical, model: runtime.model, embedding: runtime.embedding, context_window_limit: runtime.contextWindowLimit, model_settings: { provider_type: 'deepseek', parallel_tool_calls: true } });
    }));
    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    expect(calls.length).toBe(3);
    expect(calls.every((url) => !url.endsWith('/agents/'))).toBe(true);
  });


  it('can resolve a fill agent without reconciling the drifting canonical prompt', async () => {
    process.env.LETTA_AGENT_ID = LIVE;
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); expect(url).toContain(`/agents/${BACKFILL}`);
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; patches.push(body);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ id: BACKFILL, name: 'backfill', tags: REQUIRED, system: 'canary-owned prompt' });
    }));
    await expect(getBackfillAgentId('test-key', () => {}, { agentId: BACKFILL, reconcileCanonicalPrompt: false })).resolves.toBe(BACKFILL);
    expect(patches.some((body) => 'system' in body)).toBe(false);
  });

  it('applies and verifies the bounded verified DeepSeek fill runtime profile', async () => {
    const profile = LEGACY_FILL_VERIFIED_RUNTIME;
    let patched = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); expect(url).toContain(`/agents/${BACKFILL}`);
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body).toEqual({
          model: profile.model,
          embedding: profile.embedding,
          context_window_limit: profile.contextWindow,
          model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
        });
        patched = true;
        return jsonResponse({ ok: true });
      }
      expect(patched).toBe(true);
      return jsonResponse({
        id: BACKFILL,
        model: profile.model,
        embedding: profile.embedding,
        llm_config: { handle: profile.model, context_window: profile.contextWindow, parallel_tool_calls: true },
        model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
      });
    }));
    const logs: string[] = [];
    await expect(configureVerifiedLegacyFillRuntime('test-key', BACKFILL, (message) => logs.push(message))).resolves.toBeUndefined();
    expect(logs.join(' ')).toContain('context=400000');
    expect(logs.join(' ')).toContain('parallel_tool_calls=true');
  });

  it('tolerates a briefly stale GET after applying the verified runtime profile', async () => {
    const profile = LEGACY_FILL_VERIFIED_RUNTIME;
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return jsonResponse({ ok: true });
      reads += 1;
      if (reads === 1) {
        return jsonResponse({
          id: BACKFILL,
          model: profile.model,
          embedding: profile.embedding,
          llm_config: { handle: profile.model, context_window: profile.contextWindow, parallel_tool_calls: false },
          model_settings: { provider_type: 'deepseek', parallel_tool_calls: false },
        });
      }
      return jsonResponse({
        id: BACKFILL,
        model: profile.model,
        embedding: profile.embedding,
        llm_config: { handle: profile.model, context_window: profile.contextWindow, parallel_tool_calls: true },
        model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
      });
    }));
    await expect(configureVerifiedLegacyFillRuntime('test-key', BACKFILL, () => {})).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('fails closed before any mutation if dedicated and live identities collapse', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = LIVE;
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(getBackfillAgentId('test-key', () => {})).rejects.toThrow('must differ from live Subconscious agent');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconciles from canonical SubconsciousBackfill.af and adds durable purpose identity', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = BACKFILL;
    const canonical = getCanonicalManagedSystemPrompt(BACKFILL_AF);
    let tags: string[] = ['git-memory-enabled', 'origin:claude-subconcious']; let system = 'stale prompt'; let model = 'zai/glm-5'; let embedding = 'openai/text-embedding-3-small'; let contextWindow = 90000; let parallel = false;
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); expect(url).toContain(`/agents/${BACKFILL}`);
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; patches.push(body);
        if (Array.isArray(body.tags)) tags = body.tags as string[];
        if (typeof body.system === 'string') system = body.system;
        if (typeof body.model === 'string') model = body.model;
        if (typeof body.embedding === 'string') embedding = body.embedding;
        if (typeof body.context_window_limit === 'number') contextWindow = body.context_window_limit;
        if (body.model_settings && typeof body.model_settings === 'object') parallel = (body.model_settings as { parallel_tool_calls?: boolean }).parallel_tool_calls ?? parallel;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ id: BACKFILL, name: 'backfill', tags, system, model, embedding, context_window_limit: contextWindow, model_settings: { provider_type: model.includes('deepseek') ? 'deepseek' : 'zai', parallel_tool_calls: parallel } });
    }));
    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    expect(tags).toContain(BACKFILL_PURPOSE_TAG); expect(system).toBe(canonical);
    expect(patches.some((body) => body.system === canonical)).toBe(true);
    const runtimePatch = patches.find((body) => body.model === getCanonicalManagedAgentConfig(BACKFILL_AF).model);
    expect(runtimePatch).toEqual(expect.objectContaining({ embedding: getCanonicalManagedAgentConfig(BACKFILL_AF).embedding, context_window_limit: getCanonicalManagedAgentConfig(BACKFILL_AF).contextWindowLimit, model_settings: { provider_type: 'deepseek', parallel_tool_calls: true } }));
  });

  it('provisions once, saves separate config, and reuses without global agent scan', async () => {
    process.env.LETTA_AGENT_ID = LIVE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-agent-'));
    const configFile = path.join(dir, 'backfill.json'); process.env.LETTA_BACKFILL_CONFIG_FILE = configFile;
    const canonical = getCanonicalManagedSystemPrompt(BACKFILL_AF); const runtime = getCanonicalManagedAgentConfig(BACKFILL_AF); let tags: string[] = []; let agentSystem = canonical; let model = runtime.model; let embedding = runtime.embedding; let contextWindow = runtime.contextWindowLimit; let parallel = true; let imports = 0;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'; urls.push(`${method} ${url}`);
      if (url.endsWith('/agents/import')) { imports += 1; return jsonResponse({ agent_ids: [BACKFILL] }); }
      expect(url).toContain(`/agents/${BACKFILL}`);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (Array.isArray(body.tags)) tags = body.tags as string[];
        if (typeof body.system === 'string') agentSystem = body.system;
        if (typeof body.model === 'string') model = body.model;
        if (typeof body.embedding === 'string') embedding = body.embedding;
        if (typeof body.context_window_limit === 'number') contextWindow = body.context_window_limit;
        if (body.model_settings && typeof body.model_settings === 'object') parallel = (body.model_settings as { parallel_tool_calls?: boolean }).parallel_tool_calls ?? parallel;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ id: BACKFILL, name: 'backfill', tags, system: agentSystem, model, embedding, context_window_limit: contextWindow, model_settings: { provider_type: model.includes('deepseek') ? 'deepseek' : 'zai', parallel_tool_calls: parallel } });
    }));
    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    expect(imports).toBe(1);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).agentId).toBe(BACKFILL);
    expect(tags).toContain(BACKFILL_PURPOSE_TAG);
    expect(urls.some((entry) => /GET .*\/agents\/?$/.test(entry))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
