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
import { fileURLToPath } from 'url';
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
import { cancelAndDeferSyncResources, cleanupCompletedSyncResources } from './sync_letta_resources.js';
import { syncClientToolRoundGate } from './sync_client_tool_gate.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const TEMP_STATE_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_native.log');

type LiveWorkerMode = 'async' | 'sync';

export interface LiveWorkerPayload {
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
  syncAgentId?: string;
  syncBlockIds?: string[];
  cleanupSyncResourcesOnFinish?: boolean;
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


function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}


type SurfacedQuoteSnippet = { snippet_id: string; source_kind: 'transcript' | 'legacy_memory'; role?: string; quote: string; captured_at: string };
type SurfacedMemoryContext = { summary: string; snippets: Map<string, SurfacedQuoteSnippet> };

export function renderHistoricalWhisperQuotes(snippets: readonly Omit<SurfacedQuoteSnippet, 'snippet_id'>[]): string {
  const lines: string[] = [];
  let activeDate = '';
  for (const snippet of snippets) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(snippet.captured_at)?.[0] ?? '过去';
    if (date !== activeDate) {
      lines.push(`[${date}]`);
      activeDate = date;
    }
    const speaker = snippet.source_kind === 'legacy_memory'
      ? '旧记忆记录'
      : snippet.role === 'assistant' ? '当时琥珀' : '猫';
    lines.push(`${speaker}：「${snippet.quote}」`);
  }
  return lines.join('\n');
}

export function renderHistoricalWhisperMemory(summary: string, snippets: readonly Omit<SurfacedQuoteSnippet, 'snippet_id'>[]): string {
  const sourceHeading = snippets.every((snippet) => snippet.source_kind === 'legacy_memory')
    ? '历史来源：'
    : '当时原文：';
  return `记忆：\n${summary}\n${sourceHeading}\n${renderHistoricalWhisperQuotes(snippets)}`;
}

export interface LiveWorkerDependencies {
  createClient?: (apiKey: string) => any;
  runConversation?: typeof runNativeClientToolConversation;
  cancelAndDefer?: typeof cancelAndDeferSyncResources;
  cleanupCompleted?: typeof cleanupCompletedSyncResources;
}

