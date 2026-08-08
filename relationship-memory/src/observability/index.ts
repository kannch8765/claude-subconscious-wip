import { buildLettaApiUrl, getLettaApiBase, type LettaApiQuery } from '../../../scripts/letta_api_url.js';

export type RuntimeActivity = 'running' | 'idle' | 'unreachable' | 'error';
export type ProviderUsageQuality = 'provider_reported' | 'locally_observed' | 'estimated' | 'unavailable';

export interface ProviderUsageSlot {
  quality: ProviderUsageQuality;
  source: string;
  observedAt: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ContextMetrics {
  currentTokens: number;
  maxTokens: number;
  utilizationRatio?: number;
  messageCount: number;
  archivalCount: number;
  recallCount: number;
  sectionTokens: Record<string, number>;
}

export interface AgentRuntimeOverview {
  agentId: string;
  agentName?: string;
  model?: string;
  modelHandle?: string;
  providerCategory?: string;
  configuredContextLimit?: number;
  activity: RuntimeActivity;
  observedAt: string;
  context?: ContextMetrics;
  activeRunIds: string[];
  lastRun?: { id?: string; status?: string; createdAt?: string; completedAt?: string; stopReason?: string };
  error?: { kind: 'unreachable' | 'query_error'; message: string };
  providerUsage: ProviderUsageSlot;
}

export interface ToolUseSummary {
  identifiers: string[];
  count?: number;
}

export interface RecentRunSummary {
  runId: string;
  conversationId?: string;
  status?: string;
  createdAt?: string;
  completedAt?: string;
  durationNs?: number;
  ttftNs?: number;
  stopReason?: string;
  usage: TokenUsage;
  stepCount?: number;
  tools: ToolUseSummary;
}

export interface StepTimelineItem {
  kind: 'step';
  order: number;
  stepId: string;
  runId?: string;
  model?: string;
  modelHandle?: string;
  providerCategory?: string;
  contextWindowLimit?: number;
  status?: string;
  stopReason?: string;
  usage: TokenUsage;
  errorType?: string;
}

export interface ToolTimelineItem {
  kind: 'tool';
  order: number;
  stepId: string;
  runId?: string;
  toolName?: string;
  toolCallId: string;
  returnStatus?: 'success' | 'error';
  detailAvailable: boolean;
}

export type RunTimelineItem = StepTimelineItem | ToolTimelineItem;

export interface LettaReadTransport {
  getJson<T = unknown>(path: string, query?: LettaApiQuery): Promise<T>;
}

export class LettaReadError extends Error {
  constructor(public readonly kind: 'unreachable' | 'http', message: string, public readonly status?: number) {
    super(message);
    this.name = 'LettaReadError';
  }
}

export class FetchLettaReadTransport implements LettaReadTransport {
  private readonly apiBase: string;
  constructor(private readonly apiKey?: string, baseUrl?: string) {
    this.apiBase = getLettaApiBase(baseUrl);
  }

