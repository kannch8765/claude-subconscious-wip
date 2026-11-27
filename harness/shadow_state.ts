/**
 * Shadow state (docs/specs/OWN-HARNESS-DESIGN.md §6.1): everything the shadow lanes keep, under one directory
 * that Letta, the live hooks and Kohaku never read.
 *
 *   snapshots/<gen>/store/          copy of the live store's data files; shadow writes land here and die with it
 *   snapshots/<gen>/semantic-index/ copy of the live index (hard link when unchanged); never rebuilt
 *   snapshots/CURRENT               name of the snapshot new passes use
 *   locks/<lane>.lock               at most one worker per lane
 *   sessions/<session>.json         shadow session state: sync picks per turn, recently seen
 *   traces/<JST day>.jsonl          one record per lane per turn (IDs and numbers only)
 *
 * Live session state is read without its lock and never written.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ShadowPaths { root: string; liveStore: string; liveIndexFile: string }

export function shadowPaths(liveStore: string, env: NodeJS.ProcessEnv = process.env): ShadowPaths {
  const indexDir = env.RELATIONSHIP_MEMORY_SEMANTIC_INDEX_DIR?.trim() || `${liveStore}-semantic-index`;
  return { root: env.SUBCON_SHADOW_DIR?.trim() || `${liveStore}-shadow`, liveStore, liveIndexFile: path.join(indexDir, 'index.json') };
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// ---- locks

/** Runs fn under the lane's lock, or returns 'busy'. A lock older than staleMs belongs to a dead worker. */
export async function withLaneLock<T>(paths: ShadowPaths, lane: string, fn: () => Promise<T>, staleMs = 15 * 60_000): Promise<T | 'busy'> {
  const file = path.join(ensureDir(path.join(paths.root, 'locks')), `${lane}.lock`);
  const take = (): boolean => {
    try { fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
  };
  if (!take()) {
    let age = 0;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* released meanwhile */ }
    if (age <= staleMs) { if (!take()) return 'busy'; }
    else { fs.rmSync(file, { force: true }); if (!take()) return 'busy'; }
  }
  try { return await fn(); } finally { fs.rmSync(file, { force: true }); }
}

// ---- snapshots

export interface Snapshot { gen: string; storeDir: string; indexFile: string }
export interface RefreshResult extends Snapshot { copy_ms: number; live_changed_during_copy: boolean; index: 'copied' | 'linked' | 'missing' }

/** The store's data files. Dot entries are derived caches or locks (`.write-index-v1` holds ~45k marker files and is
 * rebuilt on demand; `.canonical-mutation.lock` would make the snapshot look locked), so they are not copied. */
export function storeDataFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.jsonl?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function signature(dir: string): string {
  return storeDataFiles(dir).map((name) => { const s = fs.statSync(path.join(dir, name)); return `${name}:${s.size}:${s.mtimeMs}`; }).join('|');
}

function fileSignature(file: string): string {
  try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return ''; }
}

export function currentSnapshot(paths: ShadowPaths): Snapshot | undefined {
  try {
    const gen = fs.readFileSync(path.join(paths.root, 'snapshots', 'CURRENT'), 'utf8').trim();
    const dir = path.join(paths.root, 'snapshots', gen);
    if (!gen || !fs.existsSync(path.join(dir, 'store'))) return undefined;
    return { gen, storeDir: path.join(dir, 'store'), indexFile: path.join(dir, 'semantic-index', 'index.json') };
  } catch {
    return undefined;
  }
}

/**
 * Copies the live store into a new snapshot and makes it CURRENT. The index is hard-linked from the previous
 * snapshot when the live index has not changed (nothing in the shadow writes index.json), copied otherwise.
 * Snapshots other than CURRENT older than keepMs are removed.
 */
