import Letta from '@letta-ai/letta-client';
import { legacySourceCompleteToolSchema } from '../relationship-memory/src/legacy/semantic.js';
import { normalizeLettaBaseUrl } from './letta_api_url.js';

export const LEGACY_COMPLETION_TOOL_NAME = 'legacy_source_complete';
const MAX_CLIENT_TOOL_ROUNDS = 128;
const MAX_ACTIVE_RUN_CONFLICT_RECOVERIES = 3;
const ACTIVE_RUN_WAIT_TIMEOUT_MS = 120_000;
const ACTIVE_RUN_POLL_INTERVAL_MS = 1_000;

export interface NativeClientTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, args: unknown): Promise<unknown>;
}

export interface NativeLettaClientLike {
  agents: {
    retrieve(agentId: string): Promise<any>;
    update(agentId: string, body: Record<string, unknown>): Promise<any>;
    tools: {
      attach(toolId: string, params: { agent_id: string }): Promise<any>;
    };
  };
  tools: {
    upsert(body: Record<string, unknown>): Promise<any>;
  };
  conversations: {
    messages: {
      create(conversationId: string, body: Record<string, unknown>): Promise<AsyncIterable<any>>;
    };
  };
  runs: {
    retrieve(runId: string): Promise<any>;
  };
}

export function createNativeLettaClient(apiKey: string): NativeLettaClientLike {
  const configured = normalizeLettaBaseUrl();
  const baseURL = configured.endsWith('/v1') ? configured.slice(0, -3) : configured;
  return new Letta({ apiKey, baseURL }) as unknown as NativeLettaClientLike;
}

export function reconcileLegacyCompletionRules(existing: readonly any[] = []): any[] {
  const preserved = existing.filter((rule) => !(
    rule?.tool_name === LEGACY_COMPLETION_TOOL_NAME
    && (rule?.type === 'required_before_exit' || rule?.type === 'exit_loop')
  ));
  return [
    ...preserved,
    { type: 'required_before_exit', tool_name: LEGACY_COMPLETION_TOOL_NAME },
    { type: 'exit_loop', tool_name: LEGACY_COMPLETION_TOOL_NAME },
  ];
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

const COMPLETION_TOOL_SOURCE = `def legacy_source_complete(result) -> str:\n    \"\"\"Mark one legacy semantic source complete. The caller validates local provenance after the terminal call.\"\"\"\n    normalized = getattr(result, \"value\", result)\n    if normalized not in (\"completed\", \"no_memory_required\"):\n        raise ValueError(\"result must be completed or no_memory_required\")\n    return normalized\n`;

export async function ensureLegacyCompletionTool(
  client: NativeLettaClientLike,
  agentId: string,
): Promise<{ toolId: string; rulesChanged: boolean; attached: boolean }> {
  const tool = await client.tools.upsert({
    source_code: COMPLETION_TOOL_SOURCE,
    args_json_schema: legacySourceCompleteToolSchema(),
    default_requires_approval: false,
    description: 'Terminal marker for one immutable legacy semantic source. Canonical provenance validation remains backend-owned.',
    enable_parallel_execution: false,
    tags: ['purpose:relationship-memory-backfill', 'semantics:legacy-source-terminal'],
  });
  if (!tool?.id) throw new Error('Letta did not return an id for legacy_source_complete');

  let agent = await client.agents.retrieve(agentId);
  const tools = Array.isArray(agent?.tools) ? agent.tools : [];
  const attached = tools.some((item: any) => item?.id === tool.id);
  if (!attached) {
    await client.agents.tools.attach(tool.id, { agent_id: agentId });
    agent = await client.agents.retrieve(agentId);
  }

  const currentRules = Array.isArray(agent?.tool_rules) ? agent.tool_rules : [];
  const nextRules = reconcileLegacyCompletionRules(currentRules);
  const rulesChanged = stable(currentRules) !== stable(nextRules);
  if (rulesChanged) await client.agents.update(agentId, { tool_rules: nextRules });
  return { toolId: tool.id, rulesChanged, attached: !attached };
}

interface ToolCall {
  name: string;
  arguments: unknown;
  toolCallId: string;
}

function normalizeToolCall(value: any): ToolCall | null {
  if (!value) return null;
  const fn = value.function ?? value;
  const name = typeof fn?.name === 'string' ? fn.name : typeof value?.name === 'string' ? value.name : '';
  const toolCallId = typeof value?.tool_call_id === 'string'
    ? value.tool_call_id
    : typeof value?.id === 'string'
      ? value.id
      : typeof fn?.tool_call_id === 'string'
        ? fn.tool_call_id
        : '';
  if (!name) return null;
  return { name, arguments: fn?.arguments ?? value?.arguments ?? {}, toolCallId };
}

export function extractToolCalls(messages: readonly any[] = []): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    if (message?.tool_call) {
      const call = normalizeToolCall(message.tool_call);
      if (call) calls.push(call);
    }
    if (Array.isArray(message?.tool_calls)) {
      for (const raw of message.tool_calls) {
        const call = normalizeToolCall(raw);
        if (call) calls.push(call);
      }
    }
  }
  return calls;
}

