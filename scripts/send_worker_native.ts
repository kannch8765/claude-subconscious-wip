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

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const TEMP_STATE_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_native.log');

interface LiveWorkerPayload {
  agentId: string;
  conversationId: string;
  sessionId: string;
  message: string;
  stateFile: string;
  newLastProcessedIndex: number;
  cwd: string;
  batchId: string;
  canonicalMessages: CanonicalMessage[];
  assistantIntents: AssistantRememberIntentRecord[];
  latestUserMessage: string;
}

function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function sendViaNativeClient(payload: LiveWorkerPayload): Promise<'completed' | 'retryable_failure'> {
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  const assistantIntents = payload.assistantIntents ?? [];
  const runtime = createRuntime(payload.canonicalMessages, subjectId, relationshipMemoryRoot(), assistantIntents);

  const latest = [...runtime.store.listBatches()].reverse().find((item) => item.batch_id === payload.batchId);
  if (latest?.status === 'completed') {
    log(`Relationship-memory batch already durably completed: ${payload.batchId}`);
    return 'completed';
  }

  const hasRealUserMessage = Boolean(payload.latestUserMessage?.trim());

  runtime.store.beginBatch(payload.batchId, new Date().toISOString());
  let turnSucceeded = false;

  try {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) throw new Error('LETTA_API_KEY is required for native live Subconscious execution');
    const client = createNativeLettaClient(apiKey);

    const relationshipTools: NativeClientTool[] = buildRelationshipTools(runtime, payload.batchId).map((tool) => {
      const execute = tool.execute.bind(tool);
      if (tool.name === 'memory_search') {
        return {
          ...tool,
          async execute(toolCallId: string, args: unknown) {
            const query = typeof (args as any)?.query === 'string' ? (args as any).query.trim() : '';
            log(`Model relationship memory_search: query=${JSON.stringify(query)}`);
            return execute(toolCallId, args);
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
      description: 'Deliver at most one concise subconscious memory whisper for foreground Kohaku on a later sync. Include only useful remembered context or association; never include search/storage/tool bookkeeping. Do not call when nothing is meaningfully useful.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 1200 } },
      },
      async execute(_toolCallId: string, args: unknown) {
        if (whisperDelivered) throw new Error('deliver_whisper may be called at most once per batch');
        const text = typeof (args as any)?.text === 'string' ? (args as any).text.trim() : '';
        if (!text) throw new Error('deliver_whisper.text must be non-empty');
        const queued = queueSubconWhisper(payload.cwd, payload.sessionId, payload.batchId, text);
        whisperDelivered = true;
        log(`Queued foreground whisper ${queued?.whisper_id ?? 'none'} (${text.length} chars)`);
        return { status: 'ok', whisper_id: queued?.whisper_id };
      },
    });

    const durableAssistantIntents = assistantIntents.map((intent) => {
      const stored = runtime.store.getAssistantIntent(intent.intent_id);
      if (!stored || stableJson(stored) !== stableJson(intent)) {
        throw new Error(`Trusted assistant intent payload/store mismatch: ${intent.intent_id}`);
      }
      return stored;
    });

    const liveMessage = appendTrustedRelationshipCatalog(
      payload.message,
      payload.canonicalMessages,
      durableAssistantIntents,
    );

    log(`Starting native live Subconscious turn for conversation ${payload.conversationId}`);
    log(`  agent: ${payload.agentId}`);
    log(`  relationship client tools: ${relationshipTools.map((tool) => tool.name).join(', ')}`);

    const result = await runNativeClientToolConversation({
      client,
      agentId: payload.agentId,
      conversationId: payload.conversationId,
      message: liveMessage,
      tools: relationshipTools,
      requiredClientToolNames: hasRealUserMessage ? ['memory_search'] : [],
    });
    turnSucceeded = !result.clientToolFailure;
    const stopReason = result.response?.stop_reason?.stop_reason ?? result.response?.stop_reason?.reason ?? 'end_turn';
    log(`Native live turn complete: success=${turnSucceeded}, stop_reason=${stopReason}`);
    if (result.clientToolFailure) log('Native live turn contained at least one failed client-tool execution');
  } catch (error) {
    turnSucceeded = false;
    log(`Live Subconscious native-client failure: ${error instanceof Error ? error.message : String(error)}`);
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

    if (cursorShouldAdvance(completion)) {
      const state = JSON.parse(fs.readFileSync(payload.stateFile, 'utf-8'));
      state.lastProcessedIndex = payload.newLastProcessedIndex;
      fs.writeFileSync(payload.stateFile, JSON.stringify(state, null, 2));
      log(`Updated state: lastProcessedIndex=${payload.newLastProcessedIndex}`);
    } else {
      log(`Held state cursor at current index because batch ${payload.batchId} is retryable.`);
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
