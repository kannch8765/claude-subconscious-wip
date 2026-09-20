import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { sendViaNativeClient } from './send_worker_native.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  delete process.env.RELATIONSHIP_MEMORY_DIR;
  delete process.env.LETTA_API_KEY;
});

function memory(memoryId: string, summary: string): CanonicalMemoryRecord {
  return {
    schema_version: 1,
    memory_id: memoryId,
    subject_id: 'local-user',
    kind: 'user_preference',
    summary,
    participants: ['user'],
    payload: { topic: '咖啡店', preference: summary },
    status: 'active',
    observed_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    source_key: `src-${memoryId}`,
    dedupe_key: `dedupe-${memoryId}`,
  };
}

describe('live memory maintenance review tools', () => {
  it('requires same-run maintenance search provenance before queueing merge review', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-maintenance-review-')); roots.push(root);
    process.env.RELATIONSHIP_MEMORY_DIR = root;
    process.env.LETTA_API_KEY = 'test-only';

    const store = new RelationshipMemoryStore(root, 'local-user');
    store.appendMemory(memory('mem-a', '猫偏好安静的咖啡店。'), []);
    store.appendMemory(memory('mem-b', '猫喜欢安静、不吵的咖啡店。'), []);

    let gateError = '';
    let accepted: any;
    let asyncToolNames: string[] = [];
    const completion = await sendViaNativeClient({
      agentId: 'agent-test',
      conversationId: 'conversation-test',
      sessionId: 'session-test',
      message: '<claude_code_session_update>test</claude_code_session_update>',
      cwd: root,
      batchId: 'batch-maintenance-review',
      canonicalMessages: [],
      assistantIntents: [],
      latestUserMessage: '',
    }, {
      createClient: () => ({}),
      openStdioMcp: async () => ({ tools: [], close: async () => {} } as any),
      runConversation: async (input: any) => {
        asyncToolNames = input.tools.map((tool: any) => tool.name);
        const search = input.tools.find((tool: any) => tool.name === 'memory_search');
        const merge = input.tools.find((tool: any) => tool.name === 'suggest_memory_merge');

        try {
          await merge.execute('merge-before-search', {
            memory_ids: ['mem-a', 'mem-b'],
            reason: '这两条似乎重复。',
          });
        } catch (error) {
          gateError = error instanceof Error ? error.message : String(error);
        }

        const results = (await search.execute('maintenance-search', {
          purpose: 'maintenance',
          limit: 10,
        })).results;
        expect(results.map((item: any) => item.memory_id)).toEqual(expect.arrayContaining(['mem-a', 'mem-b']));

        accepted = await merge.execute('merge-after-search', {
          memory_ids: ['mem-b', 'mem-a'],
          reason: '两条 canonical memory 都描述猫偏好安静的咖啡店。',
        });
        return { response: { stop_reason: { stop_reason: 'end_turn' } }, clientToolFailure: false } as any;
      },
    });

    expect(completion).toBe('completed');
    expect(asyncToolNames).toEqual(expect.arrayContaining(['flag_memory_conflict', 'suggest_memory_merge']));
    expect(gateError).toContain('prior purpose=maintenance memory_search');
    expect(accepted.outcome).toBe('accepted');
    expect(store.listMaintenanceReviews()).toEqual([
      expect.objectContaining({
        review_id: accepted.review_id,
        kind: 'merge',
        memory_ids: ['mem-a', 'mem-b'],
        status: 'pending',
      }),
    ]);
    expect(store.listMemories()).toHaveLength(2);
    expect(store.listOwnerRevisions()).toEqual([]);
  });

  it('does not expose maintenance review mutation tools to sync foreground recall', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-maintenance-review-')); roots.push(root);
    process.env.RELATIONSHIP_MEMORY_DIR = root;
    process.env.LETTA_API_KEY = 'test-only';
    let toolNames: string[] = [];

    const completion = await sendViaNativeClient({
      mode: 'sync',
      agentId: 'agent-test',
      conversationId: 'conversation-sync',
      sessionId: 'session-sync',
      message: '<sync_subcon_turn>test</sync_subcon_turn>',
      cwd: root,
      batchId: 'batch-sync',
      canonicalMessages: [],
      assistantIntents: [],
      latestUserMessage: '',
      syncTurnId: 'turn-sync',
    }, {
      createClient: () => ({}),
      runConversation: async (input: any) => {
        toolNames = input.tools.map((tool: any) => tool.name);
        return { response: { stop_reason: { stop_reason: 'end_turn' } }, clientToolFailure: false } as any;
      },
    });

    expect(completion).toBe('completed');
    expect(toolNames).toEqual(expect.arrayContaining(['memory_search', 'entity_search', 'deliver_whisper']));
    expect(toolNames).not.toContain('flag_memory_conflict');
    expect(toolNames).not.toContain('suggest_memory_merge');
  });
});
