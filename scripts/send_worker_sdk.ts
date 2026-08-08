#!/usr/bin/env npx tsx
/**
 * SDK-based background worker that sends messages to Letta via Letta Code SDK.
 * Gives the Subconscious agent client-side tool access (Read, Grep, Glob, etc.).
 *
 * Spawned by send_messages_to_letta.ts as a detached process.
 * Falls back gracefully if the SDK is not available.
 *
 * Usage: npx tsx send_worker_sdk.ts <payload_file>
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AssistantRememberIntentRecord, CanonicalMessage } from '../relationship-memory/src/schema/index.js';
import { appendTrustedRelationshipCatalog, buildRelationshipTools, createRuntime, FORBIDDEN_MARKDOWN_MEMORY_TOOLS, relationshipMemoryRoot, RELATIONSHIP_ALLOWED_CLIENT_TOOLS } from '../relationship-memory/src/adapter/index.js';
import { cursorShouldAdvance } from '../relationship-memory/src/tools/index.js';
import { rebuildProjection } from '../relationship-memory/src/projection/index.js';
import { stableJson } from '../relationship-memory/src/store/index.js';
import { buildLettaApiUrl } from './letta_api_url.js';

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
  log(`Projection revision synchronized: ${projection.revision}`);
}

async function sendViaSdk(payload: SdkPayload): Promise<'completed' | 'retryable_failure'> {
  const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
  const assistantIntents = payload.assistantIntents ?? [];
  const runtime = createRuntime(payload.canonicalMessages, subjectId, relationshipMemoryRoot(), assistantIntents);
  runtime.store.beginBatch(payload.batchId, new Date().toISOString());

  let session: any = null;
  let sessionSucceeded = true;

  try {
    log(`Loading Letta Code SDK...`);
    const { resumeSession, jsonResult } = await import('@letta-ai/letta-code-sdk');
    const relationshipTools = buildRelationshipTools(runtime, payload.batchId, jsonResult);
    const blockedTools = [
      'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
      ...FORBIDDEN_MARKDOWN_MEMORY_TOOLS,
    ];
    const sessionOptions: Record<string, unknown> = {
      disallowedTools: blockedTools,
      allowedTools: [...RELATIONSHIP_ALLOWED_CLIENT_TOOLS],
      tools: relationshipTools,
      permissionMode: 'bypassPermissions',
      cwd: payload.cwd,
      skillSources: [],
      systemInfoReminder: false,
      sleeptime: { trigger: 'off' },
      memfsStartup: 'skip',
    };

    log(`Creating SDK session for conversation ${payload.conversationId} (relationship-memory batch ${payload.batchId})`);
    log(`  agent: ${payload.agentId}`);
    log(`  cwd: ${payload.cwd}`);
    log(`  allowedTools: ${RELATIONSHIP_ALLOWED_CLIENT_TOOLS.join(', ')}`);

    session = resumeSession(payload.conversationId, sessionOptions);
    const durableAssistantIntents = assistantIntents.map((intent) => {
      const stored = runtime.store.getAssistantIntent(intent.intent_id);
      if (!stored || stableJson(stored) !== stableJson(intent)) {
        throw new Error(`Trusted assistant intent payload/store mismatch: ${intent.intent_id}`);
      }
      return stored;
    });
    const observerMessage = appendTrustedRelationshipCatalog(payload.message, payload.canonicalMessages, durableAssistantIntents);
    log(`Sending message (${observerMessage.length} chars, ${payload.canonicalMessages.length} trusted evidence choices, ${durableAssistantIntents.length} trusted assistant intents)...`);
    await session.send(observerMessage);

    let assistantResponse = '';
    let messageCount = 0;
    for await (const msg of session.stream()) {
      messageCount++;
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
    log(`Stream complete: ${messageCount} messages, assistant response: ${assistantResponse.length} chars`);
  } catch (error) {
    sessionSucceeded = false;
    log(`  Session failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (session) {
      session.close();
      log('SDK session closed');
    }
  }

  const completion = runtime.finalizeBatch(payload.batchId, sessionSucceeded);
  log(`Relationship-memory batch finalized: ${completion}`);
  if (completion === 'completed') {
    const apiKey = process.env.LETTA_API_KEY;
    if (apiKey) {
      try { await syncProjectionBlocks(apiKey, payload.agentId, runtime); }
      catch (error) { log(`Projection sync deferred: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
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
