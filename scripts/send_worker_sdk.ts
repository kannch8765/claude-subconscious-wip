#!/usr/bin/env npx tsx
/**
 * SDK-based background worker for the live Subconscious agent.
 *
 * The live lane preserves the original persistent guidance/context behavior
 * while also exposing trusted relationship-memory client tools. Historical
 * backfill uses the separate strict relationship observer runner.
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
  RELATIONSHIP_ALLOWED_CLIENT_TOOLS,
} from '../relationship-memory/src/adapter/index.js';
import { stableJson } from '../relationship-memory/src/store/index.js';
import { cursorShouldAdvance } from '../relationship-memory/src/tools/index.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const TEMP_STATE_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_sdk.log');

interface SdkPayload {
  agentId: string;
  conversationId: string;
  sessionId: string;
  message: string;
  stateFile: string;
  newLastProcessedIndex: number;
  cwd: string;
  sdkToolsMode: 'off' | 'read-only' | 'full';
  batchId: string;
  canonicalMessages: CanonicalMessage[];
  assistantIntents: AssistantRememberIntentRecord[];
}

function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function sendViaSdk(payload: SdkPayload): Promise<'completed' | 'retryable_failure'> {
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  const assistantIntents = payload.assistantIntents ?? [];
  const runtime = createRuntime(payload.canonicalMessages, subjectId, relationshipMemoryRoot(), assistantIntents);

  const latest = [...runtime.store.listBatches()].reverse().find((item) => item.batch_id === payload.batchId);
  if (latest?.status === 'completed') {
    log(`Relationship-memory batch already durably completed: ${payload.batchId}`);
    return 'completed';
  }

  runtime.store.beginBatch(payload.batchId, new Date().toISOString());
  let session: any = null;
  let sessionSucceeded = true;

  try {
    log('Loading Letta Code SDK for live Subconscious delivery...');
    const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');

    const relationshipTools = buildRelationshipTools(runtime, payload.batchId, jsonResult).map((tool) => {
      if (!['memory_remember', 'memory_reinforce', 'entity_remember'].includes(tool.name)) return tool;
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

    const readOnlyTools = ['Read', 'Grep', 'Glob', 'web_search', 'fetch_webpage'];
    const blockedTools = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
    const sessionOptions: Record<string, unknown> = {
      disallowedTools: blockedTools,
      tools: relationshipTools,
      permissionMode: 'bypassPermissions',
      cwd: payload.cwd,
      skillSources: [],
      systemInfoReminder: false,
      sleeptime: { trigger: 'off' },
      memfsStartup: 'skip',
    };

    if (payload.sdkToolsMode === 'off') {
      sessionOptions.allowedTools = [...RELATIONSHIP_ALLOWED_CLIENT_TOOLS];
    } else if (payload.sdkToolsMode === 'read-only') {
      sessionOptions.allowedTools = [...readOnlyTools, ...RELATIONSHIP_ALLOWED_CLIENT_TOOLS];
    }
    // full mode deliberately leaves client-side tool access unrestricted.
    // The live agent's server-side memory/guidance tools remain available in
    // every mode and are not blocked by the relationship-memory policy.

    const liveMessage = appendTrustedRelationshipCatalog(
      payload.message,
      payload.canonicalMessages,
      durableAssistantIntents,
    );

    log(`Creating live SDK session for conversation ${payload.conversationId} (mode: ${payload.sdkToolsMode})`);
    log(`  agent: ${payload.agentId}`);
    log(`  cwd: ${payload.cwd}`);
    log(`  relationship tools: ${RELATIONSHIP_ALLOWED_CLIENT_TOOLS.join(', ')}`);

    session = resumeSession(payload.conversationId, sessionOptions);
    await session.send(liveMessage);

    let assistantResponse = '';
    let messageCount = 0;
    for await (const msg of session.stream()) {
      messageCount += 1;
      if (msg.type === 'assistant' && msg.content) {
        assistantResponse += msg.content;
        log(`  Assistant chunk: ${msg.content.substring(0, 100)}...`);
      } else if (msg.type === 'tool_call') {
        log(`  Tool call: ${(msg as any).toolName}`);
      } else if (msg.type === 'error') {
        sessionSucceeded = false;
        log(`  Error: ${(msg as any).message}`);
      }
    }
    log(`Live stream complete: ${messageCount} messages, assistant response: ${assistantResponse.length} chars`);
  } catch (error) {
    sessionSucceeded = false;
    log(`Live Subconscious SDK failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (session) {
      session.close();
      log('SDK session closed');
    }
  }

  const completion = runtime.store.withMutationBoundary(() => runtime.finalizeBatch(payload.batchId, sessionSucceeded));
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
  log(`SDK Worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: SdkPayload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
    log(`Loaded payload for session ${payload.sessionId}`);

    let completion: 'completed' | 'retryable_failure';
    try {
      completion = await sendViaSdk(payload);
    } catch (error) {
      log(`SDK session failed before trusted batch completion: ${error instanceof Error ? error.message : String(error)}`);
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
    log('SDK Worker completed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) log(`Stack: ${error.stack}`);
    process.exit(1);
  }
}

main();
