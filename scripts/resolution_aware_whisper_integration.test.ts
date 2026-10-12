import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { RelationshipMemoryResolutionControlPlane } from '../relationship-memory/src/resolution/index.js';
import { readPendingSubconWhispers } from './subcon_whisper_queue.js';
import { sendViaNativeClient } from './send_worker_native.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_DIR;
  delete process.env.LETTA_API_KEY;
  delete process.env.RELATIONSHIP_MEMORY_SUBJECT_ID;
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-whisper-'));
  roots.push(root);
  process.env.RELATIONSHIP_MEMORY_DIR = root;
  process.env.RELATIONSHIP_MEMORY_SUBJECT_ID = 'kohaku';
  process.env.LETTA_API_KEY = 'test-only';
  const store = new RelationshipMemoryStore(root, 'kohaku');
  for (const [id, summary, observed_at] of [
    ['a', '过去喜欢浓咖啡', '2026-07-01T00:00:00.000Z'],
    ['b', '现在喜欢清淡咖啡', '2026-10-01T00:00:00.000Z'],
  ]) {
    store.appendMemory({
      schema_version: 1, memory_id: id, subject_id: 'kohaku',
      kind: 'user_preference', summary, participants: ['user'],
      payload: { topic: '咖啡', preference: summary },
      status: 'active', observed_at, created_at: observed_at,
      source_key: id, dedupe_key: id,
    }, [{
      evidence_id: 'e-'+id, memory_id: id, conversation_id: 'old', message_id: 'old-'+id,
      role: 'user', quote: '原话：'+summary+'。', captured_at: observed_at, event_kind: 'user_text',
    }]);
  }
  const runtime = new RelationshipMemoryRuntime(store, new Map());
  const control = new RelationshipMemoryResolutionControlPlane(store);
  return {root,store,runtime,control};
}

async function whisper(root: string, sessionId: string, onSearched?: () => void) {
  let selectedCalls = 0;
  const result = await sendViaNativeClient({
    agentId: 'agent-test', conversationId: 'conv-test', sessionId, cwd: root,
    message: 'test', batchId: 'batch-'+sessionId,
    canonicalMessages: [], assistantIntents: [], latestUserMessage: '咖啡',
  }, {
    createClient: () => ({}),
    openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
    runConversation: async (input: any) => {
      const search = input.tools.find((t: any)=>t.name==='memory_search');
      const deliver = input.tools.find((t: any)=>t.name==='deliver_whisper');
      const results = (await search.execute('search', {purpose:'foreground_recall',query:'咖啡'})).results;
      const chosen = results.find((m: any)=>m.memory_id==='b');
      expect(chosen?.quote_snippets?.length).toBeGreaterThan(0);
      selectedCalls++;
      onSearched?.();
      const outcome = await deliver.execute('deliver', {
        memory_id: chosen.memory_id, snippet_ids: [chosen.quote_snippets[0].snippet_id],
      });
      expect(['ok','suppressed_no_longer_current']).toContain(outcome.status);
      return {response:{stop_reason:{stop_reason:'end_turn'}},clientToolFailure:false} as any;
    },
  });
  expect(result).toBe('completed');
  expect(selectedCalls).toBe(1);
  return readPendingSubconWhispers(root,sessionId).map(x=>x.whisper.text);
}

describe('resolution-aware async Whisper end-to-end',()=>{
  it('transports reviewed current state, dated prior state and real historical quotes without a new Agent action', async()=>{
    const {root,runtime,control}=fixture();
    const review=runtime.suggestMaintenanceReview('review','relation',{
      memory_ids:['a','b'],relation:'changed_over_time',reason:'猫确认偏好变化',
    });
    control.resolveReview(review.review_id!,{
      resolution_id:'change-one',relation:'changed_over_time',target_memory_id:'b',
    });
    const queued=await whisper(root,'history');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain('记忆：现在喜欢清淡咖啡');
    expect(queued[0]).toContain('历史阶段（不代表当前状态）：');
    expect(queued[0]).toContain('[2026-07-01] 过去喜欢浓咖啡');
    expect(queued[0]).toContain('猫原话：「原话：过去喜欢浓咖啡。');
    expect(queued[0]).toContain('猫：「原话：现在喜欢清淡咖啡。');
  });

  it('limits reviewed scoped fact to its exact condition', async()=>{
    const {root,runtime,control}=fixture();
    const review=runtime.suggestMaintenanceReview('review','relation',{
      memory_ids:['a','b'],relation:'context_dependent',reason:'适用时机不同',
    });
    control.resolveReview(review.review_id!,{
      resolution_id:'scope-one',relation:'context_dependent',
      contexts:{a:'暑假在厦门',b:'在东京学习期间'},
    });
    const queued=await whisper(root,'context');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain('适用条件（已审核）：在东京学习期间');
    expect(queued[0]).not.toContain('暑假在厦门');
  });

  it('rejects a selected quote if owner conflict resolution hides the memory before transport', async()=>{
    const {root,runtime,control}=fixture();
    const review=runtime.suggestMaintenanceReview('review','relation',{
      memory_ids:['a','b'],relation:'conflict',reason:'未决矛盾',
    });
    const queued=await whisper(root,'newconflict',()=>{
      control.resolveReview(review.review_id!,{resolution_id:'conflict-one',relation:'conflict'});
    });
    expect(queued).toHaveLength(0);
  });
});
