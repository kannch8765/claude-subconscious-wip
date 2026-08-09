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
import { cursorShouldAdvance } from '../relationship-memory/src/tools/index.js';
import { runRelationshipObserverBatch } from './relationship_observer_runner.js';

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
  return runRelationshipObserverBatch({
    agentId: payload.agentId,
    conversationId: payload.conversationId,
    message: payload.message,
    cwd: payload.cwd,
    batchId: payload.batchId,
    canonicalMessages: payload.canonicalMessages,
    assistantIntents: payload.assistantIntents ?? [],
    log,
  });
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
