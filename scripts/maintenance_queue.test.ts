import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceSyncStateCursor,
  enqueueMaintenanceRange,
  loadSyncState,
  saveSyncState,
} from './conversation_utils.js';
import {
  acquireMaintenanceDrainLock,
  listMaintenanceQueueJobs,
  publishMaintenanceQueueJob,
  releaseMaintenanceDrainLock,
  type MaintenanceQueueJob,
} from './maintenance_queue.js';

const roots: string[] = [];
const originalLettaHome = process.env.LETTA_HOME;
afterEach(() => {
  if (originalLettaHome === undefined) delete process.env.LETTA_HOME;
  else process.env.LETTA_HOME = originalLettaHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  delete process.env.LETTA_HOME;
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-queue-'));
  roots.push(value);
  return value;
}

function job(sessionId: string, start: number, through: number, id = `job-${start}-${through}`): MaintenanceQueueJob {
  return {
    schema_version: 1,
    job_id: id,
    session_id: sessionId,
    start_index: start,
    through_index: through,
    created_at: '2026-08-26T00:00:00.000Z',
    payload: {
      agentId: 'agent-a', conversationId: 'conv-a', sessionId,
      message: 'maintenance', stateFile: '/tmp/state', cwd: '/tmp/cwd', batchId: id,
      newLastProcessedIndex: through, canonicalMessages: [], assistantIntents: [],
    },
    transcript_messages: [],
  };
}

describe('per-session maintenance queue', () => {
  it('claims non-overlapping suffixes with enqueuedThrough separate from the committed cursor', () => {
    const cwd = root();
    saveSyncState(cwd, { sessionId: 's', lastProcessedIndex: 2 });
    const first = enqueueMaintenanceRange(cwd, 's', 5, (start, through) => ({ start, through }));
    const second = enqueueMaintenanceRange(cwd, 's', 9, (start, through) => ({ start, through }));
    expect(first).toMatchObject({ startIndex: 2, throughIndex: 5 });
    expect(second).toMatchObject({ startIndex: 5, throughIndex: 9 });
    const state = loadSyncState(cwd, 's');
    expect(state.lastProcessedIndex).toBe(2);
    expect(state.maintenanceEnqueuedThrough).toBe(9);
  });

  it('does not advance enqueuedThrough when durable job publication fails', () => {
    const cwd = root();
    saveSyncState(cwd, { sessionId: 's', lastProcessedIndex: 3 });
    expect(() => enqueueMaintenanceRange(cwd, 's', 6, () => { throw new Error('disk failed'); })).toThrow('disk failed');
    const state = loadSyncState(cwd, 's');
    expect(state.lastProcessedIndex).toBe(3);
    expect(state.maintenanceEnqueuedThrough).toBe(3);
  });

  it('recovers a durable publish that crashed before the enqueue watermark commit', () => {
    const cwd = root();
    saveSyncState(cwd, { sessionId: 's', lastProcessedIndex: 2, maintenanceEnqueuedThrough: 2 });
    // Simulate publish(2..5) succeeding, then process death before state write.
    publishMaintenanceQueueJob(cwd, job('s', 2, 5, 'crash-published'));
    expect(loadSyncState(cwd, 's').maintenanceEnqueuedThrough).toBe(2);

    const next = enqueueMaintenanceRange(cwd, 's', 9, (start, through) => {
      const value = job('s', start, through, 'after-recovery');
      publishMaintenanceQueueJob(cwd, value);
      return value;
    }, undefined, () => listMaintenanceQueueJobs(cwd, 's'));
    expect(next).toMatchObject({ startIndex: 5, throughIndex: 9 });
    expect(listMaintenanceQueueJobs(cwd, 's').map((item) => [item.start_index, item.through_index])).toEqual([[2, 5], [5, 9]]);
    expect(loadSyncState(cwd, 's').maintenanceEnqueuedThrough).toBe(9);
  });

  it('keeps enqueuedThrough monotonic across stale saves and cursor advancement', () => {
    const cwd = root();
    const stale = { sessionId: 's', lastProcessedIndex: 1, maintenanceEnqueuedThrough: 1 };
    saveSyncState(cwd, stale);
    enqueueMaintenanceRange(cwd, 's', 8, () => 'published');
    saveSyncState(cwd, stale);
    expect(loadSyncState(cwd, 's').maintenanceEnqueuedThrough).toBe(8);
    advanceSyncStateCursor(cwd, 's', 10);
    expect(loadSyncState(cwd, 's')).toMatchObject({ lastProcessedIndex: 10, maintenanceEnqueuedThrough: 10 });
  });

  it('publishes immutable idempotent jobs in transcript order', () => {
    const cwd = root();
    publishMaintenanceQueueJob(cwd, job('s', 4, 8, 'b'));
    publishMaintenanceQueueJob(cwd, job('s', -1, 4, 'a'));
    publishMaintenanceQueueJob(cwd, job('s', -1, 4, 'a'));
    expect(listMaintenanceQueueJobs(cwd, 's').map((item) => item.job_id)).toEqual(['a', 'b']);
    const collision = job('s', -1, 4, 'a');
    collision.payload.message = 'different';
    expect(() => publishMaintenanceQueueJob(cwd, collision)).toThrow('job collision');
  });

  it('allows only one active drainer per session', () => {
    const cwd = root();
    const first = acquireMaintenanceDrainLock(cwd, 's');
    expect(first).not.toBeNull();
    expect(acquireMaintenanceDrainLock(cwd, 's')).toBeNull();
    releaseMaintenanceDrainLock(first!);
    const next = acquireMaintenanceDrainLock(cwd, 's');
    expect(next).not.toBeNull();
    releaseMaintenanceDrainLock(next!);
  });
});
