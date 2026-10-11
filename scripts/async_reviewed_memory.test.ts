import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord, EvidenceRecord } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { RelationshipMemoryResolutionControlPlane } from '../relationship-memory/src/resolution/index.js';
import { sendViaNativeClient } from './send_worker_native.js';
import { readPendingSubconWhispers } from './subcon_whisper_queue.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_DIR;
  delete process.env.LETTA_API_KEY;
});

function addMemory(store: RelationshipMemoryStore, id: string, summary: string) {
  const time = '2026-10-10T00:00:00.000Z';
  const memory: CanonicalMemoryRecord = {
    schema_version: 1, memory_id: id, subject_id: 'kohaku', kind: 'user_preference',
    summary, participants: ['user'], payload: { topic: id, preference: summary },
    status: 'active', observed_at: time, created_at: time,
    source_key: id, dedupe_key: id,
  };
  const evidence: EvidenceRecord = {
    evidence_id: 'ev-' + id, memory_id: id, conversation_id: 'conv-' + id,
    message_id: 'msg-' + id, role: 'user', quote: '原话：' + summary, captured_at: time,
  };
  store.appendMemory(memory, [evidence]);
}

describe('owner-reviewed async recall and automatic related context', () => {
  it('retrieves merged current memories, then automatically adds only direct, summary-only relations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'async-review-whisper-')); dirs.push(root);
    process.env.RELATIONSHIP_MEMORY_DIR = root;
    process.env.LETTA_API_KEY = 'test-only';
    const store = new RelationshipMemoryStore(root, 'kohaku');
    addMemory(store, 'mem-a', '猫偏好安静的咖啡店');
    addMemory(store, 'mem-b', '猫偏好可以久坐的咖啡店');
    addMemory(store, 'mem-c', '猫整理过咖啡店清单');
    addMemory(store, 'mem-d', '猫也整理过书店清单');

    const memoryRuntime = new RelationshipMemoryRuntime(store, new Map());
    const review = (ids: string[], relation: 'same_meaning' | 'related') => {
      const result = memoryRuntime.suggestMaintenanceReview('batch-review', 'relation', {
        memory_ids: ids, relation, reason: 'owner-confirmed relation',
      });
      expect(result.outcome).toBe('accepted');
      return result.review_id!;
    };
    const merge = review(['mem-a', 'mem-b'], 'same_meaning');
    const related = review(['mem-a', 'mem-c'], 'related');
    const distant = review(['mem-c', 'mem-d'], 'related');
    const control = new RelationshipMemoryResolutionControlPlane(store);
    control.resolveReview(related, { resolution_id: 'related-a-c', relation: 'related' });
    control.resolveReview(distant, { resolution_id: 'related-c-d', relation: 'related' });
    control.resolveReview(merge, {
      resolution_id: 'merge-a-b', relation: 'same_meaning', target_memory_id: 'mem-b',
      owner_summary: '猫喜欢安静而且可以久坐的咖啡店',
    });

    let maintenance: any[] = [];
    let foreground: any[] = [];
    let deliveredActions = 0;
    const completed = await sendViaNativeClient({
      agentId: 'agent-test', conversationId: 'conversation-test', sessionId: 'session-reviewed',
      message: 'test', cwd: root, batchId: 'batch-reviewed-async',
      canonicalMessages: [], assistantIntents: [], latestUserMessage: '安静的咖啡店',
    }, {
      createClient: () => ({}),
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
      runConversation: async (input: any) => {
        const search = input.tools.find((tool: any) => tool.name === 'memory_search');
        const whisper = input.tools.find((tool: any) => tool.name === 'deliver_whisper');
        maintenance = (await search.execute('m', { purpose: 'maintenance', query: '咖啡店' })).results;
        foreground = (await search.execute('f', { purpose: 'foreground_recall', query: '安静的咖啡店' })).results;
        const primary = foreground.find((item: any) => item.memory_id === 'mem-b');
        expect(primary?.quote_snippets).toHaveLength(2);
        deliveredActions += 1;
        const delivered = await whisper.execute('w', {
          memory_id: 'mem-b', snippet_ids: [primary.quote_snippets[0].snippet_id],
        });
        expect(delivered.status).toBe('ok');
        return { response: { stop_reason: { stop_reason: 'end_turn' } }, clientToolFailure: false } as any;
      },
    });
    expect(completed).toBe('completed');
    expect(deliveredActions).toBe(1);
    expect(maintenance.map((x) => x.memory_id)).not.toContain('mem-a');
    expect(foreground.map((x) => x.memory_id)).not.toContain('mem-a');
    expect(foreground.find((x) => x.memory_id === 'mem-b')?.summary).toContain('安静而且可以久坐');
    const queued = readPendingSubconWhispers(root, 'session-reviewed');
    expect(queued).toHaveLength(1);
    const text = queued[0].whisper.text;
    expect(text).toContain('记忆：猫喜欢安静而且可以久坐的咖啡店');
    expect(text).toContain('原话：');
    expect(text).toContain('关联记忆（背景，仅摘要）：');
    expect(text).toContain('猫整理过咖啡店清单');
    expect(text).not.toContain('猫也整理过书店清单');
    expect(text).not.toContain('原话：猫整理过咖啡店清单');
    expect(store.listMemories()).toHaveLength(4);
    expect(store.listMemoryResolutionRecords()).toHaveLength(3);
  });
});
