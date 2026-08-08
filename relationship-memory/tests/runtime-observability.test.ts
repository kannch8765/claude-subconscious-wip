import { describe, expect, it } from 'vitest';
import {
  LettaReadError, getAgentRuntimeOverview, getRunTimeline, listRecentRunSummaries, mapContextMetrics, mapUsage, unavailableProviderUsage,
  type LettaReadTransport,
} from '../src/observability/index.js';

class FixtureTransport implements LettaReadTransport {
  calls: string[] = [];
  constructor(private readonly fixtures: Record<string, unknown | Error>) {}
  async getJson<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(`${path}?${new URLSearchParams(Object.entries(query).map(([k,v]) => [k,String(v)])).toString()}`);
    const value = this.fixtures[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`missing fixture ${path}`);
    return value as T;
  }
}

const agent = { id: 'agent-a', name: 'Subconscious', model: 'opencode-deepseek/deepseek-v4-flash', llm_config: { model: 'deepseek-v4-flash', handle: 'opencode-deepseek/deepseek-v4-flash', provider_category: 'byok', context_window: 128000, system: 'must not leak' } };
const context = { context_window_size_max: 128000, context_window_size_current: 32000, num_messages: 12, num_archival_memory: 4, num_recall_memory: 9, num_tokens_system: 1000, num_tokens_core_memory: 2000, num_tokens_memory_filesystem: 300, num_tokens_tool_usage_rules: 400, num_tokens_directories: 50, num_tokens_summary_memory: 600, num_tokens_functions_definitions: 700, num_tokens_messages: 8000, num_tokens_external_memory_summary: 90, system_prompt: 'SECRET SYSTEM', core_memory: 'SECRET CORE', messages: [{content:'SECRET MESSAGE'}], reasoning: 'SECRET REASONING' };

function overviewFixtures(active: unknown[] = []) { return { '/agents/agent-a': agent, '/agents/agent-a/context': context, '/runs/active': active, '/runs/': [{ id:'run-last', agent_id:'agent-a', status:'completed', stop_reason:'end_turn', created_at:'2026-08-08T12:00:00Z', completed_at:'2026-08-08T12:00:02Z' }] }; }