function toolReturns(messages: readonly any[] = []): Array<{ toolCallId: string; status: 'success' | 'error' }> {
  const returns: Array<{ toolCallId: string; status: 'success' | 'error' }> = [];
  for (const message of messages) {
    const nested = Array.isArray(message?.tool_returns) ? message.tool_returns : [];
    for (const item of nested) {
      if (typeof item?.tool_call_id !== 'string') continue;
      if (item?.status !== 'success' && item?.status !== 'error') continue;
      returns.push({ toolCallId: item.tool_call_id, status: item.status });
    }
    if (typeof message?.tool_call_id === 'string' && (message?.status === 'success' || message?.status === 'error')) {
      returns.push({ toolCallId: message.tool_call_id, status: message.status });
    }
  }
  return returns;
}

function legacyCompletionCalls(messages: readonly any[] = []): Array<{ toolCallId: string; result: 'completed' | 'no_memory_required' }> {
  const completionCalls = extractToolCalls(messages).filter((call) => call.name === LEGACY_COMPLETION_TOOL_NAME);
  return completionCalls.map((call) => {
    const args = parseToolArguments(call.arguments);
    const result = args?.result === 'no_memory_required' ? 'no_memory_required' : args?.result === 'completed' ? 'completed' : undefined;
    if (!result) throw new Error('legacy_source_complete returned invalid arguments');
    if (!call.toolCallId) throw new Error('legacy_source_complete is missing tool_call_id');
    return { toolCallId: call.toolCallId, result };
  });
}

export function extractLegacyCompletion(messages: readonly any[] = []): 'completed' | 'no_memory_required' | undefined {
  const calls = legacyCompletionCalls(messages);
  if (calls.length === 0) return undefined;
  const returns = toolReturns(messages);
  const successful = calls.filter((call) => returns.some((item) => item.toolCallId === call.toolCallId && item.status === 'success'));
  if (successful.length === 0) return undefined;
  const unique = [...new Set(successful.map((call) => call.result))];
  if (unique.length !== 1) throw new Error('legacy_source_complete returned conflicting terminal results');
  return unique[0];
}

function approvalRequests(messages: readonly any[] = []): ToolCall[] {
  const result: ToolCall[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message?.message_type !== 'approval_request_message' && message?.type !== 'approval_request_message') continue;
    const rawCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : message?.tool_call
        ? [message.tool_call]
        : [];
    for (const raw of rawCalls) {
      const call = normalizeToolCall(raw);
      if (!call?.toolCallId) throw new Error('Letta approval request is missing tool_call_id');
      if (seen.has(call.toolCallId)) continue;
      seen.add(call.toolCallId);
      result.push(call);
    }
  }
  return result;
}

export function parseToolArguments(value: unknown): any {
  if (typeof value === 'string') {
    try { return JSON.parse(value || '{}'); }
    catch { throw new Error('Letta client tool arguments are not valid JSON'); }
  }
  return value && typeof value === 'object' ? value : {};
}

