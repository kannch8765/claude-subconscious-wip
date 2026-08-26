#!/usr/bin/env tsx
/**
 * Letta Memory Sync Script
 * 
 * Syncs Letta agent memory blocks to the project's CLAUDE.md file.
 * This script is designed to run as a Claude Code UserPromptSubmit hook.
 * 
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_AGENT_ID - Agent ID to fetch memory blocks from
 *   CLAUDE_PROJECT_DIR - Project directory (set by Claude Code)
 *   LETTA_DEBUG - Set to "1" to enable debug logging to stderr
 * 
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error (logged to stderr)
 *   2 - Blocking error (prevents prompt processing)
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { getAgentId } from './agent_config.js';
import { mirrorSubconVisibility } from './subcon_visibility_mirror.js';
import { acknowledgePendingSubconWhispers, discardPendingSubconWhispers, formatPendingSubconWhispers, partitionPendingSubconWhispersForCheckpoint, partitionPendingSubconWhispersForTurn, readPendingSubconWhispers } from './subcon_whisper_queue.js';
import { bindForegroundRecallTurnToMessage } from './foreground_recall_state.js';
import { findLatestUserMessageUuidForPrompt } from './transcript_utils.js';
import { runForegroundSyncForHook } from './foreground_sync_hook.js';
import {
  loadSyncState,
  saveSyncState,
  lookupConversation,
  SyncState,
  Agent,
  MemoryBlock,
  fetchAgent,
  escapeXmlContent,
  formatAllBlocksForStdout,
  cleanLettaFromClaudeMd,
  getMode,
} from './conversation_utils.js';

// Configuration
const DEBUG = process.env.LETTA_DEBUG === '1';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.error('[sync debug]', ...args);
  }
}


interface HookInput {
  session_id: string;
  cwd: string;
  prompt?: string;  // User's prompt text (available on UserPromptSubmit)
  transcript_path?: string;  // Path to transcript JSONL
  context?: string;
  hook_event_name?: string;
}


/**
 * Read hook input from stdin
 */
async function readHookInput(): Promise<HookInput | null> {
  return new Promise((resolve) => {
    let input = '';
    const rl = readline.createInterface({ input: process.stdin });
    
    rl.on('line', (line) => {
      input += line;
    });
    
    rl.on('close', () => {
      if (!input.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(input));
      } catch {
        resolve(null);
      }
    });

    // Timeout after 100ms if no input
    setTimeout(() => {
      rl.close();
    }, 100);
  });
}

