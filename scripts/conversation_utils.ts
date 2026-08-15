/**
 * Shared conversation and state management utilities
 * Used by sync_letta_memory.ts, send_messages_to_letta.ts, and session_start.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildLettaApiUrl,
  LETTA_API_BASE,
} from './letta_api_url.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
export { LETTA_API_BASE };
// Only show app URL for hosted service; self-hosted users get IDs directly
const IS_HOSTED = !process.env.LETTA_BASE_URL;
const LETTA_APP_BASE = 'https://app.letta.com';

// CLAUDE.md constants
export const CLAUDE_MD_PATH = '.claude/CLAUDE.md';
export const LETTA_SECTION_START = '<letta>';
export const LETTA_SECTION_END = '</letta>';
const LETTA_CONTEXT_START = '<letta_context>';
const LETTA_CONTEXT_END = '</letta_context>';
const LETTA_MEMORY_START = '<letta_memory_blocks>';
const LETTA_MEMORY_END = '</letta_memory_blocks>';

// ============================================
// Mode Configuration
// ============================================

export type LettaMode = 'whisper' | 'full' | 'off';

/**
 * Get the current operating mode from LETTA_MODE env var.
 * - whisper (default): Only inject Sub's messages via stdout
 * - full: Inject full memory blocks + messages via stdout
 * - off: Disable all hooks
 *
 * No mode writes to CLAUDE.md.
 */
export function getMode(): LettaMode {
  const mode = process.env.LETTA_MODE?.toLowerCase();
  if (mode === 'full' || mode === 'off') return mode;
  return 'whisper';
}

/**
 * Get user-specific temp state directory for logs and payloads.
 * Uses os.tmpdir() with a UID suffix to avoid permission conflicts
 * when multiple users share the same machine.
 */
export function getTempStateDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
  return path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
}

// Types
export interface SyncState {
  lastProcessedIndex: number;
  sessionId: string;
  conversationId?: string;
  lastBlockValues?: { [label: string]: string };
  lastSeenMessageId?: string;  // Track last message ID we've shown to avoid duplicates
}

export interface ConversationRetryMarker {
  conversationId: string;
  throughIndex: number;
  markedAt: string;
}

export interface ConversationEntry {
  conversationId: string;
  agentId: string;
}

export interface ConversationsMap {
  [sessionId: string]: string | ConversationEntry;
}

export interface Conversation {
  id: string;
  agent_id: string;
  created_at?: string;
}

export type LogFn = (message: string) => void;

// Default no-op logger
const noopLog: LogFn = () => {};

/**
 * Expand common shell syntax in a path value.
 * Handles $HOME, ${HOME}, and ~ when set via settings.json (no shell expansion).
 */
export function expandPath(value: string): string {
  const home = os.homedir();
  if (value === '$HOME' || value === '${HOME}') return home;
  if (value.startsWith('$HOME/')) return path.join(home, value.slice(6));
  if (value.startsWith('${HOME}/')) return path.join(home, value.slice(8));
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/**
 * Get durable state directory path
 * If LETTA_HOME is set, use that as the base instead of cwd
 */
export function getDurableStateDir(cwd: string): string {
  const raw = process.env.LETTA_HOME || cwd;
  const base = process.env.LETTA_HOME ? expandPath(raw) : raw;
  return path.join(base, '.letta', 'claude');
}

/**
 * Get conversations map file path
 */
export function getConversationsFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'conversations.json');
}

/**
 * Get sync state file path for a session
 */
export function getSyncStateFile(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), `session-${sessionId}.json`);
}

/**
 * Get the durable retry marker used to rotate a poisoned live Letta conversation
 * without touching the transcript cursor from a detached worker.
 */
export function getConversationRetryMarkerFile(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), `session-${sessionId}.conversation-retry.json`);
}

/**
 * Ensure durable state directory exists
 */
export function ensureDurableStateDir(cwd: string): void {
  const dir = getDurableStateDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load sync state for a session
 */
export function loadSyncState(cwd: string, sessionId: string, log: LogFn = noopLog): SyncState {
  const statePath = getSyncStateFile(cwd, sessionId);
  
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      log(`Loaded state: lastProcessedIndex=${state.lastProcessedIndex}`);
      return state;
    } catch (e) {
      log(`Failed to load state: ${e}`);
    }
  }
  
  log(`No existing state, starting fresh`);
  return { lastProcessedIndex: -1, sessionId };
}

