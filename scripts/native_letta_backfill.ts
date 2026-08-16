import Letta from '@letta-ai/letta-client';
import { legacySourceCompleteToolSchema } from '../relationship-memory/src/legacy/semantic.js';
import { normalizeLettaBaseUrl } from './letta_api_url.js';

export const LEGACY_COMPLETION_TOOL_NAME = 'legacy_source_complete';
const MAX_CLIENT_TOOL_ROUNDS = 128;

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

const COMPLETION_TOOL_SOURCE = `def legacy_source_complete(result: str) -> str:\n    \"\"\"Mark one legacy semantic source complete. The caller validates local provenance after the terminal call.\"\"\"\n    if result not in (\"completed\", \"no_memory_required\"):\n        raise ValueError(\"result must be completed or no_memory_required\")\n    return result\n`;

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

export interface NativeClientToolRequest {
  name: string;
  arguments: unknown;
  toolCallId: string;
}

export interface ClientToolRoundGateContext {
  request: NativeClientToolRequest;
  round: number;
  completedBeforeRound: ReadonlySet<string>;
  batchRequests: readonly NativeClientToolRequest[];
}

export type ClientToolRoundGate = (context: ClientToolRoundGateContext) => string | undefined;

function normalizeToolCall(value: any): NativeClientToolRequest | null {
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

export function extractToolCalls(messages: readonly any[] = []): NativeClientToolRequest[] {
  const calls: NativeClientToolRequest[] = [];
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

export function extractLegacyCompletion(messages: readonly any[] = []): 'completed' | 'no_memory_required' | undefined {
  const completions = extractToolCalls(messages).filter((call) => call.name === LEGACY_COMPLETION_TOOL_NAME);
  if (completions.length === 0) return undefined;
  const values = completions.map((call) => {
    const args = parseToolArguments(call.arguments);
    return args?.result === 'no_memory_required' ? 'no_memory_required' : args?.result === 'completed' ? 'completed' : undefined;
  });
  if (values.some((value) => !value)) throw new Error('legacy_source_complete returned invalid arguments');
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error('legacy_source_complete returned conflicting terminal results');
  return unique[0];
}

function approvalRequests(messages: readonly any[] = []): NativeClientToolRequest[] {
  const result: NativeClientToolRequest[] = [];
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

export interface ContinuationBusyRetryPolicy {
  maxWaitMs: number;
  intervalMs?: number;
}

function isConversationBusyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b[\s\S]*Another request[\s\S]*currently being processed for this conversation/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createContinuationStream(
  create: () => Promise<AsyncIterable<any>>,
  policy?: ContinuationBusyRetryPolicy,
): Promise<AsyncIterable<any>> {
  if (!policy) return create();
  const maxWaitMs = Math.max(0, Math.round(policy.maxWaitMs));
  const intervalMs = Math.max(1, Math.round(policy.intervalMs ?? 100));
  const startedAt = Date.now();
  while (true) {
    try { return await create(); }
    catch (error) {
      if (!isConversationBusyConflict(error)) throw error;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= maxWaitMs) throw error;
      await delay(Math.min(intervalMs, Math.max(1, maxWaitMs - elapsed)));
    }
  }
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

export async function runNativeClientToolConversation(input: {
  client: NativeLettaClientLike;
  agentId: string;
  conversationId: string;
  message: string;
  tools: readonly NativeClientTool[];
  requiredClientToolNames?: readonly string[];
  continuationBusyRetry?: ContinuationBusyRetryPolicy;
  clientToolRoundGate?: ClientToolRoundGate;
}): Promise<{ response: any; clientToolFailure: boolean; terminal?: 'completed' | 'no_memory_required' }> {
  const schemas = clientToolSchemas(input.tools);
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const requiredClientToolNames = new Set(input.requiredClientToolNames ?? []);
  const completedRequiredClientTools = new Set<string>();
  const completedClientTools = new Set<string>();
  let clientToolFailure = false;
  let terminalSeen: 'completed' | 'no_memory_required' | undefined;
  let response = await collectLettaStream(await input.client.conversations.messages.create(input.conversationId, {
    agent_id: input.agentId,
    streaming: true,
    messages: [{ role: 'user', content: input.message }],
    client_tools: schemas,
  }));

  for (let round = 0; round < MAX_CLIENT_TOOL_ROUNDS; round += 1) {
    const stopReason = response?.stop_reason?.stop_reason ?? response?.stop_reason?.reason ?? response?.stop_reason;
    if (stopReason === 'error') {
      throw new Error('Letta native conversation terminated with stop_reason=error');
    }
    const messages = Array.isArray(response?.messages) ? response.messages : [];
    const terminal = extractLegacyCompletion(messages);
    if (terminal) {
      if (terminalSeen && terminalSeen !== terminal) {
        throw new Error('Letta returned conflicting legacy_source_complete results across approval rounds');
      }
      terminalSeen = terminal;
    }
    const requests = approvalRequests(messages);
    if (requests.length === 0) {
      const missingRequired = [...requiredClientToolNames].filter((name) => !completedRequiredClientTools.has(name));
      if (missingRequired.length > 0) {
        throw new Error(`Letta native conversation ended before required client tool completion: ${missingRequired.join(', ')}`);
      }
      return { response, clientToolFailure, terminal: terminalSeen };
    }

    const approvals: any[] = [];
    const completedBeforeRound = new Set(completedClientTools);
    for (const request of requests) {
      const tool = tools.get(request.name);
      if (!tool) throw new Error(`Letta requested unknown client tool: ${request.name}`);
      const deferReason = input.clientToolRoundGate?.({ request, round, completedBeforeRound, batchRequests: requests });
      if (deferReason) {
        approvals.push({
          type: 'tool',
          tool_call_id: request.toolCallId,
          tool_return: toolReturn({ status: 'deferred', reason: deferReason }),
          status: 'success',
        });
        continue;
      }
      let status: 'success' | 'error' = 'success';
      let result: string;
      try {
        result = toolReturn(await tool.execute(request.toolCallId, parseToolArguments(request.arguments)));
        completedClientTools.add(request.name);
        if (requiredClientToolNames.has(request.name)) completedRequiredClientTools.add(request.name);
      } catch (error) {
        status = 'error';
        clientToolFailure = true;
        result = error instanceof Error ? error.message : String(error);
      }
      approvals.push({ type: 'tool', tool_call_id: request.toolCallId, tool_return: result, status });
    }

    response = await collectLettaStream(await createContinuationStream(
      () => input.client.conversations.messages.create(input.conversationId, {
        agent_id: input.agentId,
        streaming: true,
        messages: [{ type: 'tool_return', tool_returns: approvals }],
        client_tools: schemas,
      }),
      input.continuationBusyRetry,
    ));
  }
  throw new Error(`native client-tool loop exceeded ${MAX_CLIENT_TOOL_ROUNDS} approval rounds`);
}