function expectedSyncTurnId(hookInput: HookInput | null): string | undefined {
  const isUserPrompt = hookInput?.hook_event_name === 'UserPromptSubmit' || typeof hookInput?.prompt === 'string';
  if (!isUserPrompt) return undefined;
  const marker = process.env.SUBCON_SYNC_EXPECTED_TURN_FILE;
  if (!marker) return undefined;
  try {
    const turnId = fs.readFileSync(marker, 'utf8').trim();
    try { fs.unlinkSync(marker); } catch {}
    return turnId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect which blocks have changed since last sync
 */
function detectChangedBlocks(
  currentBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): MemoryBlock[] {
  // First sync - no previous state, don't show all blocks as "changed"
  if (!lastBlockValues) {
    return [];
  }
  
  return currentBlocks.filter(block => {
    const previousValue = lastBlockValues[block.label];
    // Changed if: new block (not in previous) or value differs
    return previousValue === undefined || previousValue !== block.value;
  });
}

/**
 * Compute a simple line-based diff between two strings
 */
function computeDiff(oldValue: string, newValue: string): { added: string[], removed: string[] } {
  const oldLines = oldValue.split('\n').map(l => l.trim()).filter(l => l);
  const newLines = newValue.split('\n').map(l => l.trim()).filter(l => l);
  
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  
  const added = newLines.filter(line => !oldSet.has(line));
  const removed = oldLines.filter(line => !newSet.has(line));
  
  return { added, removed };
}

/**
 * Format changed blocks for stdout injection with diffs
 */
function formatChangedBlocksForStdout(
  changedBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): string {
  if (changedBlocks.length === 0) {
    return '';
  }
  
  const formatted = changedBlocks.map(block => {
    const previousValue = lastBlockValues?.[block.label];
    
    // New block - show full content
    if (previousValue === undefined) {
      const escapedContent = escapeXmlContent(block.value || '');
      return `<${block.label} status="new">\n${escapedContent}\n</${block.label}>`;
    }
    
    // Existing block - show diff
    const diff = computeDiff(previousValue, block.value || '');
    
    if (diff.added.length === 0 && diff.removed.length === 0) {
      // Whitespace-only change, show full content
      const escapedContent = escapeXmlContent(block.value || '');
      return `<${block.label} status="modified">\n${escapedContent}\n</${block.label}>`;
    }
    
    const diffLines: string[] = [];
    for (const line of diff.removed) {
      diffLines.push(`- ${escapeXmlContent(line)}`);
    }
    for (const line of diff.added) {
      diffLines.push(`+ ${escapeXmlContent(line)}`);
    }
    
    return `<${block.label} status="modified">\n${diffLines.join('\n')}\n</${block.label}>`;
  }).join('\n');
  
  return `<letta_memory_update>
<!-- Memory blocks updated since last prompt (showing diff) -->
${formatted}
</letta_memory_update>`;
}


/**
 * Main function
 */
async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    const hookInput = await readHookInput();
    const cwd = hookInput?.cwd || projectDir;
    const sessionId = hookInput?.session_id;
    const foregroundSync = await runForegroundSyncForHook(hookInput, cwd);
    if (foregroundSync) debug('foreground sync v2 completed', {
      status: foregroundSync.status,
      turn_id: foregroundSync.turn_id,
      bundle_ready_ms: foregroundSync.bundle_ready_ms,
      resolve_recall_ms: foregroundSync.resolve_recall_ms,
      foreground_release_ms: foregroundSync.foreground_release_ms,
      hook_elapsed_ms: foregroundSync.hook_elapsed_ms,
    });
    const allPendingWhispers = sessionId ? readPendingSubconWhispers(cwd, sessionId) : [];
    const legacyExpectedTurnId = expectedSyncTurnId(hookInput);
    // v2 never derives transcript identity from prompt text. Its opaque turn is
    // registered before sync work and bound later by Stop once transcript UUIDs
    // are authoritative. Keep the text lookup only for the legacy marker path.
    if (!foregroundSync && sessionId && legacyExpectedTurnId && typeof hookInput?.prompt === 'string') {
      try {
        const messageId = hookInput.transcript_path
          ? findLatestUserMessageUuidForPrompt(hookInput.transcript_path, hookInput.prompt)
          : undefined;
        if (messageId) bindForegroundRecallTurnToMessage(cwd, sessionId, legacyExpectedTurnId, messageId);
      } catch (error) {
        debug('Legacy foreground recall binding failed; continuing without receipt reuse', error);
      }
    }
    const authorizedWhisperId = foregroundSync?.status === 'whisper' ? foregroundSync.whisper_id : undefined;
    const partitioned = foregroundSync
      ? partitionPendingSubconWhispersForCheckpoint(allPendingWhispers, foregroundSync.turn_id, authorizedWhisperId)
      : partitionPendingSubconWhispersForTurn(allPendingWhispers, legacyExpectedTurnId);
    const pendingWhispers = partitioned.deliverable;
    const staleSyncWhispers = partitioned.staleSync;
    // Retraction is part of foreground release authority, not post-injection
    // acknowledgement. Do it before any later API/block-sync failure can return.
    if (staleSyncWhispers.length > 0) discardPendingSubconWhispers(staleSyncWhispers);

    // Whisper mode is a local transport only: background Subcon explicitly wrote
    // deliver_whisper payloads into the durable queue. Do not contact Letta, fetch
    // agent state, or inspect conversation history on the foreground hot path.
    if (mode === 'whisper') {
      cleanLettaFromClaudeMd(cwd);
      const injectionPayload = formatPendingSubconWhispers(pendingWhispers);
      if (sessionId && injectionPayload) {
        mirrorSubconVisibility({ sessionId, phase: 'user_prompt', payload: injectionPayload });
      }
      if (injectionPayload) console.log(injectionPayload);
      if (pendingWhispers.length > 0) acknowledgePendingSubconWhispers(pendingWhispers);
      return;
    }

    // Full mode retains working-memory block synchronization in addition to the
    // dedicated whisper queue, so it still requires Letta agent access.
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) {
      console.error('Error: LETTA_API_KEY environment variable is not set');
      process.exit(1);
    }

    const agentId = await getAgentId(apiKey);
    let state: SyncState | null = null;
    if (sessionId) state = loadSyncState(cwd, sessionId);

    let conversationId = state?.conversationId || null;
    if (!conversationId && sessionId) {
      conversationId = lookupConversation(cwd, sessionId);
      if (conversationId && state) state.conversationId = conversationId;
    }
    const lastBlockValues = state?.lastBlockValues || null;
    const agent = await fetchAgent(apiKey, agentId);
    const changedBlocks = detectChangedBlocks(agent.blocks || [], lastBlockValues);

    cleanLettaFromClaudeMd(cwd);
    if (state) {
      state.lastBlockValues = {};
      for (const block of agent.blocks || []) state.lastBlockValues[block.label] = block.value;
    }

    const outputs: string[] = [];
    const isFirstPrompt = !lastBlockValues;
    if (isFirstPrompt) {
      outputs.push(formatAllBlocksForStdout(agent, conversationId));
    } else {
      const changedBlocksOutput = formatChangedBlocksForStdout(changedBlocks, lastBlockValues);
      if (changedBlocksOutput) outputs.push(changedBlocksOutput);
    }
    const messageOutput = formatPendingSubconWhispers(pendingWhispers);
    if (messageOutput) outputs.push(messageOutput);

    const injectionPayload = outputs.join('\n\n');
    // Complete all fallible local state work before stdout + delivery marker. Once
    // a sync whisper is marked emitted, no later exception should turn this hook
    // into a nonzero result whose stdout may be discarded by the host.
    if (state && sessionId) saveSyncState(cwd, state);
    if (sessionId && injectionPayload) {
      mirrorSubconVisibility({ sessionId, phase: 'user_prompt', payload: injectionPayload });
    }
    if (injectionPayload) console.log(injectionPayload);
    if (pendingWhispers.length > 0) acknowledgePendingSubconWhispers(pendingWhispers);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error syncing Letta memory: ${errorMessage}`);
    process.exit(1);
  }
}

// Run main function
main();
