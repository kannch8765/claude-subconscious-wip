import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCanonicalManagedAgentConfig, reconcileManagedAgentConfiguration } from './agent_config.js';

const ID = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LETTA_MODEL;
  delete process.env.LETTA_CONTEXT_WINDOW;
});

describe('Task 093AC managed runtime configuration authority', () => {
  it('reads the intended runtime policy from canonical Subconscious.af', () => {
    expect(getCanonicalManagedAgentConfig()).toEqual(expect.objectContaining({
      model: 'opencode-deepseek/deepseek-v4-flash',
      embedding: 'local-fastembed/paraphrase-multilingual-minilm-l12-v2-padded768',
      contextWindowLimit: 400000,
      modelSettingsProviderType: 'deepseek',
      parallelToolCalls: true,
    }));
  });

  it('converges stale z.ai/OpenAI/parallel/context state in one managed PATCH', async () => {
    const canonical = getCanonicalManagedAgentConfig();
    const live = {
      id: ID, name: 'Subconscious', system: 'stale prompt',
      model: 'zai/glm-5',
      embedding: 'openai/text-embedding-3-small',
      context_window_limit: 90000,
      model_settings: { provider_type: 'zai', parallel_tool_calls: false } as Record<string, unknown>,
      llm_config: { handle: 'zai/glm-5', model_endpoint_type: 'zai', context_window: 90000, parallel_tool_calls: false },
    };
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patches.push(patch);
        if (typeof patch.system === 'string') live.system = patch.system;
        if (typeof patch.model === 'string') { live.model = patch.model; live.llm_config.handle = patch.model; }
        if (typeof patch.embedding === 'string') live.embedding = patch.embedding;
        if (typeof patch.context_window_limit === 'number') {
          live.context_window_limit = patch.context_window_limit;
          live.llm_config.context_window = patch.context_window_limit;
        }
        if (patch.model_settings && typeof patch.model_settings === 'object') {
          live.model_settings = patch.model_settings as Record<string, unknown>;
          live.llm_config.model_endpoint_type = String((patch.model_settings as Record<string, unknown>).provider_type);
          live.llm_config.parallel_tool_calls = Boolean((patch.model_settings as Record<string, unknown>).parallel_tool_calls);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(live), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await reconcileManagedAgentConfiguration('test-key', ID, () => {});
    expect(patches).toEqual([{
      system: canonical.system,
      model: canonical.model,
      embedding: canonical.embedding,
      context_window_limit: canonical.contextWindowLimit,
      model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
    }]);
    expect(live.model_settings.parallel_tool_calls).toBe(true);
    expect(live.llm_config.parallel_tool_calls).toBe(true);
  });

  it('repairs model_settings=true / effective llm_config=false and is idempotent', async () => {
    const canonical = getCanonicalManagedAgentConfig();
    const live = {
      id: ID,
      name: 'Subconscious',
      system: canonical.system,
      model: canonical.model,
      embedding: canonical.embedding,
      context_window_limit: canonical.contextWindowLimit,
      model_settings: { provider_type: 'deepseek', parallel_tool_calls: true } as Record<string, unknown>,
      llm_config: {
        handle: canonical.model,
        model_endpoint_type: 'deepseek',
        context_window: canonical.contextWindowLimit,
        parallel_tool_calls: false,
      },
    };
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patches.push(patch);
        if (patch.model_settings && typeof patch.model_settings === 'object') {
          live.model_settings = patch.model_settings as Record<string, unknown>;
          // Letta 0.16.8 _to_legacy_config_params() updates the effective legacy config.
          live.llm_config.parallel_tool_calls = Boolean((patch.model_settings as Record<string, unknown>).parallel_tool_calls);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(live), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await reconcileManagedAgentConfiguration('test-key', ID, () => {});
    await reconcileManagedAgentConfiguration('test-key', ID, () => {});

    expect(patches).toEqual([{
      model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
    }]);
    expect(live.model_settings.parallel_tool_calls).toBe(true);
    expect(live.llm_config.parallel_tool_calls).toBe(true);
  });

  it('fails reconciliation when Letta does not propagate parallel_tool_calls to effective llm_config', async () => {
    const canonical = getCanonicalManagedAgentConfig();
    const live = {
      id: ID,
      name: 'Subconscious',
      system: canonical.system,
      model: canonical.model,
      embedding: canonical.embedding,
      context_window_limit: canonical.contextWindowLimit,
      model_settings: { provider_type: 'deepseek', parallel_tool_calls: true } as Record<string, unknown>,
      llm_config: {
        handle: canonical.model,
        model_endpoint_type: 'deepseek',
        context_window: canonical.contextWindowLimit,
        parallel_tool_calls: false,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(live), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await expect(reconcileManagedAgentConfiguration('test-key', ID, () => {}))
      .rejects.toThrow('effective parallel_tool_calls reconciliation failed');
  });

  it('pairs a cross-provider operator model override with Letta metadata and is idempotent', async () => {
    const overrideModel = 'openai-proxy/glm-5.2';
    process.env.LETTA_MODEL = overrideModel;
    const canonical = getCanonicalManagedAgentConfig();
    const live = {
      id: ID,
      name: 'Subconscious',
      system: canonical.system,
      model: canonical.model,
      embedding: canonical.embedding,
      context_window_limit: canonical.contextWindowLimit,
      model_settings: { provider_type: 'deepseek', parallel_tool_calls: true } as Record<string, unknown>,
      llm_config: { handle: canonical.model, model_endpoint_type: 'deepseek', context_window: canonical.contextWindowLimit, parallel_tool_calls: true },
    };
    const patches: Array<Record<string, unknown>> = [];
    let modelMetadataReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/v1/models/' && method === 'GET') {
        modelMetadataReads += 1;
        return new Response(JSON.stringify([
          { model: 'glm-5.2', name: 'glm-5.2', provider_type: 'openai', handle: overrideModel },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patches.push(patch);
        if (typeof patch.model === 'string') {
          live.model = patch.model;
          live.llm_config.handle = patch.model;
        }
        if (typeof patch.context_window_limit === 'number') {
          live.context_window_limit = patch.context_window_limit;
          live.llm_config.context_window = patch.context_window_limit;
        }
        if (patch.model_settings && typeof patch.model_settings === 'object') {
          live.model_settings = patch.model_settings as Record<string, unknown>;
          live.llm_config.model_endpoint_type = String((patch.model_settings as Record<string, unknown>).provider_type);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(live), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await reconcileManagedAgentConfiguration('test-key', ID, () => {});
    await reconcileManagedAgentConfiguration('test-key', ID, () => {});

    expect(patches).toEqual([{
      model: overrideModel,
      context_window_limit: canonical.contextWindowLimit,
      model_settings: { provider_type: 'openai', parallel_tool_calls: true },
    }]);
    expect(live.model).toBe(overrideModel);
    expect(live.model_settings).toEqual({ provider_type: 'openai', parallel_tool_calls: true });
    expect(modelMetadataReads).toBe(2);
  });
});
