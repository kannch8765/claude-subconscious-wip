import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceSyncStateCursor, enqueueMaintenanceRange, getSyncStateFile, loadSyncState, saveSyncState } from './conversation_utils.js';
import { listMaintenanceQueueJobs, publishMaintenanceQueueJob, type MaintenanceQueueJob } from './maintenance_queue.js';
import { drainMaintenanceQueue } from './maintenance_queue_worker.js';
import { buildCanonicalMessages } from '../relationship-memory/src/adapter/index.js';

const roots: string[] = [];
const originalLettaHome = process.env.LETTA_HOME;
const originalApiKey = process.env.LETTA_API_KEY;
afterEach(() => {
  if (originalLettaHome === undefined) delete process.env.LETTA_HOME; else process.env.LETTA_HOME = originalLettaHome;
  if (originalApiKey === undefined) delete process.env.LETTA_API_KEY; else process.env.LETTA_API_KEY = originalApiKey;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  delete process.env.LETTA_HOME;
  process.env.LETTA_API_KEY = 'test-key';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-drainer-'));
  roots.push(cwd);
  return cwd;
}

function makeJob(cwd: string, sessionId: string, start: number, through: number, id: string): MaintenanceQueueJob {
  return {
    schema_version: 1,
    job_id: id,
    session_id: sessionId,
    start_index: start,
    through_index: through,
    created_at: '2026-08-26T00:00:00.000Z',
    payload: {
      agentId: 'agent-a', conversationId: 'conv-a', sessionId,
      message: id, stateFile: getSyncStateFile(cwd, sessionId), cwd, batchId: id,
      newLastProcessedIndex: through, canonicalMessages: [], assistantIntents: [],
    },
    transcript_messages: [],
  };
}

const getConversation = async (_key: string, _agent: string, _session: string, _cwd: string, state: any) => {
  state.conversationId = state.conversationId ?? 'conv-a';
  return state.conversationId;
};

describe('maintenance queue drainer', () => {
  it('runs jobs serially and advances the committed cursor in order', async () => {
    const cwd = makeRoot();
    const sessionId = 's';
    saveSyncState(cwd, { sessionId, lastProcessedIndex: -1, maintenanceEnqueuedThrough: 5, conversationId: 'conv-a' });
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, -1, 2, 'a'));
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, 2, 5, 'b'));
    const seen: string[] = [];
    const result = await drainMaintenanceQueue({ cwd, sessionId }, {
      getConversation: getConversation as any,
      runPayload: async (payload) => {
        seen.push(payload.batchId);
        advanceSyncStateCursor(cwd, sessionId, payload.newLastProcessedIndex!);
        return 'completed';
      },
    });
    expect(result).toBe('drained');
    expect(seen).toEqual(['a', 'b']);
    expect(loadSyncState(cwd, sessionId).lastProcessedIndex).toBe(5);
    expect(listMaintenanceQueueJobs(cwd, sessionId)).toEqual([]);
  });

  it('keeps a retryable head and never runs later jobs past it', async () => {
    const cwd = makeRoot();
    const sessionId = 's';
    saveSyncState(cwd, { sessionId, lastProcessedIndex: -1, maintenanceEnqueuedThrough: 5, conversationId: 'conv-a' });
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, -1, 2, 'a'));
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, 2, 5, 'b'));
    const seen: string[] = [];
    const result = await drainMaintenanceQueue({ cwd, sessionId }, {
      getConversation: getConversation as any,
      runPayload: async (payload) => {
        seen.push(payload.batchId);
        return 'retryable_failure';
      },
    });
    expect(result).toBe('blocked');
    expect(seen).toEqual(['a']);
    expect(loadSyncState(cwd, sessionId).lastProcessedIndex).toBe(-1);
    expect(listMaintenanceQueueJobs(cwd, sessionId).map((item) => item.job_id)).toEqual(['a', 'b']);
  });

  it('drains through a publish-before-watermark crash after enqueue reconciles the durable frontier', async () => {
    const cwd = makeRoot();
    const sessionId = 's';
    saveSyncState(cwd, { sessionId, lastProcessedIndex: 2, maintenanceEnqueuedThrough: 2, conversationId: 'conv-a' });
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, 2, 5, 'crash-a'));
    enqueueMaintenanceRange(cwd, sessionId, 9, (start, through) => {
      const value = makeJob(cwd, sessionId, start, through, 'after-crash-b');
      publishMaintenanceQueueJob(cwd, value);
      return value;
    }, undefined, () => listMaintenanceQueueJobs(cwd, sessionId));

    const seen: string[] = [];
    const result = await drainMaintenanceQueue({ cwd, sessionId }, {
      getConversation: getConversation as any,
      runPayload: async (payload) => {
        seen.push(payload.batchId);
        advanceSyncStateCursor(cwd, sessionId, payload.newLastProcessedIndex!);
        return 'completed';
      },
    });
    expect(result).toBe('drained');
    expect(seen).toEqual(['crash-a', 'after-crash-b']);
    expect(loadSyncState(cwd, sessionId)).toMatchObject({ lastProcessedIndex: 9, maintenanceEnqueuedThrough: 9 });
    expect(listMaintenanceQueueJobs(cwd, sessionId)).toEqual([]);
  });

  it('rebinds canonical evidence to a rotated conversation without mutating the durable job', async () => {
    const cwd = makeRoot();
    const sessionId = 's';
    saveSyncState(cwd, { sessionId, lastProcessedIndex: -1, maintenanceEnqueuedThrough: 0, conversationId: 'conv-new' });
    const raw: any = {
      type: 'user', uuid: 'user-1', timestamp: '2026-08-26T00:00:00.000Z',
      message: { content: [{ type: 'text', text: '猫说了一句话' }] },
    };
    const queued = makeJob(cwd, sessionId, -1, 0, 'rotate');
    queued.transcript_messages = [raw];
    queued.payload.canonicalMessages = buildCanonicalMessages([raw], -1, 'conv-old');
    publishMaintenanceQueueJob(cwd, queued);
    const durableBefore = listMaintenanceQueueJobs(cwd, sessionId)[0];
    let seen: any;
    const result = await drainMaintenanceQueue({ cwd, sessionId }, {
      getConversation: (async () => 'conv-new') as any,
      runPayload: async (payload) => {
        seen = payload;
        advanceSyncStateCursor(cwd, sessionId, payload.newLastProcessedIndex!);
        return 'completed';
      },
    });
    expect(result).toBe('drained');
    expect(seen.conversationId).toBe('conv-new');
    expect(seen.canonicalMessages[0].conversation_id).toBe('conv-new');
    expect(seen.canonicalMessages[0].evidence_id).not.toBe(durableBefore.payload.canonicalMessages[0].evidence_id);
    expect(durableBefore.payload.conversationId).toBe('conv-a');
  });

  it('drops an obsolete completed job but stops on a gap instead of skipping ahead', async () => {
    const cwd = makeRoot();
    const sessionId = 's';
    saveSyncState(cwd, { sessionId, lastProcessedIndex: 2, maintenanceEnqueuedThrough: 7, conversationId: 'conv-a' });
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, -1, 2, 'old'));
    publishMaintenanceQueueJob(cwd, makeJob(cwd, sessionId, 4, 7, 'gap'));
    const seen: string[] = [];
    const result = await drainMaintenanceQueue({ cwd, sessionId }, {
      getConversation: getConversation as any,
      runPayload: async (payload) => { seen.push(payload.batchId); return 'completed'; },
    });
    expect(result).toBe('blocked');
    expect(seen).toEqual([]);
    expect(listMaintenanceQueueJobs(cwd, sessionId).map((item) => item.job_id)).toEqual(['gap']);
  });
});