  async getJson<T>(path: string, query: LettaApiQuery = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(buildLettaApiUrl(path, query, this.apiBase), {
        method: 'GET',
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
    } catch (error) {
      throw new LettaReadError('unreachable', error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw new LettaReadError('http', `Letta GET ${path} failed (${response.status})`, response.status);
    return response.json() as Promise<T>;
  }
}

const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
const maybeNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const maybeString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

export function unavailableProviderUsage(observedAt = new Date().toISOString(), source = 'provider adapter not configured'): ProviderUsageSlot {
  return { quality: 'unavailable', source, observedAt };
}

export function mapContextMetrics(raw: unknown): ContextMetrics {
  const c = asRecord(raw);
  const currentTokens = maybeNumber(c.context_window_size_current) ?? 0;
  const maxTokens = maybeNumber(c.context_window_size_max) ?? 0;
  const sectionKeys: Array<[string, string]> = [
    ['system', 'num_tokens_system'],
    ['coreMemory', 'num_tokens_core_memory'],
    ['memoryFilesystem', 'num_tokens_memory_filesystem'],
    ['toolUsageRules', 'num_tokens_tool_usage_rules'],
    ['directories', 'num_tokens_directories'],
    ['summaryMemory', 'num_tokens_summary_memory'],
    ['functions', 'num_tokens_functions_definitions'],
    ['messages', 'num_tokens_messages'],
    ['externalMemorySummary', 'num_tokens_external_memory_summary'],
  ];
  const sectionTokens: Record<string, number> = {};
  for (const [name, key] of sectionKeys) {
    const value = maybeNumber(c[key]);
    if (value !== undefined) sectionTokens[name] = value;
  }
  return {
    currentTokens,
    maxTokens,
    utilizationRatio: maxTokens > 0 ? currentTokens / maxTokens : undefined,
    messageCount: maybeNumber(c.num_messages) ?? 0,
    archivalCount: maybeNumber(c.num_archival_memory) ?? 0,
    recallCount: maybeNumber(c.num_recall_memory) ?? 0,
    sectionTokens,
  };
}

export function mapUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  const promptDetails = asRecord(u.prompt_tokens_details);
  const completionDetails = asRecord(u.completion_tokens_details);
  return compactUsage({
    promptTokens: maybeNumber(u.prompt_tokens),
    completionTokens: maybeNumber(u.completion_tokens),
    totalTokens: maybeNumber(u.total_tokens),
    cachedInputTokens: maybeNumber(u.cached_input_tokens) ?? maybeNumber(promptDetails.cached_tokens) ?? maybeNumber(promptDetails.cache_read_tokens),
    cacheWriteTokens: maybeNumber(u.cache_write_tokens) ?? maybeNumber(promptDetails.cache_creation_tokens),
    reasoningTokens: maybeNumber(u.reasoning_tokens) ?? maybeNumber(completionDetails.reasoning_tokens),
  });
}

function compactUsage(usage: TokenUsage): TokenUsage {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as TokenUsage;
}

function modelFields(agent: Record<string, any>) {
  const llm = asRecord(agent.llm_config);
  return {
    model: maybeString(llm.model) ?? maybeString(agent.model),
    modelHandle: maybeString(llm.handle) ?? maybeString(agent.model),
    providerCategory: maybeString(llm.provider_category) ?? maybeString(llm.model_endpoint_type),
    configuredContextLimit: maybeNumber(llm.context_window),
  };
}

export async function getAgentRuntimeOverview(
  transport: LettaReadTransport,
  agentId: string,
  options: { now?: () => Date; providerUsage?: ProviderUsageSlot } = {},
): Promise<AgentRuntimeOverview> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const base: AgentRuntimeOverview = {
    agentId,
    activity: 'error',
    observedAt,
    activeRunIds: [],
    providerUsage: options.providerUsage ?? unavailableProviderUsage(observedAt),
  };
  try {
    const agent = asRecord(await transport.getJson(`/agents/${agentId}`));
    const [contextRaw, activeRaw, recentRaw] = await Promise.all([
      transport.getJson(`/agents/${agentId}/context`),
      transport.getJson('/runs/active'),
      transport.getJson('/runs/', { agent_id: agentId, limit: 1 }),
    ]);
    const activeRuns = Array.isArray(activeRaw) ? activeRaw.map(asRecord).filter(run => run.agent_id === agentId) : [];
    const recent = Array.isArray(recentRaw) && recentRaw.length ? asRecord(recentRaw[0]) : undefined;
    return {
      ...base,
      ...modelFields(agent),
      agentName: maybeString(agent.name),
      activity: activeRuns.length ? 'running' : 'idle',
      context: mapContextMetrics(contextRaw),
      activeRunIds: activeRuns.map(run => maybeString(run.id)).filter((id): id is string => Boolean(id)),
      lastRun: recent ? {
        id: maybeString(recent.id), status: maybeString(recent.status), createdAt: maybeString(recent.created_at),
        completedAt: maybeString(recent.completed_at), stopReason: maybeString(recent.stop_reason),
      } : undefined,
    };
  } catch (error) {
    const unreachable = error instanceof LettaReadError && error.kind === 'unreachable';
    return { ...base, activity: unreachable ? 'unreachable' : 'error', error: { kind: unreachable ? 'unreachable' : 'query_error', message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function listRecentRunSummaries(transport: LettaReadTransport, agentId: string, limit = 10): Promise<RecentRunSummary[]> {
  const runsRaw = await transport.getJson('/runs/', { agent_id: agentId, limit });
  const runs = Array.isArray(runsRaw) ? runsRaw.map(asRecord).filter(run => run.agent_id === agentId) : [];
  return Promise.all(runs.slice(0, limit).map(async run => {
    const runId = maybeString(run.id);
    if (!runId) throw new Error('Letta run is missing id');
    const [usageRaw, metricsRaw] = await Promise.all([
      transport.getJson(`/runs/${runId}/usage`),
      transport.getJson(`/runs/${runId}/metrics`),
    ]);
    const metrics = asRecord(metricsRaw);
    const tools = Array.isArray(metrics.tools_used) ? metrics.tools_used.filter((v): v is string => typeof v === 'string') : [];
    return {
      runId,
      conversationId: maybeString(run.conversation_id), status: maybeString(run.status), createdAt: maybeString(run.created_at), completedAt: maybeString(run.completed_at),
      durationNs: maybeNumber(run.total_duration_ns) ?? maybeNumber(metrics.run_ns), ttftNs: maybeNumber(run.ttft_ns), stopReason: maybeString(run.stop_reason),
      usage: mapUsage(usageRaw), stepCount: maybeNumber(metrics.num_steps), tools: { identifiers: tools, count: tools.length },
    };
  }));
}

function extractToolCalls(message: Record<string, any>): Array<Record<string, any>> {
  if (Array.isArray(message.tool_calls)) return message.tool_calls.map(asRecord);
  return message.tool_call ? [asRecord(message.tool_call)] : [];
}
function extractToolReturns(message: Record<string, any>): Array<Record<string, any>> {
  if (Array.isArray(message.tool_returns)) return message.tool_returns.map(asRecord);
  if (message.tool_call_id) return [{ tool_call_id: message.tool_call_id, status: message.status }];
  return [];
}

export async function getRunTimeline(transport: LettaReadTransport, runId: string): Promise<RunTimelineItem[]> {
  const stepsRaw = await transport.getJson(`/runs/${runId}/steps`);
  const steps = Array.isArray(stepsRaw) ? stepsRaw.map(asRecord) : [];
  const timeline: RunTimelineItem[] = [];
  let order = 0;
  for (const step of steps) {
    const stepId = maybeString(step.id);
    if (!stepId) continue;
    timeline.push({
      kind: 'step', order: order++, stepId, runId: maybeString(step.run_id) ?? runId,
      model: maybeString(step.model), modelHandle: maybeString(step.model_handle), providerCategory: maybeString(step.provider_category),
      contextWindowLimit: maybeNumber(step.context_window_limit), status: maybeString(step.status), stopReason: maybeString(step.stop_reason),
      usage: mapUsage(step), errorType: maybeString(step.error_type),
    });
    const messagesRaw = await transport.getJson(`/steps/${stepId}/messages`);
    const messages = Array.isArray(messagesRaw) ? messagesRaw.map(asRecord) : [];
    const toolById = new Map<string, ToolTimelineItem>();
    for (const message of messages) {
      if (message.message_type === 'tool_call_message') {
        for (const call of extractToolCalls(message)) {
          const id = maybeString(call.tool_call_id);
          if (!id) continue;
          const item: ToolTimelineItem = { kind: 'tool', order: order++, stepId, runId: maybeString(message.run_id) ?? runId, toolName: maybeString(call.name), toolCallId: id, detailAvailable: typeof call.arguments === 'string' && call.arguments.length > 0 };
          toolById.set(id, item); timeline.push(item);
        }
      } else if (message.message_type === 'tool_return_message') {
        for (const ret of extractToolReturns(message)) {
          const id = maybeString(ret.tool_call_id);
          if (!id) continue;
          const existing = toolById.get(id);
          const status = ret.status === 'success' || ret.status === 'error' ? ret.status : undefined;
          if (existing) { existing.returnStatus = status; existing.detailAvailable = true; }
          else { const item: ToolTimelineItem = { kind: 'tool', order: order++, stepId, runId: maybeString(message.run_id) ?? runId, toolCallId: id, returnStatus: status, detailAvailable: true }; toolById.set(id, item); timeline.push(item); }
        }
      }
    }
  }
  return timeline;
}
