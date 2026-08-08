import { mapUsage, type LettaReadTransport } from './index.js';

export type PromptCacheTelemetryQuality = 'covered' | 'uncovered' | 'ineligible' | 'invalid';

export interface PromptCacheStepSample {
  stepId: string;
  runId: string;
  conversationId?: string;
  model?: string;
  modelHandle?: string;
  promptTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cachedInputRatio?: number;
  telemetryQuality: PromptCacheTelemetryQuality;
  invalidReason?: string;
}

export interface PromptCacheAggregate {
  eligibleSteps: number;
  coveredSteps: number;
  uncoveredSteps: number;
  ineligibleSteps: number;
  invalidSteps: number;
  eligiblePromptTokens: number;
  coveredPromptTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  cachedInputRatio?: number;
  coverageRatio?: number;
  tokenCoverageRatio?: number;
}

export interface PromptCacheRunSummary {
  runId: string;
  conversationId?: string;
  steps: PromptCacheStepSample[];
  aggregate: PromptCacheAggregate;
}

export interface PromptCacheConversationSummary {
  conversationId: string;
  runIds: string[];
  steps: PromptCacheStepSample[];
  aggregate: PromptCacheAggregate;
}

export interface AgentPromptCacheEffectiveness {
  agentId: string;
  runs: PromptCacheRunSummary[];
  conversations: PromptCacheConversationSummary[];
  aggregate: PromptCacheAggregate;
}

type RawRecord = Record<string, unknown>;

const asRecord = (value: unknown): RawRecord => value && typeof value === 'object' ? value as RawRecord : {};
const maybeString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

export function mapPromptCacheStepSample(
  raw: unknown,
  parent: { runId: string; conversationId?: string },
): PromptCacheStepSample {
  const step = asRecord(raw);
  const stepId = maybeString(step.id);
  if (!stepId) throw new Error('Letta step is missing id');

  const { promptTokens, cachedInputTokens, cacheWriteTokens } = mapUsage(step);
  const base: PromptCacheStepSample = {
    stepId,
    runId: maybeString(step.run_id) ?? parent.runId,
    conversationId: parent.conversationId,
    model: maybeString(step.model),
    modelHandle: maybeString(step.model_handle),
    promptTokens,
    cachedInputTokens,
    cacheWriteTokens,
    telemetryQuality: 'uncovered',
  };

  if (promptTokens !== undefined && promptTokens < 0) {
    return { ...base, telemetryQuality: 'invalid', invalidReason: 'negative_prompt_tokens' };
  }
  if (cachedInputTokens !== undefined && cachedInputTokens < 0) {
    return { ...base, telemetryQuality: 'invalid', invalidReason: 'negative_cached_input_tokens' };
  }
  if (cacheWriteTokens !== undefined && cacheWriteTokens < 0) {
    return { ...base, telemetryQuality: 'invalid', invalidReason: 'negative_cache_write_tokens' };
  }
  if (promptTokens === undefined || promptTokens === 0) {
    return { ...base, telemetryQuality: 'ineligible' };
  }
  if (cachedInputTokens === undefined) {
    return { ...base, telemetryQuality: 'uncovered' };
  }
  if (cachedInputTokens > promptTokens) {
    return { ...base, telemetryQuality: 'invalid', invalidReason: 'cached_input_tokens_exceed_prompt_tokens' };
  }

  return {
    ...base,
    telemetryQuality: 'covered',
    cachedInputRatio: cachedInputTokens / promptTokens,
  };
}