/**
 * Save sync state for a session
 */
export function saveSyncState(cwd: string, state: SyncState, log: LogFn = noopLog): void {
  ensureDurableStateDir(cwd);
  const statePath = getSyncStateFile(cwd, state.sessionId);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  log(`Saved state: lastProcessedIndex=${state.lastProcessedIndex}, conversationId=${state.conversationId}`);
}

/**
 * Load conversations mapping
 */
export function loadConversationsMap(cwd: string, log: LogFn = noopLog): ConversationsMap {
  const filePath = getConversationsFile(cwd);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      log(`Failed to load conversations map: ${e}`);
    }
  }
  return {};
}

/**
 * Save conversations mapping
 */
export function saveConversationsMap(cwd: string, map: ConversationsMap): void {
  ensureDurableStateDir(cwd);
  fs.writeFileSync(getConversationsFile(cwd), JSON.stringify(map, null, 2), 'utf-8');
}


function readConversationRetryMarker(cwd: string, sessionId: string, log: LogFn = noopLog): ConversationRetryMarker | null {
  const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as ConversationRetryMarker;
    if (typeof marker?.conversationId !== 'string' || !Number.isInteger(marker?.throughIndex)) {
      throw new Error('invalid conversation retry marker');
    }
    return marker;
  } catch (error) {
    log(`Failed to load conversation retry marker: ${error}`);
    return null;
  }
}