describe('runtime observability abstraction', () => {
  it('maps reachable agent with no active run to idle, metadata-first', async () => {
    const transport = new FixtureTransport(overviewFixtures());
    const result = await getAgentRuntimeOverview(transport, 'agent-a', { now: () => new Date('2026-08-08T13:00:00Z') });
    expect(result.activity).toBe('idle');
    expect(result.context?.utilizationRatio).toBe(0.25);
    expect(result.context?.sectionTokens).toMatchObject({ system:1000, coreMemory:2000, messages:8000 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(transport.calls.every(call => !/POST|PATCH|PUT|DELETE/.test(call))).toBe(true);
  });

  it('maps an active run for selected agent to running', async () => {
    const transport = new FixtureTransport(overviewFixtures([{id:'run-active',agent_id:'agent-a'},{id:'other',agent_id:'agent-b'}]));
    const result = await getAgentRuntimeOverview(transport, 'agent-a');
    expect(result.activity).toBe('running');
    expect(result.activeRunIds).toEqual(['run-active']);
  });

  it('maps context numeric metadata without payload content', () => {
    const mapped = mapContextMetrics(context);
    expect(mapped).toEqual(expect.objectContaining({ currentTokens:32000, maxTokens:128000, messageCount:12, archivalCount:4, recallCount:9 }));
    expect(mapped.sectionTokens.externalMemorySummary).toBe(90);
    expect(JSON.stringify(mapped)).not.toContain('SECRET');
  });

  it('preserves missing usage fields instead of fabricating zero', () => {
    expect(mapUsage({ prompt_tokens:10, completion_tokens:4, total_tokens:14, prompt_tokens_details:{cached_tokens:6}, completion_tokens_details:{reasoning_tokens:2} })).toEqual({ promptTokens:10, completionTokens:4, totalTokens:14, cachedInputTokens:6, reasoningTokens:2 });
    expect(mapUsage({ prompt_tokens:10 })).toEqual({ promptTokens:10 });
  });

  it('maps recent run stop reasons, metrics, and exact usage', async () => {
    const transport = new FixtureTransport({ '/runs/': [
      { id:'r1',agent_id:'agent-a',conversation_id:'c1',status:'completed',stop_reason:'end_turn',ttft_ns:11,total_duration_ns:22 },
      { id:'r2',agent_id:'agent-a',status:'failed',stop_reason:'requires_approval' },
    ], '/runs/r1/usage':{prompt_tokens:8,completion_tokens:2,total_tokens:10,prompt_tokens_details:{cache_read_tokens:3},completion_tokens_details:{reasoning_tokens:1}}, '/runs/r1/metrics':{id:'r1',num_steps:2,tools_used:['Read']}, '/runs/r2/usage':{}, '/runs/r2/metrics':{id:'r2',num_steps:1,tools_used:[]} });
    const runs = await listRecentRunSummaries(transport,'agent-a',2);
    expect(runs[0]).toMatchObject({runId:'r1',stopReason:'end_turn',stepCount:2,tools:{identifiers:['Read'],count:1},usage:{promptTokens:8,completionTokens:2,totalTokens:10,cachedInputTokens:3,reasoningTokens:1}});
    expect(runs[1].stopReason).toBe('requires_approval');
    expect(runs[1].usage).toEqual({});
  });

  it('builds ordered compact step/tool timeline without raw args/returns', async () => {
    const transport = new FixtureTransport({ '/runs/r1/steps': [
      {id:'s1',run_id:'r1',model:'deepseek-v4-flash',model_handle:'opencode-deepseek/deepseek-v4-flash',status:'success',stop_reason:'end_turn',prompt_tokens:10,completion_tokens:2,total_tokens:12,cached_input_tokens:5,reasoning_tokens:1},
      {id:'s2',run_id:'r1',status:'failed',stop_reason:'requires_approval',error_type:'approval_required'},
    ], '/steps/s1/messages': [
      {message_type:'tool_call_message',run_id:'r1',tool_calls:[{name:'Read',arguments:'{"file":"SECRET"}',tool_call_id:'tc1'}]},
      {message_type:'tool_return_message',run_id:'r1',tool_returns:[{tool_call_id:'tc1',status:'success',tool_return:'SECRET OUTPUT'}]},
    ], '/steps/s2/messages': [
      {message_type:'tool_call_message',tool_call:{name:'write_memory',arguments:'{"secret":true}',tool_call_id:'tc2'}},
      {message_type:'tool_return_message',tool_call_id:'tc2',status:'error',tool_return:'SECRET ERROR'},
    ] });
    const timeline = await getRunTimeline(transport,'r1');
    expect(timeline.map(x => x.kind === 'step' ? `step:${x.stepId}:${x.stopReason}` : `tool:${x.toolCallId}:${x.returnStatus}`)).toEqual(['step:s1:end_turn','tool:tc1:success','step:s2:requires_approval','tool:tc2:error']);
    expect(JSON.stringify(timeline)).not.toContain('SECRET');
  });

  it('reports transport failure explicitly as unreachable', async () => {
    const transport = new FixtureTransport({ '/agents/agent-a': new LettaReadError('unreachable','connection refused') });
    const result = await getAgentRuntimeOverview(transport,'agent-a');
    expect(result.activity).toBe('unreachable');
    expect(result.error?.kind).toBe('unreachable');
  });

  it('reports reachable query failures as error, not healthy-empty', async () => {
    const transport = new FixtureTransport({ '/agents/agent-a': new LettaReadError('http','404',404) });
    const result = await getAgentRuntimeOverview(transport,'agent-a');
    expect(result.activity).toBe('error');
    expect(result.context).toBeUndefined();
  });

  it('provider usage unavailable carries provenance and no exact-zero balance', () => {
    const usage = unavailableProviderUsage('2026-08-08T13:00:00Z','OpenCode Console adapter not configured');
    expect(usage).toEqual({quality:'unavailable',source:'OpenCode Console adapter not configured',observedAt:'2026-08-08T13:00:00Z'});
    expect(usage.remaining).toBeUndefined();
    expect(usage.limit).toBeUndefined();
  });
});
