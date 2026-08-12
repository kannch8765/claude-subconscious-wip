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
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: ID, name: 'Subconscious', system: 'stale prompt',
        llm_config: { handle: 'zai/glm-5', context_window: 90000, parallel_tool_calls: false },
        embedding_config: { handle: 'openai/text-embedding-3-small' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await reconcileManagedAgentConfiguration('test-key', ID, () => {});
    expect(patches).toEqual([{
      system: canonical.system,
      model: canonical.model,
      embedding: canonical.embedding,
      context_window_limit: canonical.contextWindowLimit,
      model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
    }]);
  });

  it('preserves explicit operator model/context overrides', async () => {
    process.env.LETTA_MODEL = 'operator/custom-model';
    process.env.LETTA_CONTEXT_WINDOW = '250000';
    const canonical = getCanonicalManagedAgentConfig();
    let patch: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: ID, name: 'Subconscious', system: canonical.system, model: canonical.model,
        embedding: canonical.embedding, context_window_limit: canonical.contextWindowLimit,
        model_settings: { provider_type: 'deepseek', parallel_tool_calls: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await reconcileManagedAgentConfiguration('test-key', ID, () => {});
    expect(patch).toEqual({ model: 'operator/custom-model', context_window_limit: 250000 });
  });
});
