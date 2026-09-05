import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCanonicalManagedAgentConfig, getCanonicalManagedSystemPrompt } from './agent_config.js';
import { BACKFILL_PURPOSE_TAG, configureVerifiedLegacyFillRuntime, configureVerifiedOmenBackfillRuntime, getBackfillAgentId, LEGACY_FILL_VERIFIED_RUNTIME, OMEN_BACKFILL_VERIFIED_RUNTIME } from './backfill_agent_config.js';

const LIVE = 'agent-11111111-1111-4111-8111-111111111111';
const BACKFILL = 'agent-22222222-2222-4222-8222-222222222222';
const REQUIRED = ['git-memory-enabled', 'origin:claude-subconcious', BACKFILL_PURPOSE_TAG];
const BACKFILL_AF = path.join(process.cwd(), 'SubconsciousBackfill.af');
const BACKFILL_SYSTEM = path.join(process.cwd(), 'config', 'backfill-system.md');
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LETTA_AGENT_ID;
  delete process.env.LETTA_BACKFILL_AGENT_ID;
  delete process.env.LETTA_BACKFILL_CONFIG_FILE;
  delete process.env.LETTA_MODEL;
  delete process.env.LETTA_CONTEXT_WINDOW;
});

describe('dedicated historical backfill agent resolver', () => {
  it('keeps affective-field guidance aligned with the v1 kind-specific payload schema', () => {
    const raw = fs.readFileSync(BACKFILL_SYSTEM, 'utf8');
    expect(raw).not.toContain('Optional affective fields such as emotional_tone or why_memorable may be used');
    expect(raw).toContain('emotional_tone and why_memorable are optional only for personal_experience');
    expect(raw).toContain('relationship_event accepts only event, meaning, prior_context, and resulting_change');
    expect(raw).toContain('Never add undeclared payload fields');
  });

  it('uses the dedicated override and never falls through to live LETTA_AGENT_ID', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = BACKFILL;
    const canonical = getCanonicalManagedSystemPrompt(BACKFILL_AF); const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url); expect(url).toContain(`/agents/${BACKFILL}`);
      const runtime = getCanonicalManagedAgentConfig(BACKFILL_AF); return jsonResponse({ id: BACKFILL, name: 'backfill', tags: REQUIRED, system: canonical, model: runtime.model, embedding: runtime.embedding, context_window_limit: runtime.contextWindowLimit, model_settings: { provider_type: 'deepseek', parallel_tool_calls: true }, llm_config: { handle: runtime.model, context_window: runtime.contextWindowLimit, parallel_tool_calls: true } });
    }));
    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    expect(calls.length).toBe(3);
    expect(calls.every((url) => !url.endsWith('/agents/'))).toBe(true);
  });


  it('can resolve a fill agent without the bundled prompt resource when canonical prompt reconciliation is opted out', async () => {
    process.env.LETTA_AGENT_ID = LIVE;
    const promptModule = await import('./managed_system_prompt.js');
    const originalPromptFile = promptModule.BUNDLED_MANAGED_SYSTEM_PROMPTS.backfill;
    promptModule.BUNDLED_MANAGED_SYSTEM_PROMPTS.backfill = path.join(os.tmpdir(), 'missing-backfill-system.md');
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); expect(url).toContain(`/agents/${BACKFILL}`);
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; patches.push(body);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ id: BACKFILL, name: 'backfill', tags: REQUIRED, system: 'canary-owned prompt' });
    }));
    try {
      await expect(getBackfillAgentId('test-key', () => {}, { agentId: BACKFILL, reconcileCanonicalPrompt: false })).resolves.toBe(BACKFILL);
      expect(patches.some((body) => 'system' in body)).toBe(false);
    } finally {
      promptModule.BUNDLED_MANAGED_SYSTEM_PROMPTS.backfill = originalPromptFile;
    }
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
          model_settings: { provider_type: profile.providerType, parallel_tool_calls: true },
        });
        patched = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        id: BACKFILL,
        model: patched ? profile.model : 'zai/glm-5',
        embedding: profile.embedding,
        context_window_limit: profile.contextWindow,
        llm_config: { handle: patched ? profile.model : 'zai/glm-5', context_window: profile.contextWindow, parallel_tool_calls: true },
        model_settings: { provider_type: patched ? profile.providerType : 'zai', parallel_tool_calls: true },
      });
    }));
    const logs: string[] = [];
    await expect(configureVerifiedLegacyFillRuntime('test-key', BACKFILL, (message) => logs.push(message))).resolves.toBeUndefined();
    expect(patched).toBe(true);
    expect(logs.join(' ')).toContain('context=400000');
    expect(logs.join(' ')).toContain('parallel_tool_calls=true');
  });


  it('applies and verifies the bounded Omen Alpha backfill runtime profile without changing the canonical default', async () => {
    const profile = OMEN_BACKFILL_VERIFIED_RUNTIME;
    expect(getCanonicalManagedAgentConfig(BACKFILL_AF).model).toBe(LEGACY_FILL_VERIFIED_RUNTIME.model);
    let patched = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); expect(url).toContain(`/agents/${BACKFILL}`);
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        expect(body).toEqual({
          model: profile.model,
          embedding: profile.embedding,
          context_window_limit: profile.contextWindow,
          model_settings: { provider_type: profile.providerType, parallel_tool_calls: true },
        });
        patched = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        id: BACKFILL,
        model: patched ? profile.model : LEGACY_FILL_VERIFIED_RUNTIME.model,
        embedding: profile.embedding,
        context_window_limit: profile.contextWindow,
        llm_config: { handle: patched ? profile.model : LEGACY_FILL_VERIFIED_RUNTIME.model, context_window: profile.contextWindow, parallel_tool_calls: true },
        model_settings: { provider_type: patched ? profile.providerType : LEGACY_FILL_VERIFIED_RUNTIME.providerType, parallel_tool_calls: true },
      });
    }));
    const logs: string[] = [];
    await expect(configureVerifiedOmenBackfillRuntime('test-key', BACKFILL, (message) => logs.push(message))).resolves.toBeUndefined();
    expect(patched).toBe(true);
    expect(logs.join(' ')).toContain('Omen Alpha');
    expect(logs.join(' ')).toContain('context=400000');
  });

  it('does not accept stale effective llm_config when top-level Omen fields already match', async () => {
    const profile = OMEN_BACKFILL_VERIFIED_RUNTIME;
    let patched = false;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        patched = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        id: BACKFILL,
        model: profile.model,
        embedding: profile.embedding,
        context_window_limit: profile.contextWindow,
        llm_config: {
          handle: patched ? profile.model : LEGACY_FILL_VERIFIED_RUNTIME.model,
          context_window: patched ? profile.contextWindow : 90000,
          parallel_tool_calls: true,
        },
        model_settings: { provider_type: profile.providerType, parallel_tool_calls: true },
      });
    }));

    await expect(configureVerifiedOmenBackfillRuntime('test-key', BACKFILL, () => {})).resolves.toBeUndefined();
    expect(patched).toBe(true);
  });

  it('verifies an already-matching Omen runtime without PATCH', async () => {
    const profile = OMEN_BACKFILL_VERIFIED_RUNTIME;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      return jsonResponse({
        id: BACKFILL, model: profile.model, embedding: profile.embedding, context_window_limit: profile.contextWindow,
        llm_config: { handle: profile.model, context_window: profile.contextWindow, parallel_tool_calls: true },
        model_settings: { provider_type: profile.providerType, parallel_tool_calls: true },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(configureVerifiedOmenBackfillRuntime('test-key', BACKFILL, () => {})).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it('tolerates a briefly stale GET after applying the verified runtime profile', async () => {
    const profile = LEGACY_FILL_VERIFIED_RUNTIME;
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return jsonResponse({ ok: true });
      reads += 1;
      if (reads <= 2) {
        return jsonResponse({
          id: BACKFILL,
          model: profile.model,
          embedding: profile.embedding,
          context_window_limit: profile.contextWindow,
          llm_config: { handle: profile.model, context_window: profile.contextWindow, parallel_tool_calls: false },
          model_settings: { provider_type: 'deepseek', parallel_tool_calls: false },
        });
      }
      return jsonResponse({
        id: BACKFILL,
        model: profile.model,
        embedding: profile.embedding,
        context_window_limit: profile.contextWindow,
        llm_config: { handle: profile.model, context_window: profile.contextWindow, parallel_tool_calls: true },
        model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
      });
    }));
    await expect(configureVerifiedLegacyFillRuntime('test-key', BACKFILL, () => {})).resolves.toBeUndefined();
    expect(reads).toBe(3);
  });

  it('reconciles an existing Omen agent directly to Omen and ignores live runtime overrides', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = BACKFILL;
    process.env.LETTA_MODEL = 'zai/glm-5'; process.env.LETTA_CONTEXT_WINDOW = '90000';
    const canonical = getCanonicalManagedSystemPrompt(BACKFILL_AF);
    const profile = OMEN_BACKFILL_VERIFIED_RUNTIME;
    let model: string = LEGACY_FILL_VERIFIED_RUNTIME.model; let embedding: string = profile.embedding; let contextWindow: number = profile.contextWindow; let providerType: string = LEGACY_FILL_VERIFIED_RUNTIME.providerType; let parallel = true;
    const runtimeModels: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        if (typeof body.model === 'string') { model = body.model; runtimeModels.push(body.model); }
        if (typeof body.embedding === 'string') embedding = body.embedding;
        if (typeof body.context_window_limit === 'number') contextWindow = body.context_window_limit;
        if (body.model_settings) { providerType = body.model_settings.provider_type; parallel = body.model_settings.parallel_tool_calls; }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        id: BACKFILL, name: 'backfill', tags: REQUIRED, system: canonical, model, embedding, context_window_limit: contextWindow,
        model_settings: { provider_type: providerType, parallel_tool_calls: parallel },
        llm_config: { handle: model, context_window: contextWindow, parallel_tool_calls: parallel },
      });
    }));
    await expect(getBackfillAgentId('test-key', () => {}, { runtime: 'omen' })).resolves.toBe(BACKFILL);
    expect(runtimeModels).toEqual([profile.model]);
    expect(runtimeModels).not.toContain(LEGACY_FILL_VERIFIED_RUNTIME.model);
    expect(model).toBe(profile.model); expect(contextWindow).toBe(profile.contextWindow); expect(providerType).toBe(profile.providerType);
  });

  it('keeps operator context overrides enabled for ordinary backfill by default', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = BACKFILL;
    process.env.LETTA_CONTEXT_WINDOW = '91000';
    const canonical = getCanonicalManagedAgentConfig(BACKFILL_AF);
    let contextWindow = canonical.contextWindowLimit;
    const patches: Array<Record<string, any>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); expect(url).toContain(`/agents/${BACKFILL}`);
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        patches.push(body);
        if (typeof body.context_window_limit === 'number') contextWindow = body.context_window_limit;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        id: BACKFILL, name: 'backfill', tags: REQUIRED, system: canonical.system,
        model: canonical.model, embedding: canonical.embedding, context_window_limit: contextWindow,
        model_settings: { provider_type: canonical.modelSettingsProviderType, parallel_tool_calls: true },
        llm_config: { handle: canonical.model, context_window: contextWindow, parallel_tool_calls: true },
      });
    }));

    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    expect(patches.some((body) => body.context_window_limit === 91000)).toBe(true);
    expect(contextWindow).toBe(91000);
  });

  it('fails closed before any mutation if dedicated and live identities collapse', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_BACKFILL_AGENT_ID = LIVE;
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(getBackfillAgentId('test-key', () => {})).rejects.toThrow('must differ from live Subconscious agent');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconciles from canonical backfill Markdown and adds durable purpose identity', async () => {
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
      return jsonResponse({ id: BACKFILL, name: 'backfill', tags, system, model, embedding, context_window_limit: contextWindow, model_settings: { provider_type: model.includes('deepseek') ? 'deepseek' : 'zai', parallel_tool_calls: parallel }, llm_config: { handle: model, context_window: contextWindow, parallel_tool_calls: parallel } });
    }));
    await expect(getBackfillAgentId('test-key', () => {})).resolves.toBe(BACKFILL);
    expect(tags).toContain(BACKFILL_PURPOSE_TAG); expect(system).toBe(canonical);
    expect(patches.some((body) => body.system === canonical)).toBe(true);
    const runtimePatch = patches.find((body) => body.model === getCanonicalManagedAgentConfig(BACKFILL_AF).model);
    expect(runtimePatch).toEqual(expect.objectContaining({ embedding: getCanonicalManagedAgentConfig(BACKFILL_AF).embedding, context_window_limit: getCanonicalManagedAgentConfig(BACKFILL_AF).contextWindowLimit, model_settings: { provider_type: 'deepseek', parallel_tool_calls: true } }));
  });

  it('imports a new Omen agent with the Omen model from the first remote mutation', async () => {
    process.env.LETTA_AGENT_ID = LIVE; process.env.LETTA_MODEL = 'zai/glm-5';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-agent-omen-'));
    process.env.LETTA_BACKFILL_CONFIG_FILE = path.join(dir, 'backfill.json');
    const canonical = getCanonicalManagedSystemPrompt(BACKFILL_AF); const profile = OMEN_BACKFILL_VERIFIED_RUNTIME;
    let tags: string[] = []; let model: string = profile.model; let embedding: string = profile.embedding; let contextWindow: number = profile.contextWindow; let providerType: string = profile.providerType; let parallel = true;
    let importedModel: FormDataEntryValue | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (url.endsWith('/agents/import')) {
        const form = init?.body as FormData; importedModel = form.get('model');
        expect(form.get('embedding')).toBe(profile.embedding);
        return jsonResponse({ agent_ids: [BACKFILL] });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        if (Array.isArray(body.tags)) tags = body.tags;
        if (typeof body.model === 'string') model = body.model;
        if (typeof body.embedding === 'string') embedding = body.embedding;
        if (typeof body.context_window_limit === 'number') contextWindow = body.context_window_limit;
        if (body.model_settings) { providerType = body.model_settings.provider_type; parallel = body.model_settings.parallel_tool_calls; }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        id: BACKFILL, name: 'backfill', tags, system: canonical, model, embedding, context_window_limit: contextWindow,
        model_settings: { provider_type: providerType, parallel_tool_calls: parallel },
        llm_config: { handle: model, context_window: contextWindow, parallel_tool_calls: parallel },
      });
    }));
    await expect(getBackfillAgentId('test-key', () => {}, { runtime: 'omen' })).resolves.toBe(BACKFILL);
    expect(importedModel).toBe(profile.model);
    expect(importedModel).not.toBe(LEGACY_FILL_VERIFIED_RUNTIME.model);
    fs.rmSync(dir, { recursive: true, force: true });
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
      return jsonResponse({ id: BACKFILL, name: 'backfill', tags, system: agentSystem, model, embedding, context_window_limit: contextWindow, model_settings: { provider_type: model.includes('deepseek') ? 'deepseek' : 'zai', parallel_tool_calls: parallel }, llm_config: { handle: model, context_window: contextWindow, parallel_tool_calls: parallel } });
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