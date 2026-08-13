#!/usr/bin/env tsx
/**
 * PreToolUse Memory Sync Script
 * 
 * Lightweight hook that checks for Letta agent updates mid-workflow.
 * Runs before each tool use to inject any new messages or memory changes.
 * 
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_DEBUG - Set to "1" to enable debug logging
 * 
 * Exit Codes:
 *   0 - Success (no output = no updates, JSON output = updates to inject)
 *   1 - Non-blocking error
 */

import * as readline from 'readline';
import { getAgentId } from './agent_config.js';
import { mirrorSubconVisibility } from './subcon_visibility_mirror.js';
import { acknowledgePendingSubconWhispers, formatPendingSubconWhispers, readPendingSubconWhispers } from './subcon_whisper_queue.js';
import { buildLettaApiUrl } from './letta_api_url.js';
import {
  loadSyncState,
  saveSyncState,
  getMode,
} from './conversation_utils.js';

const DEBUG = process.env.LETTA_DEBUG === '1';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.error('[pretool debug]', ...args);
  }
}

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
}

interface MemoryBlock {
  label: string;
  value: string;
}

interface Agent {
  id: string;
  name: string;
  blocks: MemoryBlock[];
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

    setTimeout(() => {
      rl.close();
    }, 100);
  });
}

/**
 * Fetch agent data from Letta API
 */
async function fetchAgent(apiKey: string, agentId: string): Promise<Agent> {
  const url = buildLettaApiUrl(`/agents/${agentId}`, {
    include: 'agent.blocks',
  });
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Letta API error (${response.status})`);
  }

  return response.json();
}


/**
 * Detect changed memory blocks
 */
function detectChangedBlocks(
  currentBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): MemoryBlock[] {
  if (!lastBlockValues) {
    return [];
  }
  
  return currentBlocks.filter(block => {
    const previousValue = lastBlockValues[block.label];
    return previousValue === undefined || previousValue !== block.value;
  });
}

/**
 * Format output for PreToolUse additionalContext
 */
function formatOutput(
  changedBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): string {
  const parts: string[] = [];

  // Format changed blocks with diffs
  if (changedBlocks.length > 0) {
    const blockParts = changedBlocks.map(block => {
      const previousValue = lastBlockValues?.[block.label];
      
      if (previousValue === undefined) {
        return `<${block.label} status="new">\n${block.value}\n</${block.label}>`;
      }
      
      // Simple diff: show what changed
      const oldLines = new Set(previousValue.split('\n').map(l => l.trim()).filter(l => l));
      const newLines = block.value.split('\n').map(l => l.trim()).filter(l => l);
      
      const added = newLines.filter(line => !oldLines.has(line));
      const removed = Array.from(oldLines).filter(line => !newLines.includes(line));
      
      if (added.length === 0 && removed.length === 0) {
        return `<${block.label} status="modified">\n${block.value}\n</${block.label}>`;
      }
      
      const diffLines: string[] = [];
      for (const line of removed) {
        diffLines.push(`- ${line}`);
      }
      for (const line of added) {
        diffLines.push(`+ ${line}`);
      }
      
      return `<${block.label} status="modified">\n${diffLines.join('\n')}\n</${block.label}>`;
    });
    
    parts.push(`<letta_memory_update>\n${blockParts.join('\n')}\n</letta_memory_update>`);
  }

  return parts.join('\n\n');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  try {
    const hookInput = await readHookInput();
    
    if (!hookInput?.session_id || !hookInput?.cwd) {
      debug('Missing session_id or cwd, skipping');
      process.exit(0);
    }

    debug(`PreToolUse for tool: ${hookInput.tool_name}`);

    // Load state
    const state = loadSyncState(hookInput.cwd, hookInput.session_id);
    
    const pendingWhispers = readPendingSubconWhispers(hookInput.cwd, hookInput.session_id);
    let agent: Agent | null = null;
    let changedBlocks: MemoryBlock[] = [];

    // Raw Letta assistant messages are private background reasoning. Full mode may
    // additionally expose working-memory block diffs, but never maintenance prose.
    if (mode === 'full') {
      const apiKey = process.env.LETTA_API_KEY;
      if (!apiKey) {
        debug('No LETTA_API_KEY set for full mode, skipping block synchronization');
      } else {
        const agentId = await getAgentId(apiKey);
        agent = await fetchAgent(apiKey, agentId);
        changedBlocks = detectChangedBlocks(agent.blocks || [], state.lastBlockValues || null);
      }
    }

    debug(`Pending whispers: ${pendingWhispers.length}, Changed blocks: ${changedBlocks.length}`);
    if (pendingWhispers.length === 0 && changedBlocks.length === 0) {
      debug('No updates, exiting silently');
      process.exit(0);
    }

    const parts: string[] = [];
    const whisperOutput = formatPendingSubconWhispers(pendingWhispers);
    if (whisperOutput) parts.push(whisperOutput);
    if (mode === 'full' && agent && changedBlocks.length > 0) {
      parts.push(formatOutput(changedBlocks, state.lastBlockValues || null));
    }
    const additionalContext = parts.join('\n\n');

    if (agent?.blocks) {
      state.lastBlockValues = {};
      for (const block of agent.blocks) state.lastBlockValues[block.label] = block.value;
    }
    saveSyncState(hookInput.cwd, state);

    // Inject Subcon updates as context only. Visibility is handled by the dedicated UI section;
    // do not force the foreground Claude to repeat Subcon messages.
    const contextWithInstruction = `<letta_update>\n${additionalContext}\n</letta_update>`;

    // Output JSON for PreToolUse
    const output: Record<string, unknown> = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contextWithInstruction,
      },
    };

    mirrorSubconVisibility({
      sessionId: hookInput.session_id,
      phase: 'pre_tool',
      payload: contextWithInstruction,
    });
    console.log(JSON.stringify(output));
    if (pendingWhispers.length > 0) acknowledgePendingSubconWhispers(pendingWhispers);
    
  } catch (error) {
    debug(`Error: ${error}`);
    // Non-blocking - just exit silently
    process.exit(0);
  }
}

main();
