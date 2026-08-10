import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SubconVisibilityPhase = 'user_prompt' | 'pre_tool';

export interface SubconVisibilityEvent {
  schema: 'subcon_visibility_v1';
  run_id: string;
  session_id: string;
  sequence: number;
  phase: SubconVisibilityPhase;
  payload: string;
  created_at: string;
}

export interface MirrorSubconVisibilityInput {
  sessionId: string;
  phase: SubconVisibilityPhase;
  payload: string;
}

const DEFAULT_MAX_EVENTS_PER_RUN = 64;
const DEFAULT_MAX_RUNS = 8;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const LOCK_RETRIES = 20;
const LOCK_SLEEP_MS = 2;
const STALE_LOCK_MS = 2_000;

function boundedPositiveInt(raw: string | undefined, fallback: number, maximum: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function expandRoot(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function getSubconVisibilityRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.SUBCON_VISIBILITY_DIR?.trim();
  return configured ? expandRoot(configured) : null;
}

export function visibilityRunKey(runId: string): string {
  return crypto.createHash('sha256').update(runId, 'utf8').digest('hex');
}

export function visibilityRunDir(root: string, runId: string): string {
  return path.join(root, visibilityRunKey(runId));
}

function sleepSync(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best-effort hardening only; write failure is handled by the mirror caller.
  }
}

function acquireLock(runDir: string): string | null {
  const lock = path.join(runDir, '.write-lock');
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      return lock;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Another writer may have released the lock between stat/remove attempts.
      }
      sleepSync(LOCK_SLEEP_MS);
    }
  }
  return null;
}

function atomicWrite(file: string, content: string): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Keep mirror best-effort. The parent directory remains private.
  }
}

function nextSequence(runDir: string): number {
  const sequenceFile = path.join(runDir, '.sequence');
  let current = 0;
  try {
    const parsed = Number.parseInt(fs.readFileSync(sequenceFile, 'utf8').trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
  } catch {
    // First event for this run.
  }
  const next = current + 1;
  atomicWrite(sequenceFile, `${next}\n`);
  return next;
}

function eventFiles(runDir: string): string[] {
  try {
    return fs.readdirSync(runDir)
      .filter((name) => /^\d{12}\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function cleanupRun(runDir: string, maxEvents: number): void {
  const files = eventFiles(runDir);
  for (const name of files.slice(0, Math.max(0, files.length - maxEvents))) {
    try {
      fs.unlinkSync(path.join(runDir, name));
    } catch {
      // A concurrent reader may have raced cleanup; no retry is needed.
    }
  }
}

function cleanupRoot(root: string, currentRunDir: string, maxRuns: number): void {
  let directories: Array<{ path: string; mtimeMs: number }> = [];
  try {
    directories = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => {
        const candidate = path.join(root, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(candidate).mtimeMs; } catch { /* ignore */ }
        return { path: candidate, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }

  const keep = new Set(directories.slice(0, maxRuns).map((entry) => entry.path));
  keep.add(currentRunDir);
  for (const entry of directories) {
    if (keep.has(entry.path)) continue;
    try {
      fs.rmSync(entry.path, { recursive: true, force: true });
    } catch {
      // Best-effort lifecycle bound; a later hook invocation will retry cleanup.
    }
  }
}

/**
 * Mirror the exact displayable payload already being injected into Claude.
 *
 * This path is intentionally best-effort: any filesystem/locking/size failure
 * returns false and MUST NOT affect the authoritative hook stdout/context.
 * Mirroring is disabled unless both SUBCON_VISIBILITY_DIR and
 * SUBCON_VISIBILITY_RUN_ID are explicitly supplied by the owning Claude-P run.
 */
export function mirrorSubconVisibility(
  input: MirrorSubconVisibilityInput,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const root = getSubconVisibilityRoot(env);
    const runId = env.SUBCON_VISIBILITY_RUN_ID?.trim();
    if (!root || !runId || !input.sessionId || !input.payload) return false;

    const maxPayloadBytes = boundedPositiveInt(
      env.SUBCON_VISIBILITY_MAX_PAYLOAD_BYTES,
      DEFAULT_MAX_PAYLOAD_BYTES,
      8 * 1024 * 1024,
    );
    if (Buffer.byteLength(input.payload, 'utf8') > maxPayloadBytes) return false;

    const maxEvents = boundedPositiveInt(
      env.SUBCON_VISIBILITY_MAX_EVENTS,
      DEFAULT_MAX_EVENTS_PER_RUN,
      512,
    );
    const maxRuns = boundedPositiveInt(
      env.SUBCON_VISIBILITY_MAX_RUNS,
      DEFAULT_MAX_RUNS,
      64,
    );

    ensurePrivateDirectory(root);
    const runDir = visibilityRunDir(root, runId);
    ensurePrivateDirectory(runDir);
    const lock = acquireLock(runDir);
    if (!lock) return false;

    try {
      const sequence = nextSequence(runDir);
      const event: SubconVisibilityEvent = {
        schema: 'subcon_visibility_v1',
        run_id: runId,
        session_id: input.sessionId,
        sequence,
        phase: input.phase,
        payload: input.payload,
        created_at: new Date().toISOString(),
      };
      const file = path.join(runDir, `${String(sequence).padStart(12, '0')}.json`);
      atomicWrite(file, `${JSON.stringify(event)}\n`);
      cleanupRun(runDir, maxEvents);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }

    cleanupRoot(root, runDir, maxRuns);
    return true;
  } catch {
    return false;
  }
}

export function readMirroredVisibilityEvents(
  root: string,
  runId: string,
): SubconVisibilityEvent[] {
  const runDir = visibilityRunDir(root, runId);
  return eventFiles(runDir).flatMap((name) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')) as SubconVisibilityEvent;
      return parsed.schema === 'subcon_visibility_v1' && parsed.run_id === runId ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
