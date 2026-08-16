#!/usr/bin/env npx tsx
/**
 * Send Messages to Letta Script
 * 
 * Sends Claude Code conversation messages to a Letta agent.
 * This script is designed to run as a Claude Code Stop hook.
 * 
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_AGENT_ID - Agent ID to send messages to
 * 
 * Hook Input (via stdin):
 *   - session_id: Current session ID
 *   - transcript_path: Path to conversation JSONL file
 *   - stop_hook_active: Whether stop hook is already active
 * 
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error
 * 
 * Log file: $TMPDIR/letta-claude-sync-$UID/send_messages.log
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentId } from './agent_config.js';
import {
  loadSyncState,
  saveSyncState,
  getOrCreateConversation,
  getSyncStateFile,
  spawnSilentWorker,
  getMode,
  getTempStateDir,
} from './conversation_utils.js';
import {
  readTranscript,
  formatMessagesForLetta,
} from './transcript_utils.js';
import { buildCanonicalMessages, makeBatchId, relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { extractAssistantRememberIntents, persistAssistantRememberIntents } from '../relationship-memory/src/intent/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_messages.log');

interface HookInput {
  session_id: string;
  transcript_path: string;
  stop_hook_active?: boolean;
  cwd: string;
  hook_event_name?: string;
}

function ensureLogDir(): void {
  if (!fs.existsSync(TEMP_STATE_DIR)) fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });
}

function log(message: string): void {
  ensureLogDir();
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function readHookInput(): Promise<HookInput> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) data += chunk;
    });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`Failed to parse hook input: ${e}`)); }
    });
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  log('='.repeat(60));
  log('send_messages_to_letta.ts started');

  const mode = getMode();
  log(`Mode: ${mode}`);
  if (mode === 'off') {
    log('Mode is off, exiting');
    process.exit(0);
  }
  try {
    log('Reading hook input from stdin...');
    const hookInput = await readHookInput();
    log(`Hook input received:`);
    log(`  session_id: ${hookInput.session_id}`);
    log(`  transcript_path: ${hookInput.transcript_path}`);
    log(`  stop_hook_active: ${hookInput.stop_hook_active}`);
    log(`  hook_event_name: ${hookInput.hook_event_name}`);
    log(`  cwd: ${hookInput.cwd}`);

    if (hookInput.stop_hook_active) {
      log('Stop hook already active, exiting to prevent loop');
      process.exit(0);
    }

    log(`Reading transcript from: ${hookInput.transcript_path}`);
    const messages = await readTranscript(hookInput.transcript_path, log);
    log(`Found ${messages.length} messages in transcript`);
    if (messages.length === 0) {
      log('No messages found, exiting');
      process.exit(0);
    }

    const typeCounts: Record<string, number> = {};
    for (const msg of messages) {
      const key = msg.type || msg.role || 'unknown';
      typeCounts[key] = (typeCounts[key] || 0) + 1;
    }
    log(`Message types: ${JSON.stringify(typeCounts)}`);

    const state = loadSyncState(hookInput.cwd, hookInput.session_id, log);

    // Persist first-party assistant remember intent before any Letta/model dependency.
    // Replays are idempotent because identity is bound to the real transcript tool_use.
    const subjectId = process.env.RELATIONSHIP_MEMORY_SUBJECT_ID || 'local-user';
    const intentStore = new RelationshipMemoryStore(relationshipMemoryRoot(), subjectId);
    const assistantIntents = persistAssistantRememberIntents(
      intentStore,
      extractAssistantRememberIntents(messages, state.lastProcessedIndex, hookInput.session_id, subjectId),
    );
    log(`Persisted/verified ${assistantIntents.length} trusted assistant remember intent(s)`);

    const newMessages = formatMessagesForLetta(messages, state.lastProcessedIndex, log);
    if (newMessages.length === 0) {
      log('No new messages to send after formatting');
      process.exit(0);
    }

    const apiKey = process.env.LETTA_API_KEY;
    log(`LETTA_API_KEY: ${apiKey ? 'set' : 'NOT SET'}`);
    if (!apiKey) {
      log('ERROR: LETTA_API_KEY not set after trusted intent extraction');
      console.error('Error: LETTA_API_KEY must be set');
      process.exit(1);
    }
    const agentId = await getAgentId(apiKey, log);
    log(`Using agent: ${agentId}`);

    const conversationId = await getOrCreateConversation(apiKey, agentId, hookInput.session_id, hookInput.cwd, state, log);
    log(`Using conversation: ${conversationId}`);
    saveSyncState(hookInput.cwd, state, log);

    const transcriptEntries = newMessages.map(m => {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'claude_code' : 'system';
      const escaped = m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<message role="${role}">\n${escaped}\n</message>`;
    }).join('\n');
    const latestUserMessage = [...newMessages].reverse().find((message) => message.role === 'user')?.text.trim() || '';
    const latestUserEscaped = latestUserMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const userMessage = `<claude_code_session_update>
<session_id>${hookInput.session_id}</session_id>

<transcript>
${transcriptEntries}
</transcript>

<latest_user_message>
${latestUserEscaped}
</latest_user_message>

<instructions>
This is the normal asynchronous Subconscious pass after a foreground Kohaku turn. Do both jobs in one pass:

1. MEMORY SURFACING FOR THE NEXT FOREGROUND TURN
- Read <latest_user_message> together with the trusted current-batch transcript context, then choose and call relationship memory_search yourself. Generate a compact semantic query for what is meaningfully being recalled; do not mechanically copy the whole user message, emoji, or surface punctuation when a cleaner concept query is available.
- Every live pass that contains a real <latest_user_message> must complete at least one relationship memory_search before ending. This is a hard behavior boundary, not optional guidance.
- You may issue additional memory_search calls after seeing earlier results when a narrower, broader, or differently phrased semantic search would improve recall.
- Treat returned relationship memories as associations surfacing into Kohaku's subconscious. Select only context genuinely useful for continuity on the next foreground turn.
- If something useful surfaced, call deliver_whisper once with a compact memory seed: concrete facts, time/place anchors when known, and a short source-faithful user quote when it materially carries the memory. Preserve first-person Kohaku only for factual self-reference (for example, what I did or said). Do not complete Kohaku's present-day interpretation for her: do not add what the memory means now, how I should feel about it, or a relationship conclusion that is not itself part of the remembered evidence. Example: "[7/05] 猫因为 200k context 的限制哭了。猫说：‘无论 model、time、state，这里是我们的家。’"
- If nothing useful surfaced, do not call deliver_whisper. Silence is correct.
- A whisper must never mention memory_search, IDs, evidence, reinforce/remember/create/dedupe, archival status, or whether anything deserves storage.

2. SILENT LONG-TERM MEMORY MAINTENANCE
- Reuse relevant relationship search results when applicable to decide whether trusted new evidence should reinforce an existing relationship memory, create a genuinely new durable memory, or do nothing.
- Perform memory_reinforce / memory_remember / entity operations as needed. This work is private maintenance.
- Never report maintenance decisions in deliver_whisper, ordinary prose, guidance, or any other foreground-visible channel.

The foreground sees only explicit deliver_whisper output. Ordinary assistant prose from this background pass is not a whisper and will not be injected.
</instructions>
</claude_code_session_update>`;

    const payloadFile = path.join(TEMP_STATE_DIR, `payload-${hookInput.session_id}-${Date.now()}.json`);
    const stateFile = getSyncStateFile(hookInput.cwd, hookInput.session_id);

    const batchId = makeBatchId(hookInput.session_id, state.lastProcessedIndex, messages.length - 1);
    const canonicalMessages = buildCanonicalMessages(messages, state.lastProcessedIndex, conversationId);
    log(`Relationship-memory batch: ${batchId} (${canonicalMessages.length} canonical evidence messages)`);

    const nativePayload = {
      agentId,
      conversationId,
      sessionId: hookInput.session_id,
      message: userMessage,
      stateFile,
      newLastProcessedIndex: messages.length - 1,
      cwd: hookInput.cwd,
      batchId,
      canonicalMessages,
      assistantIntents,
      latestUserMessage,
    };
    fs.writeFileSync(payloadFile, JSON.stringify(nativePayload), 'utf-8');
    log(`Wrote native live payload to ${payloadFile}`);

    const workerScript = path.join(__dirname, 'send_worker_native.ts');
    const child = spawnSilentWorker(workerScript, payloadFile, hookInput.cwd);
    log(`Spawned native live worker (PID: ${child.pid})`);
    log('Hook completed (worker running in background)');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) log(`Stack trace: ${error.stack}`);
    console.error(`Error sending messages to Letta: ${errorMessage}`);
    process.exit(1);
  }
}

main();
