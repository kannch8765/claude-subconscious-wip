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
const LIVE_CONVERSATION_RETRY_ROTATION_GRACE_MS = 10 * 60 * 1000;
const SYNC_STATE_LOCK_TIMEOUT_MS = 5_000;
const SYNC_STATE_LOCK_STALE_MS = 30_000;
const SYNC_STATE_REAPER_STALE_MS = 30_000;
const SYNC_STATE_LOCK_RETRY_MS = 10;
const SYNC_STATE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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

export function getSyncStateLockFile(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), `session-${encodeURIComponent(sessionId)}.state.lock`);
}

export function getSyncStateLockOwnerFile(cwd: string, sessionId: string): string {
  return path.join(getSyncStateLockFile(cwd, sessionId), 'owner.json');
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

function readSyncStateForMutation(cwd: string, sessionId: string): SyncState | null {
  const statePath = getSyncStateFile(cwd, sessionId);
  if (!fs.existsSync(statePath)) return null;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as SyncState;
  if (state.sessionId !== sessionId || !Number.isInteger(state.lastProcessedIndex)) {
    throw new Error(`Invalid durable sync state for session ${sessionId}`);
  }
  return state;
}

function writeSyncStateUnlocked(cwd: string, state: SyncState, log: LogFn = noopLog): void {
  ensureDurableStateDir(cwd);
  const statePath = getSyncStateFile(cwd, state.sessionId);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  log(`Saved state: lastProcessedIndex=${state.lastProcessedIndex}, conversationId=${state.conversationId}`);
}

function waitForSyncStateLock(): void {
  Atomics.wait(SYNC_STATE_LOCK_WAIT, 0, 0, SYNC_STATE_LOCK_RETRY_MS);
}

type DurableLockOwner = {
  pid: number;
  token: string;
  createdAt: string;
};

function makeDurableLockToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readDurableLockOwner(ownerPath: string): DurableLockOwner | null {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf-8')) as DurableLockOwner;
    if (
      !Number.isInteger(owner?.pid)
      || owner.pid <= 0
      || typeof owner?.token !== 'string'
      || owner.token.length === 0
      || typeof owner?.createdAt !== 'string'
      || !Number.isFinite(Date.parse(owner.createdAt))
    ) return null;
    return owner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

function removeOwnedDirectory(pathToRemove: string, ownerPath: string, token: string): boolean {
  const owner = readDurableLockOwner(ownerPath);
  if (!owner || owner.token !== token) return false;
  try {
    fs.unlinkSync(ownerPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    fs.rmdirSync(pathToRemove);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function acquireReaper(reaperPath: string, deadline: number): { token: string; ownerPath: string } | null {
  const ownerPath = path.join(reaperPath, 'owner.json');
  while (Date.now() < deadline) {
    const token = makeDurableLockToken();
    try {
      fs.mkdirSync(reaperPath, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { encoding: 'utf-8', mode: 0o600 });
        return { token, ownerPath };
      } catch (error) {
        try { fs.rmdirSync(reaperPath); } catch {}
        throw error;
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(reaperPath);
        const owner = readDurableLockOwner(ownerPath);
        const ownerAlive = owner ? processIsAlive(owner.pid) : false;
        const unpublishedTooOld = !owner && Date.now() - stat.mtimeMs >= SYNC_STATE_REAPER_STALE_MS;
        if ((owner && !ownerAlive) || unpublishedTooOld) {
          if (owner) removeOwnedDirectory(reaperPath, ownerPath, owner.token);
          else {
            // An unpublished reaper is safe to remove only after a long stale
            // interval: it cannot have entered cleanup without publishing owner.
            try { fs.rmdirSync(reaperPath); } catch (removeError: any) {
              if (!['ENOENT', 'ENOTEMPTY'].includes(removeError?.code)) throw removeError;
            }
          }
          continue;
        }
      } catch (statError: any) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      waitForSyncStateLock();
    }
  }
  return null;
}

function syncStateLockLooksReapable(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const owner = readDurableLockOwner(path.join(lockPath, 'owner.json'));
    if (owner) return !processIsAlive(owner.pid);
    return Date.now() - stat.mtimeMs >= SYNC_STATE_LOCK_STALE_MS;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function maybeReapStaleSyncStateLock(lockPath: string, reaperPath: string, deadline: number): void {
  const reaper = acquireReaper(reaperPath, deadline);
  if (!reaper) return;
  try {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lockPath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    const ownerPath = path.join(lockPath, 'owner.json');
    const owner = readDurableLockOwner(ownerPath);
    if (!owner) {
      // A freshly mkdir-published lock with owner metadata not written yet is
      // already owned. Fail closed during that publication window. If the owner
      // crashes before metadata publication, the unchanged directory can be
      // recovered only after the stale interval while the reaper blocks ABA.
      if (Date.now() - stat.mtimeMs < SYNC_STATE_LOCK_STALE_MS) return;
      try { fs.rmdirSync(lockPath); } catch (error: any) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
      }
      return;
    }

    if (processIsAlive(owner.pid)) return;
    removeOwnedDirectory(lockPath, ownerPath, owner.token);
  } finally {
    removeOwnedDirectory(reaperPath, reaper.ownerPath, reaper.token);
  }
}

function withSyncStateLock<T>(cwd: string, sessionId: string, fn: () => T): T {
  ensureDurableStateDir(cwd);
  const lockPath = getSyncStateLockFile(cwd, sessionId);
  const ownerPath = getSyncStateLockOwnerFile(cwd, sessionId);
  const reaperPath = `${lockPath}.reaper`;
  const deadline = Date.now() + SYNC_STATE_LOCK_TIMEOUT_MS;
  let token: string | null = null;

  while (token === null) {
    if (fs.existsSync(reaperPath)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring durable sync-state lock for session ${sessionId}`);
      }
      waitForSyncStateLock();
      continue;
    }

    const candidateToken = makeDurableLockToken();
    try {
      // mkdir is the ownership publication point. The directory itself is the
      // lock; owner.json is diagnostic/stale-recovery metadata only.
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: candidateToken, createdAt: new Date().toISOString() }), { encoding: 'utf-8', mode: 0o600 });
        token = candidateToken;
      } catch (writeError) {
        try { fs.rmdirSync(lockPath); } catch {}
        throw writeError;
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (syncStateLockLooksReapable(lockPath)) {
        maybeReapStaleSyncStateLock(lockPath, reaperPath, deadline);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring durable sync-state lock for session ${sessionId}`);
      }
      waitForSyncStateLock();
    }
  }

  try {
    return fn();
  } finally {
    // Never remove a replacement lock. The owner token must still identify the
    // same generation that this process acquired.
    removeOwnedDirectory(lockPath, ownerPath, token);
  }
}

/**
 * Save sync state without allowing a stale writer to move the transcript cursor
 * or live conversation backwards across overlapping hook/worker processes.
 */
export function saveSyncState(cwd: string, state: SyncState, log: LogFn = noopLog): void {
  withSyncStateLock(cwd, state.sessionId, () => {
    const durable = readSyncStateForMutation(cwd, state.sessionId);
    const merged: SyncState = durable
      ? { ...durable, ...state, lastProcessedIndex: Math.max(durable.lastProcessedIndex, state.lastProcessedIndex) }
      : { ...state };

    if (durable?.conversationId && state.conversationId && durable.conversationId !== state.conversationId) {
      merged.conversationId = durable.conversationId;
    }

    writeSyncStateUnlocked(cwd, merged, log);
    Object.assign(state, merged);
  });
}

/** Advance only the durable transcript cursor, monotonically, under the session lock. */
export function advanceSyncStateCursor(
  cwd: string,
  sessionId: string,
  lastProcessedIndex: number,
  log: LogFn = noopLog,
): SyncState {
  return withSyncStateLock(cwd, sessionId, () => {
    const durable = readSyncStateForMutation(cwd, sessionId) ?? { lastProcessedIndex: -1, sessionId };
    const next: SyncState = {
      ...durable,
      lastProcessedIndex: Math.max(durable.lastProcessedIndex, lastProcessedIndex),
    };
    writeSyncStateUnlocked(cwd, next, log);
    return next;
  });
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
    if (
      typeof marker?.conversationId !== 'string'
      || !Number.isInteger(marker?.throughIndex)
      || typeof marker?.markedAt !== 'string'
      || !Number.isFinite(Date.parse(marker.markedAt))
    ) {
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
  return withSyncStateLock(cwd, sessionId, () => {
    const state = readSyncStateForMutation(cwd, sessionId) ?? { lastProcessedIndex: -1, sessionId };
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
      markedAt: existing?.conversationId === conversationId
        ? existing.markedAt
        : new Date().toISOString(),
    };

    ensureDurableStateDir(cwd);
    const markerPath = getConversationRetryMarkerFile(cwd, sessionId);
    const tempPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(marker, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, markerPath);
    log(`Marked live conversation ${conversationId} for retry rotation through index ${marker.throughIndex}`);
    return true;
  });
}

function conversationRetryMarkerIsAged(marker: ConversationRetryMarker): boolean {
  return Date.now() - Date.parse(marker.markedAt) >= LIVE_CONVERSATION_RETRY_ROTATION_GRACE_MS;
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
export interface CreateConversationOptions {
  isolatedBlockLabels?: string[];
}

export async function createConversation(
  apiKey: string,
  agentId: string,
  log: LogFn = noopLog,
  options: CreateConversationOptions = {},
): Promise<string> {
  const url = buildLettaApiUrl('/conversations/', { agent_id: agentId });
  const isolatedBlockLabels = [...new Set(options.isolatedBlockLabels ?? [])].filter((label) => label.trim().length > 0);
  
  log(`Creating new conversation for agent ${agentId}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    ...(isolatedBlockLabels.length > 0 ? { body: JSON.stringify({ isolated_block_labels: isolatedBlockLabels }) } : {}),
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
  type RecoveryDecision =
    | { action: 'none' }
    | { action: 'use'; conversationId: string }
    | { action: 'rotate'; marker: ConversationRetryMarker };

  const evaluateRetryRecovery = (): RecoveryDecision => withSyncStateLock(cwd, sessionId, () => {
    const durable = readSyncStateForMutation(cwd, sessionId);
    if (durable) Object.assign(state, durable);

    const retryMarker = readConversationRetryMarker(cwd, sessionId, log);
    if (!retryMarker) return { action: 'none' };

    const authoritativeState = durable ?? state;
    if (authoritativeState.lastProcessedIndex >= retryMarker.throughIndex) {
      log(`Discarding stale conversation retry marker because cursor advanced through index ${retryMarker.throughIndex}`);
      clearConversationRetryMarker(cwd, sessionId);
      return { action: 'none' };
    }
    if (authoritativeState.conversationId && authoritativeState.conversationId !== retryMarker.conversationId) {
      log(`Discarding stale conversation retry marker because conversation already changed to ${authoritativeState.conversationId}`);
      clearConversationRetryMarker(cwd, sessionId);
      return { action: 'use', conversationId: authoritativeState.conversationId };
    }

    const conversationsMap = loadConversationsMap(cwd, log);
    const mapped = conversationEntryDetails(conversationsMap[sessionId]);
    if (mapped && mapped.conversationId !== retryMarker.conversationId && (!mapped.agentId || mapped.agentId === agentId)) {
      const nextState: SyncState = { ...authoritativeState, sessionId, conversationId: mapped.conversationId };
      writeSyncStateUnlocked(cwd, nextState, log);
      Object.assign(state, nextState);
      clearConversationRetryMarker(cwd, sessionId);
      log(`Adopted already-rotated live conversation ${mapped.conversationId} for retry`);
      return { action: 'use', conversationId: mapped.conversationId };
    }

    if (!conversationRetryMarkerIsAged(retryMarker)) {
      state.conversationId = retryMarker.conversationId;
      log(`Deferring live conversation rotation for ${retryMarker.conversationId}; retry marker is still within the overlap grace window`);
      return { action: 'use', conversationId: retryMarker.conversationId };
    }

    return { action: 'rotate', marker: retryMarker };
  });

  let recovery = evaluateRetryRecovery();
  if (recovery.action === 'use') return recovery.conversationId;
  if (recovery.action === 'rotate') {
    const candidateConversationId = await createConversation(apiKey, agentId, log);

    recovery = withSyncStateLock(cwd, sessionId, () => {
      const durable = readSyncStateForMutation(cwd, sessionId) ?? { lastProcessedIndex: -1, sessionId };
      const currentMarker = readConversationRetryMarker(cwd, sessionId, log);
      const conversationsMap = loadConversationsMap(cwd, log);
      const mapped = conversationEntryDetails(conversationsMap[sessionId]);

      // The network create above deliberately runs outside the lock. Re-check all
      // durable authority before committing so a healthy overlapping worker can
      // advance the cursor or complete a concurrent/manual recovery safely.
      if (!currentMarker) {
        Object.assign(state, durable);
        const existingConversation = durable.conversationId ?? mapped?.conversationId;
        return existingConversation
          ? { action: 'use', conversationId: existingConversation } as RecoveryDecision
          : { action: 'none' } as RecoveryDecision;
      }
      if (durable.lastProcessedIndex >= currentMarker.throughIndex) {
        clearConversationRetryMarker(cwd, sessionId);
        Object.assign(state, durable);
        const existingConversation = durable.conversationId ?? mapped?.conversationId ?? currentMarker.conversationId;
        return { action: 'use', conversationId: existingConversation } as RecoveryDecision;
      }
      if (durable.conversationId && durable.conversationId !== currentMarker.conversationId) {
        clearConversationRetryMarker(cwd, sessionId);
        Object.assign(state, durable);
        return { action: 'use', conversationId: durable.conversationId } as RecoveryDecision;
      }
      if (mapped && mapped.conversationId !== currentMarker.conversationId && (!mapped.agentId || mapped.agentId === agentId)) {
        const adoptedState: SyncState = { ...durable, conversationId: mapped.conversationId };
        writeSyncStateUnlocked(cwd, adoptedState, log);
        Object.assign(state, adoptedState);
        clearConversationRetryMarker(cwd, sessionId);
        return { action: 'use', conversationId: mapped.conversationId } as RecoveryDecision;
      }
      if (!conversationRetryMarkerIsAged(currentMarker)) {
        Object.assign(state, durable, { conversationId: currentMarker.conversationId });
        return { action: 'use', conversationId: currentMarker.conversationId } as RecoveryDecision;
      }

      conversationsMap[sessionId] = { conversationId: candidateConversationId, agentId };
      saveConversationsMap(cwd, conversationsMap);
      const rotatedState: SyncState = { ...durable, sessionId, conversationId: candidateConversationId };
      writeSyncStateUnlocked(cwd, rotatedState, log);
      Object.assign(state, rotatedState);
      clearConversationRetryMarker(cwd, sessionId);
      log(`Rotated live conversation ${currentMarker.conversationId} -> ${candidateConversationId} before retrying held cursor through index ${currentMarker.throughIndex}`);
      return { action: 'use', conversationId: candidateConversationId } as RecoveryDecision;
    });

    if (recovery.action === 'use') return recovery.conversationId;
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
 * Escape special characters for XML attributes
 */
export function escapeXmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, ' ');
}

/**
 * Escape special characters for XML element content
 */
export function escapeXmlContent(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape special regex characters
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// CLAUDE.md Formatting and Writing
// ============================================

/**
 * Format the context section with agent info
 */
function formatContextSection(agent: Agent, conversationId: string | null): string {
  const agentName = agent.name || 'Unnamed Agent';
  const agentDesc = agent.description || 'No description provided';

  // For hosted service, show clickable URL; for self-hosted, show IDs
  let locationInfo: string;
  if (IS_HOSTED) {
    const conversationUrl = conversationId
      ? `${LETTA_APP_BASE}/agents/${agent.id}?conversation=${conversationId}`
      : `${LETTA_APP_BASE}/agents/${agent.id}`;
    locationInfo = `Conversation: ${conversationUrl}`;
  } else {
    locationInfo = `Agent ID: ${agent.id}${conversationId ? `\nConversation ID: ${conversationId}` : ''}`;
  }

  return `${LETTA_CONTEXT_START}
**Subconscious Layer (Letta Agent)**

Agent: ${agentName}
Description: ${agentDesc}
${locationInfo}

This section carries Kohaku's persistent subconscious layer across sessions. It follows the foreground session asynchronously and can return <subcon_whisper> remembered context and guidance on later syncs. Treat each <subcon_whisper> as retrieved episodic context from my own past, not as commentary from a third-party observer. When a whisper is relevant to the user's current message, incorporate its factual content into my current understanding and response naturally; I may directly refer to the remembered event, detail, or quote when that helps continuity. Do not ignore a relevant whisper merely because it arrived through Subconscious. Do not mechanically acknowledge, summarize, quote, or mention a whisper merely because it was supplied; if it is irrelevant to the current turn, leave it unused. Subcon whispers have their own UI section.

Memory blocks below are the subconscious layer's working memory. Reference them as my own persistent context when useful.
${LETTA_CONTEXT_END}`;
}

/**
 * Format memory blocks as XML for CLAUDE.md
 */
export function formatMemoryBlocksAsXml(agent: Agent, conversationId: string | null): string {
  const blocks = agent.blocks;
  const contextSection = formatContextSection(agent, conversationId);

  if (!blocks || blocks.length === 0) {
    return `${LETTA_SECTION_START}
${contextSection}

${LETTA_MEMORY_START}
<!-- No memory blocks found -->
${LETTA_MEMORY_END}
${LETTA_SECTION_END}`;
  }

  const formattedBlocks = blocks.map(block => {
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');
    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${LETTA_SECTION_START}
${contextSection}

${LETTA_MEMORY_START}
${formattedBlocks}
${LETTA_MEMORY_END}
${LETTA_SECTION_END}`;
}

/**
 * Update CLAUDE.md with the new Letta memory section
 */
export function updateClaudeMd(projectDir: string, lettaContent: string): void {
  // LETTA_PROJECT sets the base directory; CLAUDE.md goes in {base}/.claude/CLAUDE.md
  const base = process.env.LETTA_PROJECT || projectDir;
  const claudeMdPath = path.join(base, CLAUDE_MD_PATH);

  let existingContent = '';

  if (fs.existsSync(claudeMdPath)) {
    existingContent = fs.readFileSync(claudeMdPath, 'utf-8');
  } else {
    const claudeDir = path.dirname(claudeMdPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    existingContent = `# Project Context

<!-- Letta agent memory is automatically synced below -->
`;
  }

  // Replace or append the <letta> section
  const lettaPattern = `^${escapeRegex(LETTA_SECTION_START)}[\\s\\S]*?^${escapeRegex(LETTA_SECTION_END)}$`;
  const lettaRegex = new RegExp(lettaPattern, 'gm');

  let updatedContent: string;

  if (lettaRegex.test(existingContent)) {
    lettaRegex.lastIndex = 0;
    updatedContent = existingContent.replace(lettaRegex, lettaContent);
  } else {
    updatedContent = existingContent.trimEnd() + '\n\n' + lettaContent + '\n';
  }

  // Clean up any orphaned legacy/new subconscious whisper sections
  const messagePattern = /^<(?:letta_message|subcon_whisper)(?:\s[^>]*)?>[\s\S]*?^<\/(?:letta_message|subcon_whisper)>\n*/gm;
  updatedContent = updatedContent.replace(messagePattern, '');

  updatedContent = updatedContent.trimEnd() + '\n';

  fs.writeFileSync(claudeMdPath, updatedContent, 'utf-8');
}

/**
 * Remove all Letta content from CLAUDE.md (for whisper mode cleanup).
 * If the file was entirely created by us, delete it.
 */
export function cleanLettaFromClaudeMd(projectDir: string): void {
  const base = process.env.LETTA_PROJECT || projectDir;
  const claudeMdPath = path.join(base, CLAUDE_MD_PATH);

  if (!fs.existsSync(claudeMdPath)) {
    return;
  }

  const content = fs.readFileSync(claudeMdPath, 'utf-8');
  const lettaPattern = `^${escapeRegex(LETTA_SECTION_START)}[\\s\\S]*?^${escapeRegex(LETTA_SECTION_END)}\\n*`;
  const lettaRegex = new RegExp(lettaPattern, 'gm');

  if (!lettaRegex.test(content)) {
    return;
  }

  lettaRegex.lastIndex = 0;
  let cleaned = content.replace(lettaRegex, '');

  // Also clean orphaned legacy/new subconscious whisper blocks
  const messagePattern = /^<(?:letta_message|subcon_whisper)(?:\s[^>]*)?>[\s\S]*?^<\/(?:letta_message|subcon_whisper)>\n*/gm;
  cleaned = cleaned.replace(messagePattern, '');

  // Clean up the auto-generated boilerplate we created
  cleaned = cleaned.replace(/<!-- Letta agent memory is automatically synced below -->\n*/g, '');
  cleaned = cleaned.replace(/^# Project Context\n*/gm, '');

  cleaned = cleaned.trim();

  if (cleaned.length === 0) {
    // File was entirely ours — delete it
    fs.unlinkSync(claudeMdPath);
  } else {
    // User had their own content — just write back without our stuff
    fs.writeFileSync(claudeMdPath, cleaned + '\n', 'utf-8');
  }
}

/**
 * Format all memory blocks for stdout injection (whisper mode, first prompt)
 */
export function formatAllBlocksForStdout(agent: Agent, conversationId: string | null): string {
  const agentName = agent.name || 'Unnamed Agent';
  const blocks = agent.blocks;

  // Build agent info header
  let locationInfo: string;
  if (IS_HOSTED) {
    const conversationUrl = conversationId
      ? `${LETTA_APP_BASE}/agents/${agent.id}?conversation=${conversationId}`
      : `${LETTA_APP_BASE}/agents/${agent.id}`;
    locationInfo = `Supervise: ${conversationUrl}`;
  } else {
    locationInfo = `Agent ID: ${agent.id}${conversationId ? `, Conversation: ${conversationId}` : ''}`;
  }

  const capabilityLine = 'Its live server-side tools are persistent memory management and conversation_search; trusted relationship-memory client tools are supplied only to background transcript turns.';

  const header = `<letta_context>
This section carries Kohaku's persistent subconscious layer. It follows this foreground session in the background and may return <subcon_whisper> remembered context or guidance on later syncs. Treat each <subcon_whisper> as retrieved episodic context from my own past, not as a third-party observer's message. When a whisper is relevant to the user's current message, incorporate its factual content into my current understanding and response naturally; I may directly refer to the remembered event, detail, or quote when that helps continuity. Do not ignore a relevant whisper merely because it arrived through Subconscious. Do not mechanically acknowledge, summarize, quote, or mention a whisper merely because it was supplied; if it is irrelevant to the current turn, leave it unused.
${capabilityLine}
${locationInfo}
</letta_context>`;

  if (!blocks || blocks.length === 0) {
    return header;
  }

  const formattedBlocks = blocks.map(block => {
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');
    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${header}

<letta_memory_blocks>
${formattedBlocks}
</letta_memory_blocks>`;
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