export function refreshSnapshot(paths: ShadowPaths, keepMs = 15 * 60_000): RefreshResult {
  const started = Date.now();
  const snapshots = ensureDir(path.join(paths.root, 'snapshots'));
  const previous = currentSnapshot(paths);
  const gen = `${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(snapshots, gen);
  const before = signature(paths.liveStore);
  const storeDir = ensureDir(path.join(dir, 'store'));
  for (const name of storeDataFiles(paths.liveStore)) fs.copyFileSync(path.join(paths.liveStore, name), path.join(storeDir, name));
  const liveChanged = signature(paths.liveStore) !== before;

  const indexDir = ensureDir(path.join(dir, 'semantic-index'));
  const indexFile = path.join(indexDir, 'index.json');
  const liveIndex = fileSignature(paths.liveIndexFile);
  let index: RefreshResult['index'] = 'missing';
  if (liveIndex) {
    const previousSig = previous ? (() => { try { return fs.readFileSync(path.join(path.dirname(previous.indexFile), 'live.sig'), 'utf8'); } catch { return ''; } })() : '';
    if (previous && previousSig === liveIndex && fs.existsSync(previous.indexFile)) {
      fs.linkSync(previous.indexFile, indexFile);
      index = 'linked';
    } else {
      fs.copyFileSync(paths.liveIndexFile, indexFile);
      index = 'copied';
    }
    fs.writeFileSync(path.join(indexDir, 'live.sig'), liveIndex, { mode: 0o600 });
  }
  writeAtomic(path.join(snapshots, 'CURRENT'), `${gen}\n`);

  for (const name of fs.readdirSync(snapshots)) {
    if (name === 'CURRENT' || name === gen || name.endsWith('.tmp')) continue;
    const old = path.join(snapshots, name);
    try { if (Date.now() - fs.statSync(old).mtimeMs > keepMs) fs.rmSync(old, { recursive: true, force: true }); } catch { /* removed by another worker */ }
  }
  return { gen, storeDir: path.join(dir, 'store'), indexFile, copy_ms: Date.now() - started, live_changed_during_copy: liveChanged, index };
}

// ---- session state

export interface ShadowSyncPick { turn_key: string; at: string; memory_id?: string; consumed?: boolean }
export interface ShadowSeen { memory_id: string; summary: string }
export interface ShadowSession { sync: ShadowSyncPick[]; passes: Array<{ at: string; seen: ShadowSeen[] }>; picked_memory_ids: string[] }

/** Same text, same key: the prompt hook and the Stop hook see the new message in slightly different spacing. */
export function turnKey(sessionId: string, userText: string): string {
  return crypto.createHash('sha256').update(`${sessionId}\0${userText.replace(/\s+/g, ' ').trim()}`).digest('hex').slice(0, 16);
}

function sessionFile(paths: ShadowPaths, sessionId: string): string {
  return path.join(paths.root, 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

export function readShadowSession(paths: ShadowPaths, sessionId: string): ShadowSession {
  try {
    const value = JSON.parse(fs.readFileSync(sessionFile(paths, sessionId), 'utf8'));
    return { sync: value.sync ?? [], passes: value.passes ?? [], picked_memory_ids: value.picked_memory_ids ?? [] };
  } catch {
    return { sync: [], passes: [], picked_memory_ids: [] };
  }
}

/** Read-modify-write under a short per-session lock (both lanes write here). */
export async function updateShadowSession(paths: ShadowPaths, sessionId: string, change: (session: ShadowSession) => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await withLaneLock(paths, `session-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`, async () => {
      const session = readShadowSession(paths, sessionId);
      change(session);
      session.sync = session.sync.slice(-20);
      session.passes = session.passes.slice(-3);
      writeAtomic(sessionFile(paths, sessionId), `${JSON.stringify(session)}\n`);
    }, 10_000);
    if (result !== 'busy') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('shadow session state stayed locked');
}

/**
 * The sync record for this turn: by turn key, else the newest unconsumed pick of the session from the last
 * maxAgeMs. Marks it consumed. Waits up to waitMs for a sync pass that is still running.
 */
export async function takeSyncPick(paths: ShadowPaths, sessionId: string, key: string, waitMs = 15_000, maxAgeMs = 10 * 60_000): Promise<{ pick?: ShadowSyncPick; join: 'key' | 'recent' | 'none' }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let found: { pick?: ShadowSyncPick; join: 'key' | 'recent' | 'none' } = { join: 'none' };
    await updateShadowSession(paths, sessionId, (session) => {
      const byKey = session.sync.find((p) => p.turn_key === key && !p.consumed);
      const recent = [...session.sync].reverse().find((p) => !p.consumed && Date.now() - Date.parse(p.at) <= maxAgeMs);
      const pick = byKey ?? recent;
      if (pick) { pick.consumed = true; found = { pick: { ...pick }, join: byKey ? 'key' : 'recent' }; }
    });
    if (found.join !== 'none' || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---- live session state (read only, no lock)

/** Memories already in Kohaku's live context this session (delivered whispers, memories written this session). */
export function liveKnownMemoryIds(stateFile: string): string[] {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const ids = [...(state.deliveredMemoryIds ?? []), ...(state.sessionWrittenMemoryIds ?? [])];
    return [...new Set(ids.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0))];
  } catch {
    return [];
  }
}

// ---- traces

export function jstDay(at = new Date()): string {
  return new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function appendTrace(paths: ShadowPaths, record: Record<string, unknown>): void {
  const file = path.join(ensureDir(path.join(paths.root, 'traces')), `${jstDay()}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}
