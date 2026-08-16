#!/usr/bin/env npx tsx
/**
 * Native Letta background worker for the live Subconscious agent.
 *
 * Live execution uses @letta-ai/letta-client conversations with only the
 * trusted relationship client-tool surface. Persistent working-memory and
 * conversation_search remain server-side Letta tools on the live agent.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import {
  appendTrustedRelationshipCatalog,
  buildRelationshipTools,
  createRuntime,
  relationshipMemoryRoot,
} from '../relationship-memory/src/adapter/index.js';
import { stableJson } from '../relationship-memory/src/store/index.js';
import { cursorShouldAdvance } from '../relationship-memory/src/tools/index.js';
import {
  createNativeLettaClient,
  runNativeClientToolConversation,
  type NativeClientTool,
} from './native_letta_backfill.js';
import { queueSubconWhisper } from './subcon_whisper_queue.js';
import { composeGroundedWhisper, foregroundGroundingIdentityAnchors, type EntitySearchObservation } from './grounded_whisper.js';
import { advanceSyncStateCursor, markConversationForRetryRotation } from './conversation_utils.js';
import { openStdioMcpToolsFromEnvironment } from './stdio_mcp_client.js';
import { buildLettaApiUrl } from './letta_api_url.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const TEMP_STATE_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_native.log');

type LiveWorkerMode = 'async' | 'sync';

interface LiveWorkerPayload {
  mode?: LiveWorkerMode;
  agentId: string;
  conversationId: string;
  sessionId: string;
  message: string;
  stateFile?: string;
  newLastProcessedIndex?: number;
  cwd: string;
  batchId: string;
  canonicalMessages?: CanonicalMessage[];
  assistantIntents?: AssistantRememberIntentRecord[];
  latestUserMessage: string;
  syncCheckpointFile?: string;
  syncTurnId?: string;
  deleteConversationOnFinish?: boolean;
}

type SyncCheckpointStatus = 'whisper' | 'no_whisper' | 'failed';

function writeSyncCheckpoint(payload: LiveWorkerPayload, status: SyncCheckpointStatus, whisperId?: string): void {
  if (payload.mode !== 'sync' || !payload.syncCheckpointFile) return;
  if (fs.existsSync(payload.syncCheckpointFile)) return;
  const dir = path.dirname(payload.syncCheckpointFile);
  fs.mkdirSync(dir, { recursive: true });
  const checkpoint = { status, ...(whisperId ? { whisper_id: whisperId } : {}), recorded_at: new Date().toISOString() };
  const temp = `${payload.syncCheckpointFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  try { fs.renameSync(temp, payload.syncCheckpointFile); }
  catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    if (!fs.existsSync(payload.syncCheckpointFile)) throw error;
  }
}

async function deleteConversation(apiKey: string, conversationId: string): Promise<void> {
  const response = await fetch(buildLettaApiUrl(`/conversations/${encodeURIComponent(conversationId)}`), {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete sync conversation: ${response.status} ${await response.text()}`);
  }
}

function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function sendViaNativeClient(payload: LiveWorkerPayload): Promise<'completed' | 'retryable_failure'> {
  const mode: LiveWorkerMode = payload.mode ?? 'async';
  const isSync = mode === 'sync';
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  const assistantIntents = payload.assistantIntents ?? [];
  const canonicalMessages = payload.canonicalMessages ?? [];
  const runtime = createRuntime(canonicalMessages, subjectId, relationshipMemoryRoot(), assistantIntents);

  if (!isSync) {
    const latest = [...runtime.store.listBatches()].reverse().find((item) => item.batch_id === payload.batchId);
    if (latest?.status === 'completed') {
      log(`Relationship-memory batch already durably completed: ${payload.batchId}`);
      return 'completed';
    }
    runtime.store.beginBatch(payload.batchId, new Date().toISOString());
  }

  const hasRealUserMessage = Boolean(payload.latestUserMessage?.trim());
  let turnSucceeded = false;

  try {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) throw new Error('LETTA_API_KEY is required for native live Subconscious execution');
    const client = createNativeLettaClient(apiKey);

    const entitySearchObservations: EntitySearchObservation[] = [];
    const baseRelationshipTools = buildRelationshipTools(runtime, payload.batchId);
    const modeRelationshipTools = isSync
      ? baseRelationshipTools.filter((tool) => ['memory_search', 'entity_search'].includes(tool.name))
      : baseRelationshipTools;
    const relationshipTools: NativeClientTool[] = modeRelationshipTools.map((tool) => {
      const execute = tool.execute.bind(tool);
      if (tool.name === 'entity_search') {
        const baseParameters = tool.parameters as any;
        return {
          ...tool,
          description: `${tool.description} Set purpose=foreground_grounding only when this lookup is needed because foreground Kohaku does not know the referent; use purpose=maintenance for alias/dedupe checks or other entity maintenance.`,
          parameters: {
            ...baseParameters,
            required: [...new Set([...(Array.isArray(baseParameters?.required) ? baseParameters.required : []), 'purpose'])],
            properties: {
              ...(baseParameters?.properties ?? {}),
              purpose: {
                type: 'string',
                enum: ['foreground_grounding', 'maintenance'],
                description: 'Why this lookup is being performed. foreground_grounding is only for an unresolved referent whose stable identity needs to reach foreground Kohaku; maintenance covers alias/dedupe checks such as searching before entity_remember.',
              },
            },
          },
          async execute(toolCallId: string, args: unknown) {
            const rawArgs = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
            const purpose = rawArgs.purpose;
            const { purpose: _purpose, ...searchArgs } = rawArgs;
            const result = isSync
              ? { results: await runtime.entitySearchRecallHybrid(searchArgs as any) }
              : await execute(toolCallId, searchArgs);
            entitySearchObservations.push({ purpose, query: searchArgs.query, result });
            return result;
          },
        };
      }
      if (tool.name === 'memory_search') {
        return {
          ...tool,
          async execute(toolCallId: string, args: unknown) {
            const query = typeof (args as any)?.query === 'string' ? (args as any).query.trim() : '';
            log(`Model relationship memory_search: query=${JSON.stringify(query)}`);
            const startedAt = Date.now();
            const result = isSync
              ? { results: await runtime.memorySearchRecallHybrid((args ?? {}) as any) }
              : await execute(toolCallId, args);
            const resultCount = Array.isArray((result as any)?.results) ? (result as any).results.length : undefined;
            log(`Model relationship memory_search completed: elapsed_ms=${Date.now() - startedAt}, results=${resultCount ?? 'unknown'}`);
            return result;
          },
        };
      }
      if (!['memory_remember', 'memory_reinforce', 'entity_remember'].includes(tool.name)) return tool;
      return {
        ...tool,
        async execute(toolCallId: string, args: unknown) {
          return runtime.store.withMutationBoundary(() => execute(toolCallId, args));
        },
      };
    });

    let whisperDelivered = false;
    relationshipTools.push({
      name: 'deliver_whisper',
      description: isSync
        ? 'Deliver at most one concise subconscious memory whisper for the current foreground Kohaku turn. Include only useful remembered context or association; never include search/storage/tool bookkeeping. Do not call when nothing is meaningfully useful.'
        : 'Deliver at most one concise subconscious memory whisper for foreground Kohaku on a later sync. Include only useful remembered context or association; never include search/storage/tool bookkeeping. Do not call when nothing is meaningfully useful.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 1200 } },
      },
      async execute(_toolCallId: string, args: unknown) {
        if (whisperDelivered) throw new Error('deliver_whisper may be called at most once per batch');
        const text = typeof (args as any)?.text === 'string' ? (args as any).text.trim() : '';
        if (!text) throw new Error('deliver_whisper.text must be non-empty');
        const groundedText = composeGroundedWhisper(text, foregroundGroundingIdentityAnchors(entitySearchObservations));
        if (isSync && !payload.syncTurnId) throw new Error('sync live worker requires syncTurnId');
        const queued = queueSubconWhisper(
          payload.cwd, payload.sessionId, payload.batchId, groundedText,
          isSync ? { source: 'sync', turnId: payload.syncTurnId! } : undefined,
        );
        whisperDelivered = true;
        log(`Queued foreground whisper ${queued?.whisper_id ?? 'none'} (${groundedText.length} chars)`);
        if (isSync) writeSyncCheckpoint(payload, 'whisper', queued?.whisper_id);
        return { status: 'ok', whisper_id: queued?.whisper_id };
      },
    });

    const durableAssistantIntents = isSync ? [] : assistantIntents.map((intent) => {
      const stored = runtime.store.getAssistantIntent(intent.intent_id);
      if (!stored || stableJson(stored) !== stableJson(intent)) {
        throw new Error(`Trusted assistant intent payload/store mismatch: ${intent.intent_id}`);
      }
      return stored;
    });

    const liveMessage = isSync
      ? payload.message
      : appendTrustedRelationshipCatalog(payload.message, canonicalMessages, durableAssistantIntents);

    log(`Starting native live Subconscious turn for conversation ${payload.conversationId}`);
    log(`  agent: ${payload.agentId}`);
    log(`  relationship client tools: ${relationshipTools.map((tool) => tool.name).join(', ')}`);

    let result;
    if (isSync) {
      // Sync mode is intentionally relationship-recall-only. The existing async
      // lane remains the sole owner of canonical memory mutation and optional
      // external MCP side effects, avoiding duplicate maintenance for one user turn.
      log('  stdio MCP client tools: (disabled in sync mode)');
      result = await runNativeClientToolConversation({
        client,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        message: liveMessage,
        tools: relationshipTools,
        requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : [],
        continuationBusyRetry: { maxWaitMs: 3_000, intervalMs: 100 },
      });
    } else {
      const stdioMcp = await openStdioMcpToolsFromEnvironment(log);
      const nativeToolNames = new Set(relationshipTools.map((tool) => tool.name));
      const mcpTools = stdioMcp.tools.filter((tool) => {
        if (!nativeToolNames.has(tool.name)) return true;
        log(`Ignoring colliding stdio MCP tool name: ${tool.name}`);
        return false;
      });
      const liveTools = [...relationshipTools, ...mcpTools];
      log(`  stdio MCP client tools: ${mcpTools.map((tool) => tool.name).join(', ') || '(none)'}`);
      try {
        result = await runNativeClientToolConversation({
          client,
          agentId: payload.agentId,
          conversationId: payload.conversationId,
          message: liveMessage,
          tools: liveTools,
          requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : [],
        });
      } finally {
        await stdioMcp.close();
      }
    }
    turnSucceeded = !result.clientToolFailure;
    const stopReason = result.response?.stop_reason?.stop_reason ?? result.response?.stop_reason?.reason ?? 'end_turn';
    log(`Native live turn complete: mode=${mode}, success=${turnSucceeded}, stop_reason=${stopReason}`);
    if (result.clientToolFailure) log('Native live turn contained at least one failed client-tool execution');
    if (isSync && !whisperDelivered) writeSyncCheckpoint(payload, 'no_whisper');
  } catch (error) {
    turnSucceeded = false;
    log(`Live Subconscious native-client failure: ${error instanceof Error ? error.message : String(error)}`);
    if (isSync) writeSyncCheckpoint(payload, 'failed');
  }

  if (isSync) {
    if (payload.deleteConversationOnFinish && turnSucceeded) {
      const apiKey = process.env.LETTA_API_KEY;
      if (apiKey) {
        try { await deleteConversation(apiKey, payload.conversationId); }
        catch (error) { log(`Failed to clean up sync conversation ${payload.conversationId}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } else if (!turnSucceeded) {
      // The foreground wrapper owns failed-run cancellation. Deleting here can
      // race Letta 0.16.8's shielded streaming task after the client sees an
      // execution error, causing server-side NoResultFound on the conversation.
      log(`Leaving failed sync conversation ${payload.conversationId} for wrapper cancellation cleanup`);
    }
    return turnSucceeded ? 'completed' : 'retryable_failure';
  }

  const completion = runtime.store.withMutationBoundary(() => runtime.finalizeBatch(payload.batchId, turnSucceeded));
  log(`Relationship-memory batch finalized alongside live delivery: ${completion}`);
  return completion;
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];
  if (!payloadFile) {
    log('ERROR: No payload file specified');
    process.exit(1);
  }

  log('='.repeat(60));
  log(`Native live worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: LiveWorkerPayload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
    log(`Loaded payload for session ${payload.sessionId}`);

    let completion: 'completed' | 'retryable_failure';
    try {
      completion = await sendViaNativeClient(payload);
    } catch (error) {
      log(`Native live turn failed before trusted batch completion: ${error instanceof Error ? error.message : String(error)}`);
      completion = 'retryable_failure';
    }

    if ((payload.mode ?? 'async') === 'async') {
      if (!Number.isInteger(payload.newLastProcessedIndex)) throw new Error('async live worker requires newLastProcessedIndex');
      const newLastProcessedIndex = payload.newLastProcessedIndex as number;
      if (cursorShouldAdvance(completion)) {
        const state = advanceSyncStateCursor(payload.cwd, payload.sessionId, newLastProcessedIndex, log);
        log(`Updated state: lastProcessedIndex=${state.lastProcessedIndex}`);
      } else {
        markConversationForRetryRotation(
          payload.cwd,
          payload.sessionId,
          payload.conversationId,
          newLastProcessedIndex,
          log,
        );
        log(`Held state cursor at current index because batch ${payload.batchId} is retryable; armed live-conversation recovery marker for a later pass after overlap grace.`);
      }
    }

    fs.unlinkSync(payloadFile);
    log('Cleaned up payload file');
    log('Native live worker completed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) log(`Stack: ${error.stack}`);
    process.exit(1);
  }
}

main();