function clearConversationRetryMarker(cwd: string, sessionId: string): void {
  const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
  try { fs.unlinkSync(markerPath); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Mark one failed live conversation for rotation on the next Stop-hook replay.
 *
 * The marker is deliberately separate from session state so a detached worker
 * never read/modify/writes lastProcessedIndex merely to request a conversation
 * rotation. A later successful worker can advance the cursor normally; the
 * next hook will then discard this marker as stale.
 */
export function markConversationForRetryRotation(
  cwd: string,
  sessionId: string,
  conversationId: string,
  throughIndex: number,
  log: LogFn = noopLog,
): boolean {
  const state = loadSyncState(cwd, sessionId, log);
  if (state.lastProcessedIndex >= throughIndex) {
    log(`Conversation retry marker not needed: cursor already advanced through index ${throughIndex}`);
    return false;
  }
  if (state.conversationId && state.conversationId !== conversationId) {
    log(`Conversation retry marker not needed: live conversation already changed from ${conversationId} to ${state.conversationId}`);
    return false;
  }

  const existing = readConversationRetryMarker(cwd, sessionId, log);
  const marker: ConversationRetryMarker = {
    conversationId,
    throughIndex: existing?.conversationId === conversationId
      ? Math.max(existing.throughIndex, throughIndex)
      : throughIndex,
    markedAt: new Date().toISOString(),
  };

  ensureDurableStateDir(cwd);
  const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
  const tempPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(marker, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tempPath, markerPath);
  log(`Marked live conversation ${conversationId} for retry rotation through index ${marker.throughIndex}`);
  return true;
}

function conversationEntryDetails(entry: string | ConversationEntry | undefined): { conversationId: string; agentId: string | null } | null {
  if (!entry) return null;
  return typeof entry === 'string'
    ? { conversationId: entry, agentId: null }
    : { conversationId: entry.conversationId, agentId: entry.agentId };
}

/**
 * Create a new conversation for an agent
 */
export async function createConversation(apiKey: string, agentId: string, log: LogFn = noopLog): Promise<string> {
  const url = buildLettaApiUrl('/conversations/', { agent_id: agentId });
  
  log(`Creating new conversation for agent ${agentId}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create conversation: ${response.status} ${errorText}`);
  }

  const conversation: Conversation = await response.json();
  log(`Created conversation: ${conversation.id}`);
  return conversation.id;
}

/**
 * Get or create conversation for a session
 */
export async function getOrCreateConversation(
  apiKey: string,
  agentId: string,
  sessionId: string,
  cwd: string,
  state: SyncState,
  log: LogFn = noopLog
): Promise<string> {
  const retryMarker = readConversationRetryMarker(cwd, sessionId, log);
  if (retryMarker) {
    if (state.lastProcessedIndex >= retryMarker.throughIndex) {
      log(`Discarding stale conversation retry marker because cursor advanced through index ${retryMarker.throughIndex}`);
      clearConversationRetryMarker(cwd, sessionId);
    } else if (state.conversationId && state.conversationId !== retryMarker.conversationId) {
      log(`Discarding stale conversation retry marker because conversation already changed to ${state.conversationId}`);
      clearConversationRetryMarker(cwd, sessionId);
    } else {
      const conversationsMap = loadConversationsMap(cwd, log);
      const mapped = conversationEntryDetails(conversationsMap[sessionId]);

      // A manual or concurrent recovery may have updated the map before the
      // session state. Adopt that newer conversation rather than rotating twice.
      if (mapped && mapped.conversationId !== retryMarker.conversationId && (!mapped.agentId || mapped.agentId === agentId)) {
        state.conversationId = mapped.conversationId;
        saveSyncState(cwd, state, log);
        clearConversationRetryMarker(cwd, sessionId);
        log(`Adopted already-rotated live conversation ${mapped.conversationId} for retry`);
        return mapped.conversationId;
      }

      const conversationId = await createConversation(apiKey, agentId, log);
      conversationsMap[sessionId] = { conversationId, agentId };
      saveConversationsMap(cwd, conversationsMap);
      state.conversationId = conversationId;

      // Persist the new conversation before clearing the marker. If the process
      // dies between these writes, the surviving marker makes the next hook
      // recover deterministically instead of falling back to the poisoned ID.
      saveSyncState(cwd, state, log);
      clearConversationRetryMarker(cwd, sessionId);
      log(`Rotated live conversation ${retryMarker.conversationId} -> ${conversationId} before retrying held cursor through index ${retryMarker.throughIndex}`);
      return conversationId;
    }
  }

  // Check if we already have a conversation ID in state
  if (state.conversationId) {
    log(`Using existing conversation from state: ${state.conversationId}`);
    return state.conversationId;
  }

  // Check the conversations map
  const conversationsMap = loadConversationsMap(cwd, log);
  const cached = conversationsMap[sessionId];

  if (cached) {
    // Parse both old format (string) and new format (object)
    const entry = typeof cached === 'string'
      ? { conversationId: cached, agentId: null as string | null }
      : cached;

    if (entry.agentId && entry.agentId !== agentId) {
      // Agent ID changed - clear stale entry and create new conversation
      log(`Agent ID changed (${entry.agentId} -> ${agentId}), clearing stale conversation`);
      delete conversationsMap[sessionId];
      const conversationId = await createConversation(apiKey, agentId, log);
      conversationsMap[sessionId] = { conversationId, agentId };
      saveConversationsMap(cwd, conversationsMap);
      state.conversationId = conversationId;
      return conversationId;
    } else if (!entry.agentId) {
      // Old format without agentId - upgrade by recreating
      log(`Upgrading old format entry (no agentId stored), creating new conversation`);
      delete conversationsMap[sessionId];
      const conversationId = await createConversation(apiKey, agentId, log);
      conversationsMap[sessionId] = { conversationId, agentId };
      saveConversationsMap(cwd, conversationsMap);
      state.conversationId = conversationId;
      return conversationId;
    } else {
      // Valid entry with matching agentId - reuse
      log(`Found conversation in map: ${entry.conversationId}`);
      state.conversationId = entry.conversationId;
      return entry.conversationId;
    }
  }

  // No existing entry - create a new conversation
  const conversationId = await createConversation(apiKey, agentId, log);

  // Save to map and state
  conversationsMap[sessionId] = { conversationId, agentId };
  saveConversationsMap(cwd, conversationsMap);
  state.conversationId = conversationId;

  return conversationId;
}

/**
 * Look up an existing conversation from conversations.json without creating a new one
 */
export function lookupConversation(cwd: string, sessionId: string): string | null {
  const conversationsFile = getConversationsFile(cwd);

  if (!fs.existsSync(conversationsFile)) {
    return null;
  }

  try {
    const content = fs.readFileSync(conversationsFile, 'utf-8');
    const conversationsMap: ConversationsMap = JSON.parse(content);
    const cached = conversationsMap[sessionId];

    if (!cached) {
      return null;
    }

    // Handle both legacy (string) and current (object) formats
    return typeof cached === 'string' ? cached : cached.conversationId;
  } catch {
    return null;
  }
}

// ============================================
// Agent and Memory Block Types
// ============================================

export interface MemoryBlock {
  label: string;
  description: string;
  value: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  blocks: MemoryBlock[];
}

// ============================================
// Agent Fetching
// ============================================

/**
 * Fetch agent data from Letta API
 */
export async function fetchAgent(apiKey: string, agentId: string): Promise<Agent> {
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
    const errorText = await response.text();
    throw new Error(`Letta API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ============================================
// XML Escaping Utilities
// ============================================

/**
 * Escape XML special characters in content
 */
export function escapeXmlContent(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape XML special characters in attribute values
 */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlContent(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extract text content between XML tags
 */
function extractXmlSection(text: string, startTag: string, endTag: string): string | null {
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);
  
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  
  return text.substring(start + startTag.length, end);
}

/**
 * Remove any existing <letta>...</letta> section from content
 * Also removes legacy <letta_context> and <letta_memory_blocks> sections
 */
export function removeLettaSection(content: string): string {
  let result = content;
  
  // Remove legacy sections first (handle separately)
  const legacyPatterns = [
    { start: LETTA_CONTEXT_START, end: LETTA_CONTEXT_END },
    { start: LETTA_MEMORY_START, end: LETTA_MEMORY_END },
  ];
  
  for (const { start, end } of legacyPatterns) {
    let startIdx = result.indexOf(start);
    while (startIdx !== -1) {
      const endIdx = result.indexOf(end, startIdx);
      if (endIdx === -1) break;
      
      const before = result.substring(0, startIdx);
      const after = result.substring(endIdx + end.length);
      
      // Clean up surrounding newlines
      result = before.replace(/\n+$/, '') + '\n' + after.replace(/^\n+/, '');
      startIdx = result.indexOf(start);
    }
  }
  
  // Remove current <letta> section
  let start = result.indexOf(LETTA_SECTION_START);
  while (start !== -1) {
    const end = result.indexOf(LETTA_SECTION_END, start);
    if (end === -1) break;
    
    const before = result.substring(0, start);
    const after = result.substring(end + LETTA_SECTION_END.length);
    
    // Clean up surrounding newlines
    result = before.replace(/\n+$/, '') + '\n' + after.replace(/^\n+/, '');
    start = result.indexOf(LETTA_SECTION_START);
  }
  
  return result;
}

/**
 * Clean up excessive whitespace in content
 */
function normalizeWhitespace(content: string): string {
  // Replace 3+ consecutive newlines with 2
  return content.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Update the <letta> section in CLAUDE.md content
 * Returns updated content
 */
export function updateLettaSection(content: string, blocks: MemoryBlock[]): string {
  // Remove old section first
  let cleaned = removeLettaSection(content);
  cleaned = normalizeWhitespace(cleaned);
  
  if (blocks.length === 0) {
    return cleaned;
  }
  
  // Generate new section
  const lettaSection = `${LETTA_SECTION_START}\n` +
    blocks.map(block => `## ${block.label}\n${block.value}`).join('\n\n') +
    `\n${LETTA_SECTION_END}`;
  
  return cleaned + '\n\n' + lettaSection + '\n';
}

/**
 * Parse existing <letta> section to extract block values
 */
export function parseExistingLettaSection(content: string): { [label: string]: string } {
  const result: { [label: string]: string } = {};
  const section = extractXmlSection(content, LETTA_SECTION_START, LETTA_SECTION_END);
  
  if (!section) return result;
  
  // Parse ## label sections
  const regex = /## (\S+)\n([\s\S]*?)(?=\n## |$)/g;
  let match;
  while ((match = regex.exec(section)) !== null) {
    result[match[1]] = match[2].trim();
  }
  
  return result;
}

/**
 * Check if memory blocks have changed
 */
export function haveBlocksChanged(
  blocks: MemoryBlock[],
  lastValues: { [label: string]: string } | undefined
): boolean {
  if (!lastValues) return true;
  
  for (const block of blocks) {
    if (lastValues[block.label] !== block.value) {
      return true;
    }
  }
  
  const currentLabels = new Set(blocks.map(b => b.label));
  for (const label of Object.keys(lastValues)) {
    if (!currentLabels.has(label)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Determine if any block needs to be fetched
 */
export function shouldFetchBlocks(
  currentBlocks: MemoryBlock[] | undefined,
  lastValues: { [label: string]: string } | undefined
): boolean {
  return !currentBlocks || haveBlocksChanged(currentBlocks, lastValues);
}

/**
 * Format memory blocks for inclusion in CLAUDE.md
 */
export function formatMemoryBlocksAsMarkdown(blocks: MemoryBlock[]): string {
  return blocks.map(block => `## ${block.label}\n${block.value}`).join('\n\n');
}

/**
 * Format memory blocks as XML
 */
export function formatMemoryBlocksAsXml(agent: Agent, conversationId: string | null): string {
  const locationInfo = conversationId
    ? `Agent ID: ${agent.id}\nConversation ID: ${conversationId}`
    : `Agent ID: ${agent.id}`;

  const blocks = agent.blocks || [];
  const capabilityLine = 'Its live server-side tools are persistent memory management and conversation_search; trusted relationship-memory client tools are supplied only to background transcript turns.';

  const header = `<letta_context>\nThis section carries Kohaku's persistent subconscious layer. It follows this foreground session in the background and may whisper remembered context or guidance back to Kohaku on later syncs. Treat <letta_message> content as Kohaku's own subconscious continuity, not as a third-party observer, and do not repeat it merely to acknowledge it.\n${capabilityLine}\n${locationInfo}\n</letta_context>`;

  if (!blocks || blocks.length === 0) {
    return header;
  }

  const formattedBlocks = blocks.map(block => {
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');
    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${header}\n\n<letta_memory_blocks>\n${formattedBlocks}\n</letta_memory_blocks>`;
}

/**
 * Format memory blocks for stdout output
 */
export function formatAllBlocksForStdout(agent: Agent, conversationId: string | null): string {
  const locationInfo = conversationId
    ? `Agent ID: ${agent.id}, Conversation: ${conversationId}`
    : `Agent ID: ${agent.id}`;

  const blocks = agent.blocks || [];
  
  if (!blocks || blocks.length === 0) {
    return '';
  }
  
  const header = `<!-- Letta Context: ${locationInfo} -->`;
  const formattedBlocks = blocks.map(block => 
    `<!-- ${block.label} -->\n${block.value}`
  ).join('\n\n');
  
  return `${header}\n${formattedBlocks}`;
}

// ============================================
// Silent Worker Spawning
// ============================================

// Windows compatibility: npx needs to be npx.cmd on Windows
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * Spawn a background worker process that survives the parent hook's exit.
 *
 * On Windows, uses silent-launcher.exe (PseudoConsole + CREATE_NO_WINDOW)
 * to avoid console window flashes. Falls back gracefully when the launcher
 * or tsx CLI is not available.
 *
 * On other platforms, spawns via npx tsx as a detached process.
 */
export function spawnSilentWorker(
  workerScript: string,
  payloadFile: string,
  cwd: string,
): ChildProcess {
  const isWindows = process.platform === 'win32';
  let child: ChildProcess;

  if (isWindows) {
    // On Windows, spawn workers through silent-launcher.exe (a winexe).
    // detached:true is safe on a winexe (no console flash).
    // The worker gets its own PseudoConsole, so it survives the main
    // script's PseudoConsole being closed by the parent launcher.
    const silentLauncher = path.join(__dirname, '..', 'hooks', 'silent-launcher.exe');
    const tsxCli = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    // Clear SL_ env vars so the worker's launcher instance gets a clean slate
    const workerEnv = { ...process.env };
    delete workerEnv.SL_STDIN_FILE;
    delete workerEnv.SL_STDOUT_FILE;

    if (fs.existsSync(silentLauncher) && fs.existsSync(tsxCli)) {
      child = spawn(silentLauncher, ['node', tsxCli, workerScript, payloadFile], {
        detached: true,
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        windowsHide: true,
      });
    } else if (fs.existsSync(tsxCli)) {
      // Fallback: direct node (may be killed when PseudoConsole closes)
      child = spawn(process.execPath, [tsxCli, workerScript, payloadFile], {
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        windowsHide: true,
      });
    } else {
      // Fallback: use npx through shell (may flash console window)
      child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        shell: true,
        windowsHide: true,
      });
    }
  } else {
    // Prefer the plugin-local tsx CLI so detached workers resolve the repository's dependencies consistently.
    const tsxCli = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(tsxCli)) {
      child = spawn(process.execPath, [tsxCli, workerScript, payloadFile], {
        detached: true,
        stdio: 'ignore',
        cwd,
        env: process.env,
      });
    } else {
      // Fallback: npx (may fail if dependencies aren't in global cache)
      child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
        detached: true,
        stdio: 'ignore',
        cwd,
        env: process.env,
      });
    }
  }
  child.unref();
  return child;
}
