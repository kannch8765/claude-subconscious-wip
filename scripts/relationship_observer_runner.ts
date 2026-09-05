import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import {
  appendTrustedRelationshipCatalog,
  buildRelationshipTools,
  createRuntime,
  isRelationshipMutationClientTool,
  relationshipMemoryRoot,
} from '../relationship-memory/src/adapter/index.js';
import { rebuildProjection } from '../relationship-memory/src/projection/index.js';
import { stableJson } from '../relationship-memory/src/store/index.js';
import { buildLettaApiUrl } from './letta_api_url.js';
import {
  createNativeLettaClient,
  runNativeClientToolConversation,
  type NativeLettaClientLike,
} from './native_letta_backfill.js';

export interface RelationshipObserverBatchInput {
  agentId: string;
  conversationId: string;
  message: string;
  cwd: string;
  batchId: string;
  canonicalMessages: CanonicalMessage[];
  assistantIntents?: AssistantRememberIntentRecord[];
  rootDir?: string;
  subjectId?: string;
  client?: NativeLettaClientLike;
  log?: (message: string) => void;
}

async function syncProjectionBlocks(apiKey: string, agentId: string, runtime: ReturnType<typeof createRuntime>): Promise<void> {
  const projection = rebuildProjection(runtime.store);
  for (const [label, value] of Object.entries(projection.blocks)) {
    const response = await fetch(buildLettaApiUrl(`/agents/${agentId}/core-memory/blocks/${label}`), {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!response.ok) throw new Error(`Projection sync failed for ${label} (${response.status})`);
  }
}

function assertNativeRelationshipAgentBoundary(agent: any): void {
  const serverTools = Array.isArray(agent?.tools) ? agent.tools : [];
  if (serverTools.length === 0) return;
  const names = serverTools.map((tool: any) => tool?.name ?? tool?.id ?? 'unknown').join(', ');
  throw new Error(`Relationship observer agent has unexpected server tools attached: ${names}`);
}

export async function runRelationshipObserverBatch(input: RelationshipObserverBatchInput): Promise<'completed' | 'retryable_failure'> {
  const log = input.log ?? (() => {});
  const subjectId = input.subjectId ?? process.env.RELATIONSHIP_MEMORY_SUBJECT_ID ?? 'local-user';
  const assistantIntents = input.assistantIntents ?? [];
  const runtime = createRuntime(input.canonicalMessages, subjectId, input.rootDir ?? relationshipMemoryRoot(), assistantIntents);

  const latest = [...runtime.store.listBatches()].reverse().find((item) => item.batch_id === input.batchId);
  if (latest?.status === 'completed') {
    log(`Relationship-memory batch already durably completed: ${input.batchId}`);
    return 'completed';
  }

  runtime.store.beginBatch(input.batchId, new Date().toISOString());
  let sessionSucceeded = true;

  try {
    const apiKey = process.env.LETTA_API_KEY;
    if (!input.client && !apiKey) throw new Error('LETTA_API_KEY is required for native Letta relationship observer');
    const client = input.client ?? createNativeLettaClient(apiKey!);
    const agent = await client.agents.retrieve(input.agentId);
    assertNativeRelationshipAgentBoundary(agent);

    const relationshipTools = buildRelationshipTools(runtime, input.batchId).map((tool) => {
      if (!isRelationshipMutationClientTool(tool.name)) return tool;
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        async execute(toolCallId: string, args: unknown) {
          return runtime.store.withMutationBoundary(() => execute(toolCallId, args));
        },
      };
    });

    const durableAssistantIntents = assistantIntents.map((intent) => {
      const stored = runtime.store.getAssistantIntent(intent.intent_id);
      if (!stored || stableJson(stored) !== stableJson(intent)) {
        throw new Error(`Trusted assistant intent payload/store mismatch: ${intent.intent_id}`);
      }
      return stored;
    });
    const observerMessage = appendTrustedRelationshipCatalog(input.message, input.canonicalMessages, durableAssistantIntents);
    log(`Sending relationship-memory batch ${input.batchId} through native Letta conversations API (${input.canonicalMessages.length} trusted evidence messages)`);
    const native = await runNativeClientToolConversation({
      client,
      agentId: input.agentId,
      conversationId: input.conversationId,
      message: observerMessage,
      tools: relationshipTools,
    });
    if (native.clientToolFailure) {
      sessionSucceeded = false;
      log('Relationship-memory native client-tool execution reported a failure');
    }
  } catch (error) {
    sessionSucceeded = false;
    log(`Relationship-memory native observer failure: ${error instanceof Error ? error.message : String(error)}`);
  }

  const completion = runtime.store.withMutationBoundary(() => runtime.finalizeBatch(input.batchId, sessionSucceeded));
  if (completion === 'completed') {
    const apiKey = process.env.LETTA_API_KEY;
    if (apiKey) {
      try {
        await syncProjectionBlocks(apiKey, input.agentId, runtime);
        log(`Projection synchronized after ${input.batchId}`);
      } catch (error) {
        log(`Projection sync deferred: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return completion;
}