export function aggregatePromptCacheSamples(samples: readonly PromptCacheStepSample[]): PromptCacheAggregate {
  let eligibleSteps = 0;
  let coveredSteps = 0;
  let uncoveredSteps = 0;
  let ineligibleSteps = 0;
  let invalidSteps = 0;
  let eligiblePromptTokens = 0;
  let coveredPromptTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let hasCacheWriteTelemetry = false;

  for (const sample of samples) {
    const prompt = sample.promptTokens;
    const eligible = prompt !== undefined && prompt > 0;
    if (eligible) {
      eligibleSteps += 1;
      eligiblePromptTokens += prompt;
    }

    if (sample.telemetryQuality === 'covered') {
      if (!eligible || sample.cachedInputTokens === undefined || sample.cachedInputTokens < 0 || sample.cachedInputTokens > prompt) {
        invalidSteps += 1;
        if (eligible) uncoveredSteps += 1;
        continue;
      }
      coveredSteps += 1;
      coveredPromptTokens += prompt;
      cachedInputTokens += sample.cachedInputTokens;
      if (sample.cacheWriteTokens !== undefined && sample.cacheWriteTokens >= 0) {
        cacheWriteTokens += sample.cacheWriteTokens;
        hasCacheWriteTelemetry = true;
      }
    } else if (sample.telemetryQuality === 'invalid') {
      invalidSteps += 1;
      if (eligible) uncoveredSteps += 1;
    } else if (sample.telemetryQuality === 'uncovered') {
      if (eligible) uncoveredSteps += 1;
    } else {
      ineligibleSteps += 1;
    }
  }

  return {
    eligibleSteps,
    coveredSteps,
    uncoveredSteps,
    ineligibleSteps,
    invalidSteps,
    eligiblePromptTokens,
    coveredPromptTokens,
    cachedInputTokens,
    cacheWriteTokens: hasCacheWriteTelemetry ? cacheWriteTokens : undefined,
    cachedInputRatio: coveredPromptTokens > 0 ? cachedInputTokens / coveredPromptTokens : undefined,
    coverageRatio: eligibleSteps > 0 ? coveredSteps / eligibleSteps : undefined,
    tokenCoverageRatio: eligiblePromptTokens > 0 ? coveredPromptTokens / eligiblePromptTokens : undefined,
  };
}

export function groupPromptCacheByConversation(runs: readonly PromptCacheRunSummary[]): PromptCacheConversationSummary[] {
  const grouped = new Map<string, { runIds: string[]; steps: PromptCacheStepSample[] }>();
  for (const run of runs) {
    if (!run.conversationId) continue;
    const existing = grouped.get(run.conversationId) ?? { runIds: [], steps: [] };
    existing.runIds.push(run.runId);
    existing.steps.push(...run.steps);
    grouped.set(run.conversationId, existing);
  }
  return [...grouped.entries()].map(([conversationId, group]) => ({
    conversationId,
    runIds: group.runIds,
    steps: group.steps,
    aggregate: aggregatePromptCacheSamples(group.steps),
  }));
}

export async function collectAgentPromptCacheEffectiveness(
  transport: LettaReadTransport,
  agentId: string,
  limit = 10,
): Promise<AgentPromptCacheEffectiveness> {
  const runsRaw = await transport.getJson('/runs/', { agent_id: agentId, limit });
  const runs = Array.isArray(runsRaw)
    ? runsRaw.map(asRecord).filter(run => run.agent_id === agentId).slice(0, limit)
    : [];

  const summaries: PromptCacheRunSummary[] = [];
  for (const run of runs) {
    const runId = maybeString(run.id);
    if (!runId) throw new Error('Letta run is missing id');
    const conversationId = maybeString(run.conversation_id);
    const stepsRaw = await transport.getJson(`/runs/${runId}/steps`);
    const steps = Array.isArray(stepsRaw)
      ? stepsRaw.map(step => mapPromptCacheStepSample(step, { runId, conversationId }))
      : [];
    summaries.push({ runId, conversationId, steps, aggregate: aggregatePromptCacheSamples(steps) });
  }

  const allSteps = summaries.flatMap(run => run.steps);
  return {
    agentId,
    runs: summaries,
    conversations: groupPromptCacheByConversation(summaries),
    aggregate: aggregatePromptCacheSamples(allSteps),
  };
}
