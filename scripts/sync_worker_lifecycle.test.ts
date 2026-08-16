import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runNativeWorkerPayloadFile, type LiveWorkerPayload } from './send_worker_native.js';
import { readPendingSubconWhispers } from './subcon_whisper_queue.js';

const dirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('sync worker post-whisper lifecycle ownership', () => {
  it('keeps the foreground whisper successful but cancel/defers resources when continuation fails after release', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-worker-post-whisper-'));
    dirs.push(cwd);
    process.env.LETTA_API_KEY = 'test-key';
    process.env.RELATIONSHIP_MEMORY_DIR = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'kohaku';
    delete process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER;

    const payloadFile = path.join(cwd, 'payload.json');
    const checkpointFile = path.join(cwd, 'checkpoint.json');
    const payload: LiveWorkerPayload = {
      mode: 'sync',
      agentId: 'agent-11111111-1111-4111-8111-111111111111',
      syncAgentId: 'agent-11111111-1111-4111-8111-111111111111',
      syncBlockIds: ['block-a', 'block-b'],
      conversationId: 'conv-22222222-2222-4222-8222-222222222222',
      sessionId: 'session-test',
      message: '<subcon_sync_foreground_turn>coffee</subcon_sync_foreground_turn>',
      cwd,
      batchId: 'sync_batch_test',
      canonicalMessages: [],
      assistantIntents: [],
      latestUserMessage: '咖啡',
      syncCheckpointFile: checkpointFile,
      syncTurnId: 'turn-test',
      cleanupSyncResourcesOnFinish: true,
    };
    fs.writeFileSync(payloadFile, JSON.stringify(payload), { mode: 0o600 });
    const deferred: Array<[string, string, string[]]> = [];
    let completedCleanup = 0;

    await runNativeWorkerPayloadFile(payloadFile, {
      createClient: () => ({}),
      runConversation: (async (input: any) => {
        const search = input.tools.find((tool: any) => tool.name === 'memory_search');
        const whisper = input.tools.find((tool: any) => tool.name === 'deliver_whisper');
        expect(search).toBeTruthy();
        expect(whisper).toBeTruthy();
        await search.execute('search-1', { query: '咖啡' });
        await whisper.execute('whisper-1', { text: '我记得猫以前提过咖啡。' });
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
        expect(checkpoint.status).toBe('whisper');
        // Simulate the foreground wrapper consuming the durable release point.
        fs.unlinkSync(checkpointFile);
        throw new Error('synthetic continuation failure after foreground release');
      }) as any,
      cancelAndDefer: async (_apiKey, conversationId, agentId, blockIds) => {
        deferred.push([conversationId, agentId, [...blockIds]]);
      },
      cleanupCompleted: async () => { completedCleanup += 1; },
    });

    expect(deferred).toEqual([[payload.conversationId, payload.syncAgentId!, ['block-a', 'block-b']]]);
    expect(completedCleanup).toBe(0);
    expect(fs.existsSync(payloadFile)).toBe(false);
    expect(fs.existsSync(checkpointFile)).toBe(false);
    const pending = readPendingSubconWhispers(cwd, payload.sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].whisper).toEqual(expect.objectContaining({ source: 'sync', turn_id: 'turn-test' }));
  });
});
