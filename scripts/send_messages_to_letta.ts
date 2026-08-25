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
import { readForegroundRecallTurnStateForMessage } from './foreground_recall_state.js';

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
This is the normal asynchronous Subconscious pass after a foreground Kohaku turn. Maintain long-term relationship memory, and perform foreground recall only as a fallback when the synchronous foreground lane did not already resolve that exact user turn.

1. FOREGROUND RECALL FALLBACK
- The runtime may append a trusted <foreground_recall_receipt_catalog> after this envelope. Each entry is bound to a real transcript user message_id; it records what the synchronous foreground recall lane searched and whether it explicitly selected a memory, selected none, or failed.
- A receipt with decision=selected or decision=none means recall for that exact foreground user turn was already resolved. Do not repeat episodic search or queue another whisper merely because the same memory/topic appears in maintenance. The runtime may remove deliver_whisper from this pass when the latest foreground turn is already resolved.
- decision=selected is only a foreground continuity decision. It is NOT evidence that the memory should be reinforced, revised, or otherwise weighted more strongly. decision=none is also a successful recall outcome, not evidence that no long-term maintenance is needed.
- If the latest user turn has no receipt or decision=failed, you may use relationship memory_search as a fallback when a past moment would genuinely help continuity on a later foreground turn. Generate a compact semantic query; do not mechanically copy the whole user message. Additional searches are allowed only when they answer a materially different recall/canonicalization question.
- Before fallback episodic recall, ground identity only when needed: if a clearly named referent matters to understanding the current relationship context but <latest_user_message> plus the trusted current batch do not establish who or what it is, call entity_search with that natural referent and purpose=foreground_grounding first. Use purpose=maintenance instead for alias/dedupe checks or other entity maintenance.
- Do not call entity_search merely because a name appears. If current context already resolves the referent, do not repeat an identity anchor the foreground already has. When exactly one distinct concise foreground-grounding entity is resolved, the runtime may preserve that factual identity anchor separately; maintenance searches and multiple distinct foreground identities do not auto-inject identity.
- For fallback surfacing, treat returned relationship memories as candidates. Each hit contains quote_snippets with source-faithful historical excerpts. source_kind=transcript is a direct historical quote; source_kind=legacy_memory is only a fallback for a memory with no transcript evidence and is an older memory-record excerpt, not a direct quote.
- If something genuinely useful surfaced and deliver_whisper is available, call deliver_whisper once with one searched memory_id and 1-3 snippet_ids from that memory. Prefer the fewest quotes that let the moment stand on its own; the runtime renders the selected source excerpts with provenance-appropriate labels. If nothing useful surfaced, silence is correct.
- Retrieval itself supplies the association. Never explain why a memory matters now, infer relationship meaning, or tell foreground Kohaku what to feel. A whisper must never expose search/write bookkeeping.

2. SILENT LONG-TERM MEMORY MAINTENANCE
- Read the full trusted current-batch transcript and the receipt catalog together, but keep their roles separate: transcript evidence can justify memory writes; foreground receipts are only retrieval/selection history.
- Do NOT reinforce a memory merely because foreground selected or emitted it. surface != reinforce. Reinforce only when trusted current-batch evidence is genuinely another instance of the same underlying episode/event or the same explicit stable preference.
- Use memory_search when you actually need canonical lookup: same-event/same-preference verification, dedupe, related-memory linking, or another ambiguous maintenance decision. There is no search quota and no requirement to repeat a search already performed by foreground just to satisfy this pass.
- If the receipt points at a memory_id but the full turn introduces materially new semantics, or you need to verify sameness/current canonical state before writing, perform a maintenance search. A receipt is a hint, never a substitute for evidence.
- entity_search miss is not permission to invent an identity. Call entity_remember only when trusted current-batch conversation itself clearly defines or supports the stable identity; a bare name mention, guess, or episodic association must remain unresolved rather than becoming a canonical entity.
- Perform memory_reinforce / memory_remember / entity operations only as warranted by trusted current-batch evidence. This work is private maintenance.
- Never report maintenance decisions in deliver_whisper, ordinary prose, guidance, or any other foreground-visible channel.

The foreground sees only explicit deliver_whisper output. Ordinary assistant prose from this background pass is not a whisper and will not be injected.
</instructions>
</claude_code_session_update>`;

    const payloadFile = path.join(TEMP_STATE_DIR, `payload-${hookInput.session_id}-${Date.now()}.json`);
    const stateFile = getSyncStateFile(hookInput.cwd, hookInput.session_id);

    const batchId = makeBatchId(hookInput.session_id, state.lastProcessedIndex, messages.length - 1);
    const canonicalMessages = buildCanonicalMessages(messages, state.lastProcessedIndex, conversationId);
    log(`Relationship-memory batch: ${batchId} (${canonicalMessages.length} canonical evidence messages)`);
    const userMessageIds = [...new Set(canonicalMessages
      .filter((item) => item.role === 'user' && item.event_kind === 'user_text')
      .map((item) => item.message_id))];
    const foregroundRecallTurns = userMessageIds.flatMap((messageId) => {
      const turnState = readForegroundRecallTurnStateForMessage(hookInput.cwd, hookInput.session_id, messageId);
      if (!turnState) return [];
      return [{
        message_id: messageId,
        turn_id: turnState.binding.turn_id,
        ...(turnState.bundle ? { bundle: turnState.bundle } : {}),
        ...(turnState.receipt ? { receipt: turnState.receipt } : {}),
        delivery_state: turnState.delivery_state,
      }];
    });
    const latestUserMessageId = [...canonicalMessages].reverse()
      .find((item) => item.role === 'user' && item.event_kind === 'user_text')?.message_id;
    log(`Foreground recall receipt coverage: ${foregroundRecallTurns.length}/${userMessageIds.length} user message(s)`);

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
      ...(latestUserMessageId ? { latestUserMessageId } : {}),
      ...(foregroundRecallTurns.length ? { foregroundRecallTurns } : {}),
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
