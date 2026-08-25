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
import { queueSubconWhisper, stableWhisperId } from './subcon_whisper_queue.js';
import { composeGroundedWhisper, foregroundGroundingIdentityAnchors, type EntitySearchObservation } from './grounded_whisper.js';
import { advanceSyncStateCursor, markConversationForRetryRotation } from './conversation_utils.js';
import { openStdioMcpToolsFromEnvironment } from './stdio_mcp_client.js';
import { cancelAndDeferSyncResources, cleanupCompletedSyncResources } from './sync_letta_resources.js';
import { syncClientToolRoundGate } from './sync_client_tool_gate.js';
import { buildForegroundRecallBundle, renderForegroundRecallBundle, type ForegroundRecallCandidate } from './foreground_recall.js';
import {
  persistForegroundRecallBundle,
  writeForegroundRecallReceipt,
  type ForegroundRecallReceipt,
  type ForegroundRecallSearchReceipt,
  type PersistedForegroundRecallBundle,
} from './foreground_recall_state.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const TEMP_STATE_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_native.log');

type LiveWorkerMode = 'async' | 'sync';

export interface AsyncForegroundRecallTurnSnapshot {
  message_id: string;
  turn_id: string;
  bundle?: PersistedForegroundRecallBundle;
  receipt?: ForegroundRecallReceipt;
  delivery_state: 'pending' | 'emitted' | 'missing' | 'not_applicable';
}

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
  foregroundRecallQuery?: string;
  latestUserMessageId?: string;
  foregroundRecallTurns?: AsyncForegroundRecallTurnSnapshot[];
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


function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderForegroundRecallReceiptCatalog(turns: readonly AsyncForegroundRecallTurnSnapshot[]): string {
  if (turns.length === 0) return '';
  const body = turns.map((turn) => {
    const decision = turn.receipt?.decision ?? 'missing';
    const searches = (turn.receipt?.searches ?? []).map((search) =>
      `<search kind="${search.kind}" query_sha256="${escapeXml(search.query_sha256)}" memory_ids="${escapeXml(search.memory_ids.join(','))}"/>`
    ).join('\n');
    const selected = turn.receipt?.selected
      ? `<selected memory_id="${escapeXml(turn.receipt.selected.memory_id)}" snippet_ids="${escapeXml(turn.receipt.selected.snippet_ids.join(','))}"/>`
      : '';
    return `<turn message_id="${escapeXml(turn.message_id)}" turn_id="${escapeXml(turn.turn_id)}" decision="${decision}" delivery_state="${turn.delivery_state}">\n${searches}${searches && selected ? '\n' : ''}${selected}\n</turn>`;
  }).join('\n');
  return `<foreground_recall_receipt_catalog schema_version="1">\n${body}\n</foreground_recall_receipt_catalog>`;
}


function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}


type HistoricalRecallSnippet = { snippet_id?: string; source_kind: 'transcript' | 'legacy_memory'; role?: string; quote: string; captured_at: string };

interface SurfacedRecallMemory {
  summary: string;
  snippets: Map<string, HistoricalRecallSnippet & { snippet_id: string }>;
}

