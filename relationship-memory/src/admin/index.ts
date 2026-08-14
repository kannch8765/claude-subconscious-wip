import type { EffectiveSearchQuery, RelationshipMemoryOwnerControlPlane } from '../owner/index.js';
import { MEMORY_KINDS, type MemoryKind, type ParticipantRole } from '../schema/index.js';
import {
  LettaReadError,
  collectAgentPromptCacheEffectiveness,
  getAgentRuntimeOverview,
  listRecentRunSummaries,
  unavailableProviderUsage,
  type AgentRuntimeOverview,
  type LettaReadTransport,
  type PromptCacheAggregate,
  type PromptCacheRunSummary,
  type PromptCacheStepSample,
  type ProviderUsageSlot,
  type RecentRunSummary,
} from '../observability/index.js';

export type AdminSectionAvailability = 'available' | 'unreachable' | 'error';

export interface AdminSectionError {
  kind: 'unreachable' | 'query_error';
  message: string;
}

export interface AdminSectionState {
  availability: AdminSectionAvailability;
  error?: AdminSectionError;
}

export interface AdminRuntimeSection extends AdminSectionState {
  overview: AgentRuntimeOverview;
}

export interface AdminRecentRunsSection extends AdminSectionState {
  items: RecentRunSummary[];
}

export interface AdminPromptCacheRun {
  runId: string;
  aggregate: PromptCacheAggregate;
}

export interface AdminPromptCacheConversation {
  conversationId: string;
  runIds: string[];
  runs: AdminPromptCacheRun[];
  aggregate: PromptCacheAggregate;
}

export interface AdminPromptCacheStepContext {
  stepId: string;
  runId: string;
  promptTokens: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cachedInputRatio?: number;
  contextWindowLimit?: number;
  model?: string;
  modelHandle?: string;
}

export interface AdminPromptCacheLastRun {
  runId: string;
  stepCount: number;
  peakPromptStep?: AdminPromptCacheStepContext;
}

export interface AdminPromptCacheSection extends AdminSectionState {
  aggregate?: PromptCacheAggregate;
  lastRun?: AdminPromptCacheLastRun;
  conversations: AdminPromptCacheConversation[];
}

export interface RelationshipMemorySummary {
  genesisMemoryCount: number;
  effectiveMemoryCount: number;
  activeMemoryCount: number;
  inactiveMemoryCount: number;
  ownerCorrectedCount: number;
  countsByKind: Record<MemoryKind, number>;
  ownerRevisionCount: number;
  latestOwnerRevisionAt?: string;
}

export interface EffectiveMemoryAdminRow {
  memoryId: string;
  kind: MemoryKind;
  summary: string;
  status: 'active' | 'inactive';
  ownerCorrected: boolean;
  latestRevisionId?: string;
  latestRevisionAt?: string;
  participants: ParticipantRole[];
  linkedMemoryIds?: string[];
}

export interface AdminRelationshipMemorySection extends AdminSectionState {
  availability: 'available';
  summary: RelationshipMemorySummary;
  rows: EffectiveMemoryAdminRow[];
}

export interface SubconsciousAdminSnapshot {
  agentId: string;
  runtime: AdminRuntimeSection;
  recentRuns: AdminRecentRunsSection;
  promptCache: AdminPromptCacheSection;
  relationshipMemory: AdminRelationshipMemorySection;
}

export interface SubconsciousAdminDependencies {
  owner: RelationshipMemoryOwnerControlPlane;
  transport: LettaReadTransport;
  agentId: string;
  providerUsage?: ProviderUsageSlot;
  now?: () => Date;
}

export interface SubconsciousAdminSnapshotOptions {
  recentRunLimit?: number;
  cacheRunLimit?: number;
  memoryQuery?: EffectiveSearchQuery;
}

