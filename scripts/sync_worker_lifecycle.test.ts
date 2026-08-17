import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHistoricalWhisperMemory, renderHistoricalWhisperQuotes, runNativeWorkerPayloadFile, type LiveWorkerPayload } from './send_worker_native.js';
import { readPendingSubconWhispers } from './subcon_whisper_queue.js';
import { RelationshipMemoryStore, stableId } from '../relationship-memory/src/store/index.js';

const dirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('sync worker post-whisper lifecycle ownership', () => {
  it('renders transcript quotes and legacy-memory fallbacks with different provenance labels', () => {
    const text = renderHistoricalWhisperQuotes([
      { source_kind: 'transcript', role: 'user', quote: '猫的原句。', captured_at: '2026-08-01T10:00:00.000Z' },
      { source_kind: 'transcript', role: 'assistant', quote: '琥珀的原句。', captured_at: '2026-08-01T10:00:01.000Z' },
      { source_kind: 'legacy_memory', quote: '旧系统留下的记忆记录。', captured_at: '2026-06-04T02:12:11.000Z' },
    ]);
    expect(text).toContain('猫：「猫的原句。」');
    expect(text).toContain('当时琥珀：「琥珀的原句。」');
    expect(text).toContain('旧记忆记录：「旧系统留下的记忆记录。」');
    expect(text).not.toContain('当时琥珀：「旧系统留下的记忆记录。」');
    expect(renderHistoricalWhisperMemory('猫和琥珀一起聊过咖啡。', [
      { source_kind: 'transcript', role: 'user', quote: '今天想喝咖啡。', captured_at: '2026-08-01T10:00:00.000Z' },
    ])).toBe('记忆：\n猫和琥珀一起聊过咖啡。\n当时原文：\n[2026-08-01]\n猫：「今天想喝咖啡。」');
    expect(renderHistoricalWhisperMemory('搬家前先别急着买家具。', [
      { source_kind: 'legacy_memory', quote: '老婆说先搬家再买家具是血泪教训。', captured_at: '2026-06-04T02:12:11.000Z' },
    ])).toBe('记忆：\n搬家前先别急着买家具。\n历史来源：\n[2026-06-04]\n旧记忆记录：「老婆说先搬家再买家具是血泪教训。」');
  });
  it('keeps the foreground whisper successful but cancel/defers resources when continuation fails after release', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-worker-post-whisper-'));
    dirs.push(cwd);
    process.env.LETTA_API_KEY = 'test-key';
    process.env.RELATIONSHIP_MEMORY_DIR = path.join(cwd, 'relationship-memory');
    process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'kohaku';
    delete process.env.RELATIONSHIP_MEMORY_EMBEDDING_PROVIDER;

    const store = new RelationshipMemoryStore(process.env.RELATIONSHIP_MEMORY_DIR, 'kohaku');
    store.appendMemory({
      schema_version: 1,
      memory_id: 'mem-coffee-scene',
      subject_id: 'kohaku',
      kind: 'shared_experience',
      summary: '猫和琥珀聊到咖啡。',
      participants: ['user', 'assistant'],
      payload: { title: '咖啡', event: '猫和琥珀聊到咖啡。', shared_meaning: '一次关于咖啡的共同对话。' },
      status: 'active',
      observed_at: '2026-08-01T10:00:00.000Z',
      created_at: '2026-08-01T10:00:00.000Z',
      source_key: 'test-source',
      dedupe_key: 'test-dedupe',
    }, [
      {
        evidence_id: 'ev-coffee-user', memory_id: 'mem-coffee-scene', conversation_id: 'conv-old', message_id: 'user-old',
        role: 'user', quote: '猫说：「今天想喝咖啡。」真的好困。', captured_at: '2026-08-01T10:00:00.000Z', event_kind: 'user_text',
      },
      {
        evidence_id: 'ev-coffee-assistant', memory_id: 'mem-coffee-scene', conversation_id: 'conv-old', message_id: 'assistant-old',
        role: 'assistant', quote: '那我陪猫去找咖啡><🐾', captured_at: '2026-08-01T10:00:02.000Z', event_kind: 'assistant_text',
      },
      {
        evidence_id: 'ev-coffee-long', memory_id: 'mem-coffee-scene', conversation_id: 'conv-old', message_id: 'assistant-long',
        role: 'assistant', quote: '片段0。片段1。片段2。片段3。片段4。片段5。片段6。片段7。片段8。片段9。片段10。片段11。',
        captured_at: '2026-08-01T10:00:03.000Z', event_kind: 'assistant_text',
      },
    ]);

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
        const searchResult = await search.execute('search-1', { query: '咖啡' });
        const hit = searchResult.results[0];
        expect(hit.memory_id).toBe('mem-coffee-scene');
        expect(hit.quote_snippets.length).toBeGreaterThanOrEqual(2);
        const userSnippet = hit.quote_snippets.find((item: any) => item.role === 'user');
        const assistantSnippet = hit.quote_snippets.find((item: any) => item.role === 'assistant');
        const hiddenCanonicalSnippet = stableId('quote_snippet', {
          evidence_id: 'ev-coffee-long', index: 4, quote: '片段4。',
        });
        expect(hit.quote_snippets.some((item: any) => item.snippet_id === hiddenCanonicalSnippet)).toBe(false);
        await expect(whisper.execute('whisper-hidden', {
          memory_id: hit.memory_id,
          snippet_ids: [hiddenCanonicalSnippet],
        })).rejects.toThrow('only quote snippets surfaced by a prior memory_search');
        await whisper.execute('whisper-1', {
          memory_id: hit.memory_id,
          snippet_ids: [userSnippet.snippet_id, assistantSnippet.snippet_id],
          summary: '伪造摘要：这段文字绝不能进入前台。',
        });
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
    expect(pending[0].whisper.text).toContain('记忆：\n猫和琥珀聊到咖啡。\n当时原文：\n[2026-08-01]\n猫：「猫说：「今天想喝咖啡。」');
    expect(pending[0].whisper.text).toContain('当时琥珀：「那我陪猫去找咖啡><🐾」');
    expect(pending[0].whisper.text).not.toContain('伪造摘要：这段文字绝不能进入前台。');
    expect(pending[0].whisper.text).not.toContain('我记得猫以前提过咖啡');
  });
});