export function renderHistoricalWhisperQuotes(snippets: readonly HistoricalRecallSnippet[]): string {
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

export function renderHistoricalMemoryWhisper(summary: string, snippets: readonly HistoricalRecallSnippet[]): string {
  const memoryEvent = summary.trim();
  if (!memoryEvent) throw new Error('historical memory whisper requires a surfaced canonical summary');
  const historical = renderHistoricalWhisperQuotes(snippets);
  return historical ? `记忆：${memoryEvent}\n\n${historical}` : `记忆：${memoryEvent}`;
}


function registerSurfacedRecallCandidates(
  candidates: readonly ForegroundRecallCandidate[],
  surfaced: Map<string, SurfacedRecallMemory>,
): void {
  for (const memory of candidates) {
    const summary = memory.summary.trim();
    if (!summary) continue;
    const existing = surfaced.get(memory.memory_id);
    const record: SurfacedRecallMemory = existing ?? { summary, snippets: new Map() };
    for (const snippet of memory.quote_snippets) record.snippets.set(snippet.snippet_id, snippet);
    surfaced.set(memory.memory_id, record);
  }
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

  let turnSucceeded = false;
  let whisperDelivered = false;
  let recallResolved = false;
  let foregroundReleased = false;
  let postWhisperFailureCleanupOwned = false;
  const recallSearches: ForegroundRecallSearchReceipt[] = [];
  let foregroundBundle = undefined as Awaited<ReturnType<typeof buildForegroundRecallBundle>> | undefined;
  const latestForegroundRecall = !isSync && payload.latestUserMessageId
    ? payload.foregroundRecallTurns?.find((item) => item.message_id === payload.latestUserMessageId)
    : undefined;
  const latestForegroundRecallResolved = latestForegroundRecall?.receipt?.decision === 'selected'
    || latestForegroundRecall?.receipt?.decision === 'none';

  try {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) throw new Error('LETTA_API_KEY is required for native live Subconscious execution');
    const client = (dependencies.createClient ?? createNativeLettaClient)(apiKey);

    const entitySearchObservations: EntitySearchObservation[] = [];
    const surfacedRecallMemories = new Map<string, SurfacedRecallMemory>();
    let expandRecallUsed = false;
    if (isSync) {
      if (!payload.syncTurnId) throw new Error('sync live worker requires syncTurnId');
      foregroundBundle = await buildForegroundRecallBundle(runtime, payload.foregroundRecallQuery ?? payload.latestUserMessage, {
        sessionId: payload.sessionId, turnId: payload.syncTurnId,
      });
      persistForegroundRecallBundle(payload.cwd, foregroundBundle);
      registerSurfacedRecallCandidates(foregroundBundle.candidates, surfacedRecallMemories);
      recallSearches.push({ kind: 'prefetch', query_sha256: foregroundBundle.query_sha256, memory_ids: foregroundBundle.candidates.map((item) => item.memory_id) });
      log(`Foreground recall bundle prepared: candidates=${foregroundBundle.candidates.length}, bundle_id=${foregroundBundle.bundle_id}`);
    }
    const baseRelationshipTools = buildRelationshipTools(runtime, payload.batchId);
    const modeRelationshipTools = isSync
      ? baseRelationshipTools.filter((tool) => tool.name === 'entity_search')
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
              const summary = typeof memory?.summary === 'string' ? memory.summary.trim() : '';
              const snippets = Array.isArray(memory?.quote_snippets) ? memory.quote_snippets : [];
              if (!memoryId || !summary) continue;
              const existing = surfacedRecallMemories.get(memoryId);
              const record: SurfacedRecallMemory = existing ?? { summary, snippets: new Map() };
              for (const snippet of snippets) {
                const sourceKind = snippet?.source_kind;
                const validTranscript = sourceKind === 'transcript' && (snippet?.role === 'user' || snippet?.role === 'assistant');
                const validLegacy = sourceKind === 'legacy_memory';
                if (
                  typeof snippet?.snippet_id === 'string' && snippet.snippet_id
                  && (validTranscript || validLegacy)
                  && typeof snippet?.quote === 'string'
                  && typeof snippet?.captured_at === 'string'
                ) record.snippets.set(snippet.snippet_id, {
                  snippet_id: snippet.snippet_id,
                  source_kind: sourceKind,
                  ...(validTranscript ? { role: snippet.role } : {}),
                  quote: snippet.quote,
                  captured_at: snippet.captured_at,
                });
              }
              surfacedRecallMemories.set(memoryId, record);
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

    if (isSync) relationshipTools.push({
      name: 'expand_recall',
      description: 'Use at most once only when the prefetched foreground_recall_bundle is insufficient. Provide one short semantic query for the missing historical concept. The runtime returns additional source-faithful memory candidates; do not call near-duplicate refinements.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
      },
      async execute(_toolCallId: string, args: unknown) {
        if (expandRecallUsed) throw new Error('expand_recall may be called at most once per sync turn');
        const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
        const query = typeof raw.query === 'string' ? raw.query.trim() : '';
        if (!query) throw new Error('expand_recall requires a non-empty query');
        expandRecallUsed = true;
        const expanded = await buildForegroundRecallBundle(runtime, query, {
          sessionId: payload.sessionId,
          turnId: `${payload.syncTurnId}:expand`,
        });
        registerSurfacedRecallCandidates(expanded.candidates, surfacedRecallMemories);
        recallSearches.push({ kind: 'expand', query_sha256: expanded.query_sha256, memory_ids: expanded.candidates.map((item) => item.memory_id) });
        log(`Foreground recall expanded: candidates=${expanded.candidates.length}`);
        return { results: expanded.candidates };
      },
    });

    const selectForegroundRecall = async (memoryId: string, snippetIds: string[]): Promise<{ status: 'ok'; whisper_id?: string }> => {
      if (whisperDelivered) throw new Error('foreground whisper may be delivered at most once per batch');
      if (!memoryId || snippetIds.length < 1 || snippetIds.length > 3 || new Set(snippetIds).size !== snippetIds.length) {
        throw new Error('foreground recall selection requires one surfaced memory_id and 1-3 unique snippet_ids');
      }
      const surfacedMemory = surfacedRecallMemories.get(memoryId);
      if (!surfacedMemory || snippetIds.some((snippetId) => !surfacedMemory.snippets.has(snippetId))) {
        throw new Error('foreground recall may select only one memory and quote snippets surfaced by the foreground recall bundle or expand_recall in this turn');
      }
      const snippets = snippetIds.map((snippetId) => surfacedMemory.snippets.get(snippetId)!);
      const historicalWindow = renderHistoricalMemoryWhisper(surfacedMemory.summary, snippets);
      const groundedText = composeGroundedWhisper(historicalWindow, foregroundGroundingIdentityAnchors(entitySearchObservations));
      const queued = queueSubconWhisper(
        payload.cwd, payload.sessionId, payload.batchId, groundedText,
        isSync ? { source: 'sync', turnId: payload.syncTurnId! } : undefined,
      );
      log(`Queued foreground whisper ${queued?.whisper_id ?? 'none'} (${groundedText.length} chars)`);
      whisperDelivered = true;
      if (isSync && foregroundBundle) {
        const whisperId = queued?.whisper_id ?? stableWhisperId(payload.sessionId, payload.batchId);
        writeForegroundRecallReceipt(payload.cwd, {
          schema_version: 1,
          session_id: payload.sessionId,
          turn_id: payload.syncTurnId!,
          bundle_id: foregroundBundle.bundle_id,
          recorded_at: new Date().toISOString(),
          decision: 'selected',
          searches: recallSearches,
          selected: { memory_id: memoryId, snippet_ids: snippetIds },
          whisper_id: whisperId,
        });
        recallResolved = true;
        writeSyncCheckpoint(payload, 'whisper', whisperId);
        foregroundReleased = true;
        return { status: 'ok', whisper_id: whisperId };
      }
      return { status: 'ok', whisper_id: queued?.whisper_id };
    };

    if (isSync) relationshipTools.push({
      name: 'resolve_recall',
      description: 'Resolve foreground recall exactly once. Choose decision=selected only when one surfaced historical memory materially helps this CURRENT user turn; otherwise choose decision=none. Candidate presence, lexical overlap, or an exact identifier match is not enough by itself.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['decision'],
        properties: {
          decision: { type: 'string', enum: ['selected', 'none'] },
          memory_id: { type: 'string', minLength: 1 },
          snippet_ids: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        },
      },
      async execute(_toolCallId: string, args: unknown) {
        if (recallResolved) throw new Error('resolve_recall may be called exactly once per sync turn');
        const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
        const decision = raw.decision;
        if (decision === 'none') {
          if (!foregroundBundle) throw new Error('resolve_recall requires a foreground recall bundle');
          if (raw.memory_id !== undefined || raw.snippet_ids !== undefined) throw new Error('resolve_recall decision=none must not include memory_id or snippet_ids');
          writeForegroundRecallReceipt(payload.cwd, {
            schema_version: 1,
            session_id: payload.sessionId,
            turn_id: payload.syncTurnId!,
            bundle_id: foregroundBundle.bundle_id,
            recorded_at: new Date().toISOString(),
            decision: 'none',
            searches: recallSearches,
          });
          recallResolved = true;
          writeSyncCheckpoint(payload, 'no_whisper');
          foregroundReleased = true;
          log('Foreground recall resolved: none');
          return { status: 'ok', decision: 'none' };
        }
        if (decision !== 'selected') throw new Error('resolve_recall decision must be selected or none');
        const memoryId = typeof raw.memory_id === 'string' ? raw.memory_id.trim() : '';
        const snippetIds = Array.isArray(raw.snippet_ids)
          ? raw.snippet_ids.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
          : [];
        const result = await selectForegroundRecall(memoryId, snippetIds);
        recallResolved = true;
        return { ...result, decision: 'selected' };
      },
    });
    else if (!latestForegroundRecallResolved) relationshipTools.push({
      name: 'deliver_whisper',
      description: 'Surface one source-faithful historical memory window for foreground Kohaku on a later sync. Select 1-3 snippet_ids from quote_snippets returned by a prior memory_search for one memory_id. The runtime renders the surfaced canonical memory summary as `记忆：...`, then renders transcript snippets as 猫/当时琥珀 quotes and legacy_memory fallback snippets explicitly as 旧记忆记录; do not supply your own event title, prose, interpretation, feelings, fulfillment framing, or relationship conclusions. Retrieval itself supplies the association. Do not call when nothing is meaningfully useful.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['memory_id', 'snippet_ids'],
        properties: {
          memory_id: { type: 'string', minLength: 1, description: 'A memory_id from a prior memory_search result in this turn.' },
          snippet_ids: {
            type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            description: 'Choose 1-3 source-faithful snippet IDs returned under quote_snippets for this memory in a prior memory_search result.',
          },
        },
      },
      async execute(_toolCallId: string, args: unknown) {
        const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
        const memoryId = typeof raw.memory_id === 'string' ? raw.memory_id.trim() : '';
        const snippetIds = Array.isArray(raw.snippet_ids)
          ? raw.snippet_ids.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
          : [];
        return selectForegroundRecall(memoryId, snippetIds);
      },
    });
    if (!isSync && latestForegroundRecallResolved) {
      log(`Skipping async deliver_whisper because foreground recall already resolved for message ${payload.latestUserMessageId}`);
    }

    const durableAssistantIntents = isSync ? [] : assistantIntents.map((intent) => {
      const stored = runtime.store.getAssistantIntent(intent.intent_id);
      if (!stored || stableJson(stored) !== stableJson(intent)) {
        throw new Error(`Trusted assistant intent payload/store mismatch: ${intent.intent_id}`);
      }
      return stored;
    });

    const liveMessage = isSync
      ? `${payload.message}

${foregroundBundle ? renderForegroundRecallBundle(foregroundBundle) : ''}`
      : [
          appendTrustedRelationshipCatalog(payload.message, canonicalMessages, durableAssistantIntents),
          renderForegroundRecallReceiptCatalog(payload.foregroundRecallTurns ?? []),
        ].filter(Boolean).join('\n\n');

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
        requiredClientToolNames: ['resolve_recall'],
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
          requiredClientToolNames: [],
        });
      } finally {
        await stdioMcp.close();
      }
    }
    turnSucceeded = !result.clientToolFailure;
    const stopReason = result.response?.stop_reason?.stop_reason ?? result.response?.stop_reason?.reason ?? 'end_turn';
    log(`Native live turn complete: mode=${mode}, success=${turnSucceeded}, stop_reason=${stopReason}`);
    if (result.clientToolFailure) log('Native live turn contained at least one failed client-tool execution');
    if (isSync && !recallResolved) throw new Error('sync foreground recall ended without resolve_recall');
  } catch (error) {
    turnSucceeded = false;
    log(`Live Subconscious native-client failure: ${error instanceof Error ? error.message : String(error)}`);
    if (isSync) {
      if (!recallResolved && foregroundBundle && payload.syncTurnId) writeForegroundRecallReceipt(payload.cwd, {
        schema_version: 1,
        session_id: payload.sessionId,
        turn_id: payload.syncTurnId,
        bundle_id: foregroundBundle.bundle_id,
        recorded_at: new Date().toISOString(),
        decision: 'failed',
        searches: recallSearches,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      const apiKey = process.env.LETTA_API_KEY;
      const syncAgentId = payload.syncAgentId ?? payload.agentId;
      if (foregroundReleased && apiKey) {
        // Foreground already consumed the durable whisper checkpoint and the
        // wrapper may have exited. From this point the worker owns cleanup:
        // cancel/defer the server resources and do NOT publish a new failed
        // checkpoint that nobody is left to consume.
        await (dependencies.cancelAndDefer ?? cancelAndDeferSyncResources)(apiKey, payload.conversationId, syncAgentId, payload.syncBlockIds ?? []);
        // Keep the already-durable whisper checkpoint untouched. If the wrapper
        // has not observed it yet, it must still be able to release foreground;
        // if it already observed it, the wrapper has removed it itself.
        postWhisperFailureCleanupOwned = true;
        log(`Post-release sync failure cleanup deferred for conversation ${payload.conversationId}`);
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

export async function runNativeWorkerPayload(
  payload: LiveWorkerPayload,
  dependencies: LiveWorkerDependencies = {},
): Promise<'completed' | 'retryable_failure'> {
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
  return completion;
}

export async function runNativeWorkerPayloadFile(
  payloadFile: string,
  dependencies: LiveWorkerDependencies = {},
): Promise<'completed' | 'retryable_failure'> {
  if (!payloadFile) throw new Error('No payload file specified');
  log('='.repeat(60));
  log(`Native live worker started with payload: ${payloadFile}`);
  if (!fs.existsSync(payloadFile)) throw new Error(`Payload file not found: ${payloadFile}`);

  const payload: LiveWorkerPayload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
  log(`Loaded payload for session ${payload.sessionId}`);
  const completion = await runNativeWorkerPayload(payload, dependencies);

  try { fs.unlinkSync(payloadFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  log('Cleaned up payload file');
  log('Native live worker completed successfully');
  return completion;
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