function sectionError(error: unknown): AdminSectionState {
  const unreachable = error instanceof LettaReadError && error.kind === 'unreachable';
  return {
    availability: unreachable ? 'unreachable' : 'error',
    error: {
      kind: unreachable ? 'unreachable' : 'query_error',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function projectPromptStepContext(sample: PromptCacheStepSample): AdminPromptCacheStepContext | undefined {
  if (sample.promptTokens === undefined || sample.promptTokens <= 0) return undefined;
  const cacheCovered = sample.telemetryQuality === 'covered';
  return {
    stepId: sample.stepId,
    runId: sample.runId,
    promptTokens: sample.promptTokens,
    ...(sample.completionTokens !== undefined ? { completionTokens: sample.completionTokens } : {}),
    ...(cacheCovered && sample.cachedInputTokens !== undefined ? { cachedInputTokens: sample.cachedInputTokens } : {}),
    ...(sample.cacheWriteTokens !== undefined && sample.cacheWriteTokens >= 0 ? { cacheWriteTokens: sample.cacheWriteTokens } : {}),
    ...(cacheCovered && sample.cachedInputRatio !== undefined ? { cachedInputRatio: sample.cachedInputRatio } : {}),
    ...(sample.contextWindowLimit !== undefined && sample.contextWindowLimit > 0 ? { contextWindowLimit: sample.contextWindowLimit } : {}),
    ...(sample.model ? { model: sample.model } : {}),
    ...(sample.modelHandle ? { modelHandle: sample.modelHandle } : {}),
  };
}

export function summarizeLastRunPromptContext(
  runs: readonly PromptCacheRunSummary[],
  lastRunId?: string,
): AdminPromptCacheLastRun | undefined {
  if (!lastRunId) return undefined;
  const run = runs.find(candidate => candidate.runId === lastRunId);
  if (!run) return undefined;
  const projected = run.steps
    .map(projectPromptStepContext)
    .filter((step): step is AdminPromptCacheStepContext => Boolean(step));
  const peakPromptStep = projected.reduce<AdminPromptCacheStepContext | undefined>(
    (peak, step) => !peak || step.promptTokens > peak.promptTokens ? step : peak,
    undefined,
  );
  return {
    runId: run.runId,
    stepCount: run.steps.length,
    ...(peakPromptStep ? { peakPromptStep } : {}),
  };
}

function runtimeSection(overview: AgentRuntimeOverview): AdminRuntimeSection {
  if (overview.activity === 'unreachable') {
    return {
      availability: 'unreachable',
      overview,
      error: overview.error ?? { kind: 'unreachable', message: 'Letta runtime is unreachable' },
    };
  }
  if (overview.activity === 'error') {
    return {
      availability: 'error',
      overview,
      error: overview.error ?? { kind: 'query_error', message: 'Letta runtime query failed' },
    };
  }
  return { availability: 'available', overview };
}

export function summarizeRelationshipMemory(owner: RelationshipMemoryOwnerControlPlane): RelationshipMemorySummary {
  const genesis = owner.store.listMemories();
  const effective = owner.listEffective();
  const revisions = owner.store.listOwnerRevisions();
  const countsByKind = Object.fromEntries(MEMORY_KINDS.map(kind => [kind, 0])) as Record<MemoryKind, number>;
  for (const memory of effective) countsByKind[memory.kind] += 1;
  const latestOwnerRevisionAt = revisions
    .map(revision => revision.recorded_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    genesisMemoryCount: genesis.length,
    effectiveMemoryCount: effective.length,
    activeMemoryCount: effective.filter(memory => memory.status === 'active').length,
    inactiveMemoryCount: effective.filter(memory => memory.status === 'inactive').length,
    ownerCorrectedCount: effective.filter(memory => memory.owner_corrected).length,
    countsByKind,
    ownerRevisionCount: revisions.length,
    ...(latestOwnerRevisionAt ? { latestOwnerRevisionAt } : {}),
  };
}

export function queryEffectiveMemoryRows(
  owner: RelationshipMemoryOwnerControlPlane,
  query: EffectiveSearchQuery = {},
): EffectiveMemoryAdminRow[] {
  return owner.search(query).map(memory => ({
    memoryId: memory.memory_id,
    kind: memory.kind,
    summary: memory.summary,
    status: memory.status,
    ownerCorrected: memory.owner_corrected,
    ...(memory.latest_revision_id ? { latestRevisionId: memory.latest_revision_id } : {}),
    ...(memory.latest_revision_at ? { latestRevisionAt: memory.latest_revision_at } : {}),
    participants: [...memory.participants],
    ...(memory.linked_memory_ids ? { linkedMemoryIds: [...memory.linked_memory_ids] } : {}),
  }));
}

export class SubconsciousAdminReadModel {
  constructor(private readonly deps: SubconsciousAdminDependencies) {}

  queryMemories(query: EffectiveSearchQuery = {}): EffectiveMemoryAdminRow[] {
    return queryEffectiveMemoryRows(this.deps.owner, query);
  }

  async snapshot(options: SubconsciousAdminSnapshotOptions = {}): Promise<SubconsciousAdminSnapshot> {
    const relationshipMemory: AdminRelationshipMemorySection = {
      availability: 'available',
      summary: summarizeRelationshipMemory(this.deps.owner),
      rows: this.queryMemories(options.memoryQuery),
    };

    const [runtimeResult, recentRunsResult, cacheResult] = await Promise.allSettled([
      getAgentRuntimeOverview(this.deps.transport, this.deps.agentId, {
        now: this.deps.now,
        providerUsage: this.deps.providerUsage,
      }),
      listRecentRunSummaries(this.deps.transport, this.deps.agentId, options.recentRunLimit ?? 10),
      collectAgentPromptCacheEffectiveness(this.deps.transport, this.deps.agentId, options.cacheRunLimit ?? 10),
    ]);

    let runtime: AdminRuntimeSection;
    if (runtimeResult.status === 'fulfilled') {
      runtime = runtimeSection(runtimeResult.value);
    } else {
      const failed = sectionError(runtimeResult.reason);
      const observedAt = (this.deps.now?.() ?? new Date()).toISOString();
      runtime = {
        ...failed,
        overview: {
          agentId: this.deps.agentId,
          activity: failed.availability === 'unreachable' ? 'unreachable' : 'error',
          observedAt,
          activeRunIds: [],
          providerUsage: this.deps.providerUsage ?? unavailableProviderUsage(observedAt),
          error: failed.error ?? {
            kind: 'query_error',
            message: runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason),
          },
        },
      };
    }

    const recentRuns: AdminRecentRunsSection = recentRunsResult.status === 'fulfilled'
      ? { availability: 'available', items: recentRunsResult.value }
      : { ...sectionError(recentRunsResult.reason), items: [] };

    const lastRunPromptContext = cacheResult.status === 'fulfilled'
      ? summarizeLastRunPromptContext(cacheResult.value.runs, runtime.overview.lastRun?.id)
      : undefined;

    const promptCache: AdminPromptCacheSection = cacheResult.status === 'fulfilled'
      ? {
          availability: 'available',
          aggregate: cacheResult.value.aggregate,
          ...(lastRunPromptContext ? { lastRun: lastRunPromptContext } : {}),
          conversations: cacheResult.value.conversations.map(conversation => ({
            conversationId: conversation.conversationId,
            runIds: [...conversation.runIds],
            runs: cacheResult.value.runs
              .filter(run => run.conversationId === conversation.conversationId)
              .map(run => ({ runId: run.runId, aggregate: run.aggregate })),
            aggregate: conversation.aggregate,
          })),
        }
      : { ...sectionError(cacheResult.reason), conversations: [] };

    return {
      agentId: this.deps.agentId,
      runtime,
      recentRuns,
      promptCache,
      relationshipMemory,
    };
  }
}

export async function composeSubconsciousAdminSnapshot(
  dependencies: SubconsciousAdminDependencies,
  options: SubconsciousAdminSnapshotOptions = {},
): Promise<SubconsciousAdminSnapshot> {
  return new SubconsciousAdminReadModel(dependencies).snapshot(options);
}

export * from './http.js';
