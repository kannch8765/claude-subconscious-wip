#!/usr/bin/env npx tsx
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getOrCreateConversation,
  getTempStateDir,
  loadSyncState,
  saveSyncState,
  withSyncStateLock,
} from './conversation_utils.js';
import {
  acquireMaintenanceDrainLock,
  listMaintenanceQueueJobs,
  releaseMaintenanceDrainLock,
  removeMaintenanceQueueJob,
  type MaintenanceDrainLock,
  type MaintenanceQueueJob,
} from './maintenance_queue.js';
import { buildCanonicalMessages } from '../relationship-memory/src/adapter/index.js';
import { runNativeWorkerPayload, type LiveWorkerPayload } from './send_worker_native.js';

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;
const LOG_FILE = path.join(getTempStateDir(), 'maintenance_queue_worker.log');

export interface MaintenanceDrainRequest {
  cwd: string;
  sessionId: string;
}

export interface MaintenanceQueueWorkerDependencies {
  runPayload?: (payload: LiveWorkerPayload) => Promise<'completed' | 'retryable_failure'>;
  getConversation?: typeof getOrCreateConversation;
}

function ensureLogDir(): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function log(message: string): void {
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
}

function payloadForConversation(job: MaintenanceQueueJob, conversationId: string): LiveWorkerPayload {
  if (job.payload.conversationId === conversationId) return job.payload;
  return {
    ...job.payload,
    conversationId,
    canonicalMessages: buildCanonicalMessages(job.transcript_messages, -1, conversationId),
  };
}

function releaseIfStillEmpty(cwd: string, sessionId: string, lock: MaintenanceDrainLock): boolean {
  let released = false;
  withSyncStateLock(cwd, sessionId, () => {
    // Enqueue publishes its job under this same session-state lock before
    // advancing enqueuedThrough. Rechecking here and releasing the drain lock
    // before dropping the state lock closes the classic empty-queue lost wakeup.
    if (listMaintenanceQueueJobs(cwd, sessionId).length === 0) {
      releaseMaintenanceDrainLock(lock);
      released = true;
    }
  });
  return released;
}

export async function drainMaintenanceQueue(
  request: MaintenanceDrainRequest,
  dependencies: MaintenanceQueueWorkerDependencies = {},
): Promise<'drained' | 'busy' | 'blocked'> {
  const { cwd, sessionId } = request;
  const lock = acquireMaintenanceDrainLock(cwd, sessionId);
  if (!lock) {
    log(`Maintenance queue already has an active drainer for session ${sessionId}`);
    return 'busy';
  }

  let lockHeld = true;
  try {
    while (true) {
      const state = loadSyncState(cwd, sessionId, log);
      const jobs = listMaintenanceQueueJobs(cwd, sessionId);

      for (const obsolete of jobs.filter((job) => job.through_index <= state.lastProcessedIndex)) {
        removeMaintenanceQueueJob(cwd, sessionId, obsolete.job_id);
        log(`Removed obsolete maintenance job ${obsolete.job_id}; cursor already reached ${state.lastProcessedIndex}`);
      }

      const remaining = listMaintenanceQueueJobs(cwd, sessionId);
      if (remaining.length === 0) {
        if (releaseIfStillEmpty(cwd, sessionId, lock)) {
          lockHeld = false;
          log(`Maintenance queue drained for session ${sessionId}`);
          return 'drained';
        }
        continue;
      }

      const head = remaining[0];
      const current = loadSyncState(cwd, sessionId, log).lastProcessedIndex;
      if (head.start_index !== current) {
        log(`Maintenance queue blocked by range invariant: cursor=${current}, head=${head.start_index + 1}..${head.through_index}`);
        return 'blocked';
      }

      const apiKey = process.env.LETTA_API_KEY;
      if (!apiKey) throw new Error('LETTA_API_KEY must be set to drain maintenance queue');
      const liveState = loadSyncState(cwd, sessionId, log);
      const conversationId = await (dependencies.getConversation ?? getOrCreateConversation)(
        apiKey,
        head.payload.agentId,
        sessionId,
        cwd,
        liveState,
        log,
      );
      saveSyncState(cwd, liveState, log);
      const payload = payloadForConversation(head, conversationId);
      const completion = await (dependencies.runPayload ?? runNativeWorkerPayload)(payload);
      if (completion !== 'completed') {
        log(`Maintenance queue head ${head.job_id} is retryable; later jobs remain blocked`);
        return 'blocked';
      }

      removeMaintenanceQueueJob(cwd, sessionId, head.job_id);
      log(`Completed maintenance queue job ${head.job_id} through index ${head.through_index}`);
    }
  } finally {
    if (lockHeld) releaseMaintenanceDrainLock(lock);
  }
}

export async function runMaintenanceQueueRequestFile(requestFile: string, dependencies: MaintenanceQueueWorkerDependencies = {}): Promise<void> {
  if (!requestFile || !fs.existsSync(requestFile)) throw new Error(`maintenance drain request not found: ${requestFile || '(missing)'}`);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as MaintenanceDrainRequest;
  if (!request?.cwd || !request?.sessionId) throw new Error('invalid maintenance drain request');
  try {
    await drainMaintenanceQueue(request, dependencies);
  } finally {
    try { fs.unlinkSync(requestFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
}

async function main(): Promise<void> {
  try {
    await runMaintenanceQueueRequestFile(process.argv[2]);
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (isMain) void main();
