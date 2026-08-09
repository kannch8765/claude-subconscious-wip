import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import {
  appendTrustedRelationshipCatalog,
  buildRelationshipTools,
  createRuntime,
  FORBIDDEN_MARKDOWN_MEMORY_TOOLS,
  relationshipMemoryRoot,
  RELATIONSHIP_ALLOWED_CLIENT_TOOLS,
} from '../relationship-memory/src/adapter/index.js';
import { rebuildProjection } from '../relationship-memory/src/projection/index.js';
import { stableJson } from '../relationship-memory/src/store/index.js';
import { buildLettaApiUrl } from './letta_api_url.js';

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
  let session: any = null;
  let sessionSucceeded = true;

  try {
    const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');
    const relationshipTools = buildRelationshipTools(runtime, input.batchId, jsonResult);
    const resume = resumeSession as any;
    session = resume(input.conversationId, {
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...FORBIDDEN_MARKDOWN_MEMORY_TOOLS],
      allowedTools: [...RELATIONSHIP_ALLOWED_CLIENT_TOOLS],
      tools: relationshipTools,
      permissionMode: 'bypassPermissions',
      cwd: input.cwd,
      skillSources: [],
      systemInfoReminder: false,
      sleeptime: { trigger: 'off' },
      memfsStartup: 'skip',
    });

    const durableAssistantIntents = assistantIntents.map((intent) => {
      const stored = runtime.store.getAssistantIntent(intent.intent_id);
      if (!stored || stableJson(stored) !== stableJson(intent)) {
        throw new Error(`Trusted assistant intent payload/store mismatch: ${intent.intent_id}`);
      }
      return stored;
    });
    const observerMessage = appendTrustedRelationshipCatalog(input.message, input.canonicalMessages, durableAssistantIntents);
    log(`Sending relationship-memory batch ${input.batchId} (${input.canonicalMessages.length} trusted evidence messages)`);
    await session.send(observerMessage);
    for await (const msg of session.stream()) {
      if (msg.type === 'error') {
        sessionSucceeded = false;
        log(`Relationship-memory observer error: ${(msg as any).message}`);
      }
    }
  } catch (error) {
    sessionSucceeded = false;
    log(`Relationship-memory observer session failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (session) session.close();
  }

  const completion = runtime.finalizeBatch(input.batchId, sessionSucceeded);
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
