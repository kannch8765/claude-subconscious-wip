import { describe, expect, it } from 'vitest';
import {
  aggregatePromptCacheSamples,
  collectAgentPromptCacheEffectiveness,
  groupPromptCacheByConversation,
  mapPromptCacheStepSample,
  mapUsage,
  type LettaReadTransport,
  type PromptCacheRunSummary,
} from '../src/observability/index.js';

class FixtureTransport implements LettaReadTransport {
  calls: Array<{ path: string; query: Record<string, unknown> }> = [];
  constructor(private readonly fixtures: Record<string, unknown>) {}
  async getJson<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, query });
    if (!(path in this.fixtures)) throw new Error(`missing fixture ${path}`);
    return this.fixtures[path] as T;
  }
}

describe('prompt cache effectiveness abstraction', () => {
  it('derives prompt-cache tokens from the canonical mapUsage semantics', () => {
    const raw = {
      id: 's-canonical',
      context_window_limit: 400000,
      usage: {
        prompt_tokens: 120,
        completion_tokens: 7,
        total_tokens: 127,
        prompt_tokens_details: { cache_read_tokens: 90, cache_creation_tokens: 4 },
      },
    };
    const canonical = mapUsage(raw);
    const sample = mapPromptCacheStepSample(raw, { runId: 'r-canonical' });
    expect(canonical).toMatchObject({ promptTokens: 120, cachedInputTokens: 90, cacheWriteTokens: 4 });
    expect(sample).toMatchObject({
      promptTokens: canonical.promptTokens,
      completionTokens: canonical.completionTokens,
      cachedInputTokens: canonical.cachedInputTokens,
      cacheWriteTokens: canonical.cacheWriteTokens,
      contextWindowLimit: 400000,
      cachedInputRatio: 0.75,
      telemetryQuality: 'covered',
    });
  });

  it('preserves an observed zero cache read and produces ratio zero', () => {
    const sample = mapPromptCacheStepSample(
      { id: 's0', run_id: 'r0', prompt_tokens: 100, cached_input_tokens: 0 },
      { runId: 'r0', conversationId: 'c0' },
    );
    expect(sample).toMatchObject({
      stepId: 's0', runId: 'r0', conversationId: 'c0', promptTokens: 100,
      cachedInputTokens: 0, cachedInputRatio: 0, telemetryQuality: 'covered',
    });
    expect(aggregatePromptCacheSamples([sample])).toMatchObject({ coveredSteps: 1, uncoveredSteps: 0, cachedInputRatio: 0 });
  });

  it('keeps missing cache telemetry unknown and excludes it from the weighted denominator', () => {
    const covered = mapPromptCacheStepSample({ id: 's1', prompt_tokens: 100, cached_input_tokens: 50 }, { runId: 'r1' });
    const unknown = mapPromptCacheStepSample({ id: 's2', prompt_tokens: 900 }, { runId: 'r1' });
    expect(unknown.telemetryQuality).toBe('uncovered');
    expect(unknown.cachedInputTokens).toBeUndefined();
    const aggregate = aggregatePromptCacheSamples([covered, unknown]);
    expect(aggregate).toMatchObject({
      eligibleSteps: 2,
      coveredSteps: 1,
      uncoveredSteps: 1,
      eligiblePromptTokens: 1000,
      coveredPromptTokens: 100,
      cachedInputTokens: 50,
      cachedInputRatio: 0.5,
      coverageRatio: 0.5,
      tokenCoverageRatio: 0.1,
    });
  });

  it('does not define a ratio for missing or zero prompt tokens', () => {
    const missing = mapPromptCacheStepSample({ id: 's-missing', cached_input_tokens: 0 }, { runId: 'r1' });
    const zero = mapPromptCacheStepSample({ id: 's-zero', prompt_tokens: 0, cached_input_tokens: 0 }, { runId: 'r1' });
    expect(missing.telemetryQuality).toBe('ineligible');
    expect(zero.telemetryQuality).toBe('ineligible');
    expect(missing.cachedInputRatio).toBeUndefined();
    expect(zero.cachedInputRatio).toBeUndefined();
    expect(aggregatePromptCacheSamples([missing, zero])).toMatchObject({ eligibleSteps: 0, coveredSteps: 0, ineligibleSteps: 2 });
    expect(aggregatePromptCacheSamples([missing, zero]).cachedInputRatio).toBeUndefined();
  });

  it('uses token-weighted aggregation rather than averaging step percentages', () => {
    const tinyHot = mapPromptCacheStepSample({ id: 'hot', prompt_tokens: 10, cached_input_tokens: 10 }, { runId: 'r1' });
    const largeCold = mapPromptCacheStepSample({ id: 'cold', prompt_tokens: 90, cached_input_tokens: 0 }, { runId: 'r1' });
    const aggregate = aggregatePromptCacheSamples([tinyHot, largeCold]);
    expect(aggregate.cachedInputRatio).toBe(0.1);
    expect((tinyHot.cachedInputRatio! + largeCold.cachedInputRatio!) / 2).toBe(0.5);
  });

  it('counts coverage correctly, including observed zero as covered', () => {
    const samples = [
      mapPromptCacheStepSample({ id: 'a', prompt_tokens: 10, cached_input_tokens: 0 }, { runId: 'r1' }),
      mapPromptCacheStepSample({ id: 'b', prompt_tokens: 20, cached_input_tokens: 5 }, { runId: 'r1' }),
      mapPromptCacheStepSample({ id: 'c', prompt_tokens: 30 }, { runId: 'r1' }),
      mapPromptCacheStepSample({ id: 'd', prompt_tokens: 0 }, { runId: 'r1' }),
    ];
    expect(aggregatePromptCacheSamples(samples)).toMatchObject({
      eligibleSteps: 3, coveredSteps: 2, uncoveredSteps: 1, ineligibleSteps: 1, coverageRatio: 2 / 3,
    });
  });

  it('groups only by exact Letta conversation_id and keeps conversations separate', () => {
    const run = (runId: string, conversationId: string): PromptCacheRunSummary => {
      const steps = [mapPromptCacheStepSample({ id: `${runId}-s`, prompt_tokens: 10, cached_input_tokens: 5 }, { runId, conversationId })];
      return { runId, conversationId, steps, aggregate: aggregatePromptCacheSamples(steps) };
    };
    const groups = groupPromptCacheByConversation([run('r1', 'conversation-A'), run('r2', 'conversation-A'), run('r3', 'conversation-B')]);
    expect(groups.map(group => [group.conversationId, group.runIds])).toEqual([
      ['conversation-A', ['r1', 'r2']],
      ['conversation-B', ['r3']],
    ]);
  });

  it('collects through runs then per-run steps without depending on global /steps/', async () => {
    const transport = new FixtureTransport({
      '/runs/': [
        { id: 'r1', agent_id: 'agent-a', conversation_id: 'c1' },
        { id: 'r2', agent_id: 'agent-a', conversation_id: 'c2' },
        { id: 'other', agent_id: 'agent-b', conversation_id: 'c3' },
      ],
      '/runs/r1/steps': [{ id: 's1', prompt_tokens: 100, cached_input_tokens: 80 }],
      '/runs/r2/steps': [{ id: 's2', prompt_tokens: 50, cached_input_tokens: 0 }],
    });
    const result = await collectAgentPromptCacheEffectiveness(transport, 'agent-a', 10);
    expect(result.runs.map(run => run.runId)).toEqual(['r1', 'r2']);
    expect(result.conversations.map(group => group.conversationId)).toEqual(['c1', 'c2']);
    expect(result.aggregate.cachedInputRatio).toBe(80 / 150);
    expect(transport.calls[0]).toEqual({ path: '/runs/', query: { agent_id: 'agent-a', limit: 10 } });
    expect(transport.calls.map(call => call.path)).toEqual(['/runs/', '/runs/r1/steps', '/runs/r2/steps']);
    expect(transport.calls.some(call => call.path === '/steps/')).toBe(false);
  });

  it('returns metadata only even when raw step fixtures contain secret payloads', () => {
    const sample = mapPromptCacheStepSample({
      id: 's-secret', run_id: 'r-secret', model: 'deepseek-v4-flash', model_handle: 'provider/model',
      prompt_tokens: 100, completion_tokens: 9, cached_input_tokens: 75, cache_write_tokens: 2, context_window_limit: 400000,
      prompt: 'SECRET PROMPT', system_prompt: 'SECRET SYSTEM', reasoning: 'SECRET REASONING',
      messages: [{ content: 'SECRET MESSAGE' }], tool_args: { password: 'SECRET TOOL ARG' }, tool_return: 'SECRET TOOL RETURN',
    }, { runId: 'r-secret', conversationId: 'c-secret' });
    const serialized = JSON.stringify(sample);
    expect(sample).toMatchObject({
      model: 'deepseek-v4-flash',
      modelHandle: 'provider/model',
      promptTokens: 100,
      completionTokens: 9,
      cachedInputTokens: 75,
      cacheWriteTokens: 2,
      contextWindowLimit: 400000,
    });
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('system_prompt');
    expect(serialized).not.toContain('tool_args');
    expect(serialized).not.toContain('tool_return');
  });

  it('marks malformed token telemetry invalid instead of producing plausible percentages', () => {
    const negativePrompt = mapPromptCacheStepSample({ id: 'neg-prompt', prompt_tokens: -1, cached_input_tokens: 0 }, { runId: 'r1' });
    const negativeCache = mapPromptCacheStepSample({ id: 'neg-cache', prompt_tokens: 10, cached_input_tokens: -1 }, { runId: 'r1' });
    const overPrompt = mapPromptCacheStepSample({ id: 'over', prompt_tokens: 10, cached_input_tokens: 11 }, { runId: 'r1' });
    expect(negativePrompt).toMatchObject({ telemetryQuality: 'invalid', invalidReason: 'negative_prompt_tokens' });
    expect(negativeCache).toMatchObject({ telemetryQuality: 'invalid', invalidReason: 'negative_cached_input_tokens' });
    expect(overPrompt).toMatchObject({ telemetryQuality: 'invalid', invalidReason: 'cached_input_tokens_exceed_prompt_tokens' });
    expect(negativePrompt.cachedInputRatio).toBeUndefined();
    expect(negativeCache.cachedInputRatio).toBeUndefined();
    expect(overPrompt.cachedInputRatio).toBeUndefined();
    const aggregate = aggregatePromptCacheSamples([negativePrompt, negativeCache, overPrompt]);
    expect(aggregate).toMatchObject({ invalidSteps: 3, eligibleSteps: 2, coveredSteps: 0, uncoveredSteps: 2 });
    expect(aggregate.cachedInputRatio).toBeUndefined();
  });
});