function clientToolSchemas(tools: readonly NativeClientTool[]): Array<Record<string, unknown>> {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function toolReturn(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

async function collectLettaStream(stream: AsyncIterable<any>): Promise<{ messages: any[]; stop_reason?: any; usage?: any }> {
  const messages: any[] = [];
  let stopReason: any;
  let usage: any;
  for await (const event of stream) {
    const type = event?.message_type ?? event?.type;
    if (type === 'ping') continue;
    if (type === 'stop_reason') {
      stopReason = event;
      continue;
    }
    if (type === 'usage_statistics') {
      usage = event;
      continue;
    }
    if (type === 'error' || (typeof event?.error_type === 'string' && typeof event?.message === 'string')) {
      throw new Error(`Letta stream error${event?.error_type ? ` (${event.error_type})` : ''}: ${event?.message ?? 'unknown error'}`);
    }
    messages.push(event);
  }
  return { messages, stop_reason: stopReason, usage };
}


export function extractActiveConversationRunConflict(error: unknown): { runId: string } | undefined {
  const candidate = error as any;
  if (candidate?.status !== 409) return undefined;
  const body = candidate?.error && typeof candidate.error === 'object' ? candidate.error : undefined;
  const runId = typeof body?.run_id === 'string' ? body.run_id : undefined;
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  if (!runId?.startsWith('run-')) return undefined;
  if (!detail.includes('Cannot send a new message') || !detail.includes('currently being processed for this conversation')) return undefined;
  return { runId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForActiveConversationRun(
  client: NativeLettaClientLike,
  runId: string,
  conversationId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<any> {
  const timeoutMs = options.timeoutMs ?? ACTIVE_RUN_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVE_RUN_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const run = await client.runs.retrieve(runId);
    if (run?.conversation_id && run.conversation_id !== conversationId) {
      throw new Error(`Letta 409 referenced run ${runId} from a different conversation`);
    }
    if (run?.status === 'completed') {
      if (run?.stop_reason !== 'requires_approval') {
        throw new Error(`Letta conflicting run ${runId} completed with unexpected stop_reason=${String(run?.stop_reason)}`);
      }
      return run;
    }
    if (run?.status === 'failed' || run?.status === 'cancelled') {
      throw new Error(`Letta conflicting run ${runId} ended with status=${run.status}`);
    }
    if (run?.status !== 'created' && run?.status !== 'running') {
      throw new Error(`Letta conflicting run ${runId} returned unexpected status=${String(run?.status)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Letta conflicting run ${runId} to finish`);
    }
    await sleep(pollIntervalMs);
  }
}

async function createContinuationWithRunConflictRecovery(
  client: NativeLettaClientLike,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<AsyncIterable<any>> {
  for (let recovery = 0; ; recovery += 1) {
    try {
      return await client.conversations.messages.create(conversationId, body);
    } catch (error) {
      const conflict = extractActiveConversationRunConflict(error);
      if (!conflict || recovery >= MAX_ACTIVE_RUN_CONFLICT_RECOVERIES) throw error;
      await waitForActiveConversationRun(client, conflict.runId, conversationId);
    }
  }
}

export async function runNativeClientToolConversation(input: {
  client: NativeLettaClientLike;
  agentId: string;
  conversationId: string;
  message: string;
  tools: readonly NativeClientTool[];
}): Promise<{ response: any; clientToolFailure: boolean; terminal?: 'completed' | 'no_memory_required' }> {
  const schemas = clientToolSchemas(input.tools);
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  let hardClientToolFailure = false;
  const unresolvedParseFailures = new Map<string, number>();
  const pendingTerminalCalls = new Map<string, 'completed' | 'no_memory_required'>();
  let terminalSeen: 'completed' | 'no_memory_required' | undefined;
  let response = await collectLettaStream(await input.client.conversations.messages.create(input.conversationId, {
    agent_id: input.agentId,
    streaming: true,
    messages: [{ role: 'user', content: input.message }],
    client_tools: schemas,
  }));

  for (let round = 0; round < MAX_CLIENT_TOOL_ROUNDS; round += 1) {
    const messages = Array.isArray(response?.messages) ? response.messages : [];
    for (const call of legacyCompletionCalls(messages)) pendingTerminalCalls.set(call.toolCallId, call.result);
    for (const returned of toolReturns(messages)) {
      const terminal = pendingTerminalCalls.get(returned.toolCallId);
      if (!terminal) continue;
      pendingTerminalCalls.delete(returned.toolCallId);
      if (returned.status !== 'success') continue;
      if (terminalSeen && terminalSeen !== terminal) {
        throw new Error('Letta returned conflicting legacy_source_complete results across approval rounds');
      }
      terminalSeen = terminal;
    }
    const requests = approvalRequests(messages);
    if (requests.length === 0) {
      const unresolvedParseFailure = [...unresolvedParseFailures.values()].some((count) => count > 0);
      return { response, clientToolFailure: hardClientToolFailure || unresolvedParseFailure, terminal: terminalSeen };
    }

    const approvals: any[] = [];
    const successesThisRound = new Map<string, number>();
    const parseFailuresThisRound = new Map<string, number>();
    for (const request of requests) {
      const tool = tools.get(request.name);
      if (!tool) throw new Error(`Letta requested unknown legacy client tool: ${request.name}`);
      let status: 'success' | 'error' = 'success';
      let result: string;
      let args: any;
      try {
        args = parseToolArguments(request.arguments);
      } catch (error) {
        status = 'error';
        parseFailuresThisRound.set(request.name, (parseFailuresThisRound.get(request.name) ?? 0) + 1);
        result = error instanceof Error ? error.message : String(error);
        approvals.push({ type: 'tool', tool_call_id: request.toolCallId, tool_return: result, status });
        continue;
      }
      try {
        result = toolReturn(await tool.execute(request.toolCallId, args));
        successesThisRound.set(request.name, (successesThisRound.get(request.name) ?? 0) + 1);
      } catch (error) {
        status = 'error';
        hardClientToolFailure = true;
        result = error instanceof Error ? error.message : String(error);
      }
      approvals.push({ type: 'tool', tool_call_id: request.toolCallId, tool_return: result, status });
    }
    for (const [name, successes] of successesThisRound) {
      const unresolved = unresolvedParseFailures.get(name) ?? 0;
      if (unresolved > 0) unresolvedParseFailures.set(name, Math.max(0, unresolved - successes));
    }
    for (const [name, failures] of parseFailuresThisRound) {
      unresolvedParseFailures.set(name, (unresolvedParseFailures.get(name) ?? 0) + failures);
    }

    response = await collectLettaStream(await createContinuationWithRunConflictRecovery(input.client, input.conversationId, {
      agent_id: input.agentId,
      streaming: true,
      messages: [{ type: 'tool_return', tool_returns: approvals }],
      client_tools: schemas,
    }));
  }
  throw new Error(`legacy client-tool loop exceeded ${MAX_CLIENT_TOOL_ROUNDS} approval rounds`);
}