export async function sendViaNativeClient(
  payload: LiveWorkerPayload,
  dependencies: LiveWorkerDependencies = {},
): Promise<'completed' | 'retryable_failure'> {
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
  let whisperDelivered = false;
  let postWhisperFailureCleanupOwned = false;

  try {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) throw new Error('LETTA_API_KEY is required for native live Subconscious execution');
    const client = (dependencies.createClient ?? createNativeLettaClient)(apiKey);

    const entitySearchObservations: EntitySearchObservation[] = [];
    const surfacedMemories = new Map<string, SurfacedMemoryContext>();
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
              ? { results: await runtime.memorySearchRecallHybridWithEvidence((args ?? {}) as any) }
              : await execute(toolCallId, args);
            const results = Array.isArray((result as any)?.results) ? (result as any).results as any[] : [];
            for (const memory of results) {
              const memoryId = typeof memory?.memory_id === 'string' ? memory.memory_id : '';
              const summary = typeof memory?.summary === 'string' && memory.summary.trim() ? memory.summary : '';
              const snippets = Array.isArray(memory?.quote_snippets) ? memory.quote_snippets : [];
              if (!memoryId || !summary) continue;
              const surfaced = surfacedMemories.get(memoryId) ?? { summary, snippets: new Map<string, SurfacedQuoteSnippet>() };
              for (const snippet of snippets) {
                const sourceKind = snippet?.source_kind;
                const validTranscript = sourceKind === 'transcript' && (snippet?.role === 'user' || snippet?.role === 'assistant');
                const validLegacy = sourceKind === 'legacy_memory';
                if (
                  typeof snippet?.snippet_id === 'string' && snippet.snippet_id
                  && (validTranscript || validLegacy)
                  && typeof snippet?.quote === 'string'
                  && typeof snippet?.captured_at === 'string'
                ) surfaced.snippets.set(snippet.snippet_id, {
                  snippet_id: snippet.snippet_id,
                  source_kind: sourceKind,
                  ...(validTranscript ? { role: snippet.role } : {}),
                  quote: snippet.quote,
                  captured_at: snippet.captured_at,
                });
              }
              surfacedMemories.set(memoryId, surfaced);
            }
            log(`Model relationship memory_search completed: elapsed_ms=${Date.now() - startedAt}, results=${results.length}`);
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

    relationshipTools.push({
      name: 'deliver_whisper',
      description: isSync
        ? 'Surface one source-faithful historical memory window for the CURRENT foreground Kohaku turn. Select 1-3 snippet_ids from quote_snippets returned by a prior memory_search for one memory_id. The runtime prepends the canonical summary from that prior search, then renders transcript snippets as 猫/当时琥珀 quotes and legacy_memory fallback snippets explicitly as 旧记忆记录; do not supply a summary, prose, interpretation, feelings, fulfillment framing, or relationship conclusions. Retrieval itself supplies the association. Do not call when nothing is meaningfully useful.'
        : 'Surface one source-faithful historical memory window for foreground Kohaku on a later sync. Select 1-3 snippet_ids from quote_snippets returned by a prior memory_search for one memory_id. The runtime prepends the canonical summary from that prior search, then renders transcript snippets as 猫/当时琥珀 quotes and legacy_memory fallback snippets explicitly as 旧记忆记录; do not supply a summary, prose, interpretation, feelings, fulfillment framing, or relationship conclusions. Retrieval itself supplies the association. Do not call when nothing is meaningfully useful.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['memory_id', 'snippet_ids'],
        properties: {
          memory_id: { type: 'string', minLength: 1, description: 'A memory_id from a prior memory_search result in this turn.' },
          snippet_ids: {
            type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            description: 'Choose 1-3 source-faithful snippet IDs returned under quote_snippets for this memory in a prior memory_search result. transcript snippets are direct quotes; legacy_memory snippets are explicitly labeled old-memory-record excerpts, not direct quotes. Prefer the fewest quotes that let the remembered moment stand on its own.',
          },
        },
      },
      async execute(_toolCallId: string, args: unknown) {
        if (whisperDelivered) throw new Error('deliver_whisper may be called at most once per batch');
        const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
        const memoryId = typeof raw.memory_id === 'string' ? raw.memory_id.trim() : '';
        const snippetIds = Array.isArray(raw.snippet_ids)
          ? raw.snippet_ids.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
          : [];
        if (!memoryId || snippetIds.length < 1 || snippetIds.length > 3 || new Set(snippetIds).size !== snippetIds.length) {
          throw new Error('deliver_whisper requires one searched memory_id and 1-3 unique snippet_ids');
        }
        const surfaced = surfacedMemories.get(memoryId);
        if (!surfaced || snippetIds.some((snippetId) => !surfaced.snippets.has(snippetId))) {
          throw new Error('deliver_whisper may select only quote snippets surfaced by a prior memory_search in this turn');
        }
        const snippets = snippetIds.map((snippetId) => surfaced.snippets.get(snippetId)!);
        const historicalWindow = renderHistoricalWhisperMemory(surfaced.summary, snippets);
        const groundedText = composeGroundedWhisper(historicalWindow, foregroundGroundingIdentityAnchors(entitySearchObservations));
        if (isSync && !payload.syncTurnId) throw new Error('sync live worker requires syncTurnId');
        const queued = queueSubconWhisper(
          payload.cwd, payload.sessionId, payload.batchId, groundedText,
          isSync ? { source: 'sync', turnId: payload.syncTurnId! } : undefined,
        );
        log(`Queued foreground whisper ${queued?.whisper_id ?? 'none'} (${groundedText.length} chars)`);
        if (isSync) writeSyncCheckpoint(payload, 'whisper', queued?.whisper_id);
        // Cleanup ownership transfers only after the durable foreground release
        // checkpoint exists. A queue write alone is not enough to let Kohaku go.
        whisperDelivered = true;
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
      result = await (dependencies.runConversation ?? runNativeClientToolConversation)({
        client,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        message: liveMessage,
        tools: relationshipTools,
        requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : [],
        continuationBusyRetry: { maxWaitMs: 3_000, intervalMs: 100 },
        clientToolRoundGate: syncClientToolRoundGate,
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
        result = await (dependencies.runConversation ?? runNativeClientToolConversation)({
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
    if (isSync) {
      const apiKey = process.env.LETTA_API_KEY;
      const syncAgentId = payload.syncAgentId ?? payload.agentId;
      if (whisperDelivered && apiKey) {
        // Foreground already consumed the durable whisper checkpoint and the
        // wrapper may have exited. From this point the worker owns cleanup:
        // cancel/defer the server resources and do NOT publish a new failed
        // checkpoint that nobody is left to consume.
        await (dependencies.cancelAndDefer ?? cancelAndDeferSyncResources)(apiKey, payload.conversationId, syncAgentId, payload.syncBlockIds ?? []);
        // Keep the already-durable whisper checkpoint untouched. If the wrapper
        // has not observed it yet, it must still be able to release foreground;
        // if it already observed it, the wrapper has removed it itself.
        postWhisperFailureCleanupOwned = true;
        log(`Post-whisper sync failure cleanup deferred for conversation ${payload.conversationId}`);
      } else {
        writeSyncCheckpoint(payload, 'failed');
      }
    }
  }

  if (isSync) {
    const apiKey = process.env.LETTA_API_KEY;
    const syncAgentId = payload.syncAgentId ?? payload.agentId;
    if (payload.cleanupSyncResourcesOnFinish && turnSucceeded && apiKey) {
      await (dependencies.cleanupCompleted ?? cleanupCompletedSyncResources)(apiKey, payload.conversationId, syncAgentId, payload.syncBlockIds ?? []);
    } else if (!turnSucceeded && !postWhisperFailureCleanupOwned) {
      // Before foreground release the wrapper still owns failed-run cleanup.
      log(`Leaving failed sync resources ${payload.conversationId} / ${syncAgentId} for wrapper cancellation cleanup`);
    }
    return turnSucceeded ? 'completed' : 'retryable_failure';
  }

  const completion = runtime.store.withMutationBoundary(() => runtime.finalizeBatch(payload.batchId, turnSucceeded));
  log(`Relationship-memory batch finalized alongside live delivery: ${completion}`);
  return completion;
}

export async function runNativeWorkerPayloadFile(
  payloadFile: string,
  dependencies: LiveWorkerDependencies = {},
): Promise<void> {
  if (!payloadFile) throw new Error('No payload file specified');
  log('='.repeat(60));
  log(`Native live worker started with payload: ${payloadFile}`);
  if (!fs.existsSync(payloadFile)) throw new Error(`Payload file not found: ${payloadFile}`);

  const payload: LiveWorkerPayload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
  log(`Loaded payload for session ${payload.sessionId}`);
  let completion: 'completed' | 'retryable_failure';
  try {
    completion = await sendViaNativeClient(payload, dependencies);
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

  try { fs.unlinkSync(payloadFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  log('Cleaned up payload file');
  log('Native live worker completed successfully');
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];
  try {
    await runNativeWorkerPayloadFile(payloadFile);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) log(`Stack: ${error.stack}`);
    process.exit(1);
  }
}

const invokedAsMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) void main();
