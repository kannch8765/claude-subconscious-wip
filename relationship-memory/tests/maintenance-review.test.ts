import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord } from '../src/schema/index.js';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function memory(memoryId: string, summary: string): CanonicalMemoryRecord {
  return {
    schema_version: 1,
    memory_id: memoryId,
    subject_id: 'kohaku',
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

describe('maintenance review suggestions', () => {
  it('persists one idempotent pending merge suggestion without mutating canonical memory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-review-')); roots.push(root);
    const store = new RelationshipMemoryStore(root, 'kohaku');
    store.appendMemory(memory('mem-a', '猫偏好安静的咖啡店。'), []);
    store.appendMemory(memory('mem-b', '猫喜欢安静、不吵的咖啡店。'), []);
    const runtime = new RelationshipMemoryRuntime(
      store,
      new Map(),
      () => '2026-09-20T13:00:00.000Z',
    );

    const first = runtime.suggestMaintenanceReview('batch-1', 'merge', {
      memory_ids: ['mem-b', 'mem-a'],
      reason: '两条记录描述同一个稳定偏好，内容高度重叠。',
    });
    const second = runtime.suggestMaintenanceReview('batch-2', 'merge', {
      memory_ids: ['mem-a', 'mem-b'],
      reason: '同一对 memory 再次被发现。',
    });

    expect(first.outcome).toBe('accepted');
    expect(second).toEqual({ outcome: 'duplicate', review_id: first.review_id });
    expect(store.listMaintenanceReviewRecords()).toHaveLength(1);
    expect(store.listMaintenanceReviews()).toEqual([
      expect.objectContaining({
        review_id: first.review_id,
        kind: 'merge',
        memory_ids: ['mem-a', 'mem-b'],
        status: 'pending',
        batch_id: 'batch-1',
      }),
    ]);
    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);
    expect(store.listOwnerRevisions()).toEqual([]);
  });

  it('rejects malformed or unknown conflict suggestions without writing review state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-review-invalid-')); roots.push(root);
    const store = new RelationshipMemoryStore(root, 'kohaku');
    store.appendMemory(memory('mem-a', '猫偏好安静的咖啡店。'), []);
    const runtime = new RelationshipMemoryRuntime(store, new Map());

    expect(runtime.suggestMaintenanceReview('batch-1', 'conflict', {
      memory_ids: ['mem-a', 'mem-a'],
      reason: 'duplicate ids',
    }).outcome).toBe('rejected');
    expect(runtime.suggestMaintenanceReview('batch-1', 'conflict', {
      memory_ids: ['mem-a', 'mem-missing'],
      reason: '互相冲突',
    })).toEqual({
      outcome: 'rejected',
      reason: 'unknown canonical memory ID: mem-missing',
    });
    expect(store.listMaintenanceReviewRecords()).toEqual([]);
  });
});
