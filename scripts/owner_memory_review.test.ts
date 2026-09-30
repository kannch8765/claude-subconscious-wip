import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { RelationshipMemoryRuntime } from '../relationship-memory/src/tools/index.js';
import { executeOwnerMemoryReviewCommand } from './owner_memory_review.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-review-cli-'));
  roots.push(root);
  const store = new RelationshipMemoryStore(root, 'kohaku');
  const message = {
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    role: 'user' as const,
    quote: '猫喜欢安静的咖啡店。',
    captured_at: '2026-09-30T00:00:00.000Z',
  };
  const runtime = new RelationshipMemoryRuntime(
    store,
    new Map([[message.message_id, message]]),
    () => '2026-09-30T00:00:01.000Z',
  );
  store.beginBatch('batch-1', '2026-09-30T00:00:00.000Z');
  const remembered = runtime.remember('batch-1', {
    schema_version: 1,
    kind: 'user_preference',
    summary: '猫喜欢安静的咖啡店。',
    participants: ['user'],
    evidence_message_ids: [message.message_id],
    payload: { topic: '咖啡店', preference: '安静' },
  });
  if (!remembered.memory_id) throw new Error('fixture memory creation failed');
  const memoryId = remembered.memory_id;
  const env = {
    RELATIONSHIP_MEMORY_DIR: root,
    RELATIONSHIP_MEMORY_SUBJECT_ID: 'kohaku',
  } as NodeJS.ProcessEnv;
  return { root, store, env, memoryId };
}

describe('owner memory review command', () => {
  it('revises only the effective summary while preserving canonical genesis and evidence', () => {
    const { store, env, memoryId } = fixture();
    const before = store.getMemory(memoryId);
    const evidenceBefore = store.listEvidence();
    const result = executeOwnerMemoryReviewCommand({
      action: 'revise_summary',
      memory_id: memoryId,
      revision_id: 'telegram-1',
      summary: '猫喜欢安静、不吵、适合久坐的咖啡店。',
      note: 'telegram owner review',
    }, env) as any;

    expect(result.memory.summary).toBe('猫喜欢安静、不吵、适合久坐的咖啡店。');
    expect(result.memory.owner_corrected).toBe(true);
    expect(store.getMemory(memoryId)).toEqual(before);
    expect(store.listEvidence()).toEqual(evidenceBefore);
    expect(store.listOwnerRevisions()).toEqual([
      expect.objectContaining({
        revision_id: 'telegram-1',
        memory_id: memoryId,
        action: 'revise',
        replacement: expect.objectContaining({
          kind: 'user_preference',
          summary: '猫喜欢安静、不吵、适合久坐的咖啡店。',
          payload: { topic: '咖啡店', preference: '安静' },
        }),
      }),
    ]);
  });

  it('deactivates and restores without deleting genesis', () => {
    const { store, env, memoryId } = fixture();
    executeOwnerMemoryReviewCommand({
      action: 'deactivate',
      memory_id: memoryId,
      revision_id: 'telegram-off',
    }, env);
    expect((executeOwnerMemoryReviewCommand({ action: 'show', memory_id: memoryId }, env) as any).memory.status).toBe('inactive');

    executeOwnerMemoryReviewCommand({
      action: 'restore',
      memory_id: memoryId,
      revision_id: 'telegram-on',
    }, env);
    expect((executeOwnerMemoryReviewCommand({ action: 'show', memory_id: memoryId }, env) as any).memory.status).toBe('active');
    expect(store.getMemory(memoryId)?.summary).toBe('猫喜欢安静的咖啡店。');
  });
});
