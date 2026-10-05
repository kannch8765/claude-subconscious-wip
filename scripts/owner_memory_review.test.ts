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

  it('lists searchable effective memories, enriches pending reviews, and reports status counts', () => {
    const { store, env, memoryId } = fixture();
    store.appendMaintenanceReview({
      schema_version: 1,
      review_id: 'review-1',
      subject_id: 'kohaku',
      kind: 'relation',
      suggested_relation: 'changed_over_time',
      memory_ids: [memoryId],
      reason: 'newer preference may supersede older wording',
      status: 'pending',
      created_at: '2026-09-30T00:00:02.000Z',
      recorded_at: '2026-09-30T00:00:02.000Z',
    });

    const search = executeOwnerMemoryReviewCommand({
      action: 'search',
      query: '安静',
      active: true,
      limit: 5,
    }, env) as any;
    expect(search.total).toBe(1);
    expect(search.memories[0]).toEqual(expect.objectContaining({
      memory_id: memoryId,
      summary: '猫喜欢安静的咖啡店。',
      status: 'active',
    }));

    const reviews = executeOwnerMemoryReviewCommand({ action: 'list_pending_reviews', limit: 5 }, env) as any;
    expect(reviews.total).toBe(1);
    expect(reviews.reviews[0]).toEqual(expect.objectContaining({
      review_id: 'review-1',
      suggested_relation: 'changed_over_time',
      status: 'pending',
    }));
    expect(reviews.reviews[0].memories[0]).toEqual(expect.objectContaining({
      memory_id: memoryId,
      summary: '猫喜欢安静的咖啡店。',
    }));

    const status = executeOwnerMemoryReviewCommand({ action: 'status' }, env) as any;
    expect(status.subject_id).toBe('kohaku');
    expect(status.memory).toEqual(expect.objectContaining({
      total: 1,
      active: 1,
      inactive: 0,
      owner_corrected: 0,
    }));
    expect(status.review).toEqual({ pending: 1, resolved: 0, dismissed: 0 });
    expect(status.resolution).toEqual({
      active: 0,
      by_relation: {
        same_meaning: 0,
        changed_over_time: 0,
        context_dependent: 0,
        conflict: 0,
        related: 0,
        unrelated: 0,
      },
      same_meaning: {
        families: 0,
        source_memories: 0,
        current_memories: 0,
        folded_memories: 0,
      },
    });
    expect(status.memory.projected_out_active).toBe(0);
    expect(status.memory.latest).toEqual(expect.objectContaining({ memory_id: memoryId }));
  });

  it('resolves and undoes a pending relation through the owner review bridge', () => {
    const { store, env, memoryId } = fixture();
    const first = store.getMemory(memoryId)!;
    store.appendMemory({
      ...first,
      memory_id: 'mem-second',
      summary: '猫也喜欢不吵、适合久坐的咖啡店。',
      payload: { topic: '咖啡店', preference: '不吵、适合久坐' },
      source_key: 'source-second',
      dedupe_key: 'dedupe-second',
      observed_at: '2026-09-30T00:00:02.000Z',
      created_at: '2026-09-30T00:00:02.000Z',
    }, []);
    store.appendMaintenanceReview({
      schema_version: 1,
      review_id: 'review-resolution',
      subject_id: 'kohaku',
      kind: 'relation',
      suggested_relation: 'same_meaning',
      memory_ids: [memoryId, 'mem-second'].sort(),
      reason: 'same preference',
      status: 'pending',
      created_at: '2026-09-30T00:00:03.000Z',
      recorded_at: '2026-09-30T00:00:03.000Z',
    });

    const resolved = executeOwnerMemoryReviewCommand({
      action: 'resolve_review',
      review_id: 'review-resolution',
      resolution_id: 'telegram-resolution-1',
      relation: 'same_meaning',
      target_memory_id: 'mem-second',
      owner_summary: '猫偏好安静、不吵、适合久坐的咖啡店。',
    }, env) as any;
    expect(resolved.review).toEqual(expect.objectContaining({ status: 'resolved', resolved_relation: 'same_meaning' }));
    const current = executeOwnerMemoryReviewCommand({ action: 'search', active: true, limit: 8 }, env) as any;
    expect(current.total).toBe(1);
    expect(current.memories[0]).toEqual(expect.objectContaining({
      memory_id: 'mem-second',
      summary: '猫偏好安静、不吵、适合久坐的咖啡店。',
      resolution_relation: 'same_meaning',
    }));
    const mergedStatus = executeOwnerMemoryReviewCommand({ action: 'status' }, env) as any;
    expect(mergedStatus.memory).toEqual(expect.objectContaining({
      active: 1,
      canonical_active: 2,
      projected_out_active: 1,
    }));
    expect(mergedStatus.resolution.same_meaning).toEqual({
      families: 1,
      source_memories: 2,
      current_memories: 1,
      folded_memories: 1,
    });
    expect(mergedStatus.resolution.by_relation.same_meaning).toBe(1);

    const undone = executeOwnerMemoryReviewCommand({
      action: 'undo_review',
      review_id: 'review-resolution',
      resolution_id: 'telegram-resolution-undo-1',
    }, env) as any;
    expect(undone.review.status).toBe('pending');
    const restored = executeOwnerMemoryReviewCommand({ action: 'search', active: true, limit: 8 }, env) as any;
    expect(restored.total).toBe(2);
    expect(store.listMemoryResolutionRecords()).toHaveLength(2);
  });

});
