import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord, EvidenceRecord } from '../src/schema/index.js';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';
import { RelationshipMemoryResolutionControlPlane } from '../src/resolution/index.js';
import { rebuildProjection } from '../src/projection/index.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function memory(memoryId: string, summary: string, observedAt: string, quote: string): { memory: CanonicalMemoryRecord; evidence: EvidenceRecord } {
  return {
    memory: {
      schema_version: 1,
      memory_id: memoryId,
      subject_id: 'kohaku',
      kind: 'user_preference',
      summary,
      participants: ['user'],
      payload: { topic: '咖啡店', preference: summary },
      status: 'active',
      observed_at: observedAt,
      created_at: observedAt,
      source_key: `src-${memoryId}`,
      dedupe_key: `dedupe-${memoryId}`,
    },
    evidence: {
      evidence_id: `ev-${memoryId}`,
      memory_id: memoryId,
      conversation_id: `conv-${memoryId}`,
      message_id: `msg-${memoryId}`,
      role: 'user',
      quote,
      captured_at: observedAt,
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relation-resolution-'));
  roots.push(root);
  const store = new RelationshipMemoryStore(root, 'kohaku');
  const a = memory('mem-a', '猫平时喜欢安静的咖啡店。', '2026-09-01T00:00:00.000Z', '证据A：想找安静一点的咖啡店。');
  const b = memory('mem-b', '猫现在喜欢不吵、适合久坐的咖啡店。', '2026-09-20T00:00:00.000Z', '证据B：最好不吵，可以慢慢坐。');
  store.appendMemory(a.memory, [a.evidence]);
  store.appendMemory(b.memory, [b.evidence]);
  const runtime = new RelationshipMemoryRuntime(store, new Map());
  const resolution = new RelationshipMemoryResolutionControlPlane(store, () => '2026-09-30T00:00:00.000Z');
  return { root, store, runtime, resolution };
}

function review(runtime: RelationshipMemoryRuntime, relation: 'same_meaning'|'changed_over_time'|'context_dependent'|'conflict'|'related'|'unrelated') {
  const result = runtime.suggestMaintenanceReview('batch-review', 'relation', {
    memory_ids: ['mem-a', 'mem-b'], relation, reason: `suggest ${relation}`,
  });
  if (!result.review_id) throw new Error('review fixture failed');
  return result.review_id;
}

describe('owner-confirmed relation resolution', () => {
  it('same_meaning exposes one current target with owner summary and evidence from the whole family', async () => {
    const { store, runtime, resolution } = fixture();
    const reviewId = review(runtime, 'same_meaning');
    resolution.resolveReview(reviewId, {
      resolution_id: 'resolve-1', relation: 'same_meaning', target_memory_id: 'mem-b',
      owner_summary: '猫偏好安静、不吵、适合慢慢坐的咖啡店。',
    });

    expect(store.listMemories().map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);
    expect(store.listEvidence()).toHaveLength(2);
    expect(runtime.memorySearch({}).map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);

    const current = await runtime.memorySearchRecallHybridWithEvidence({ query: '咖啡店' });
    expect(current).toHaveLength(1);
    expect(current[0]).toEqual(expect.objectContaining({
      memory_id: 'mem-b',
      summary: '猫偏好安静、不吵、适合慢慢坐的咖啡店。',
      resolution_relation: 'same_meaning',
      resolution_source_memory_ids: ['mem-a', 'mem-b'],
    }));
    expect(current[0].quote_snippets.map((item) => item.quote)).toEqual(expect.arrayContaining([
      '证据A：想找安静一点的咖啡店。',
      '证据B：最好不吵，可以慢慢坐。',
    ]));
    expect(store.getMaintenanceReview(reviewId)).toEqual(expect.objectContaining({ status: 'resolved', resolved_relation: 'same_meaning' }));
    expect(rebuildProjection(store).blocks.relationship_context).toContain('猫偏好安静、不吵、适合慢慢坐的咖啡店。');
    expect(rebuildProjection(store).blocks.relationship_context).not.toContain('猫平时喜欢安静的咖啡店。');
  });

  it('changed_over_time keeps the newer target current and the older memory maintenance-visible', async () => {
    const { store, runtime, resolution } = fixture();
    const reviewId = review(runtime, 'changed_over_time');
    resolution.resolveReview(reviewId, {
      resolution_id: 'resolve-2', relation: 'changed_over_time', target_memory_id: 'mem-b',
    });

    expect(runtime.memorySearch({}).map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);
    expect((await runtime.memorySearchRecallHybrid({}))).toEqual([
      expect.objectContaining({
        memory_id: 'mem-b',
        resolution_relation: 'changed_over_time',
        resolution_historical_memory_ids: ['mem-a'],
      }),
    ]);
    expect(store.getMaintenanceReview(reviewId)?.status).toBe('resolved');
  });

  it('context_dependent keeps both memories current and makes their scopes searchable', async () => {
    const { runtime, resolution } = fixture();
    const reviewId = review(runtime, 'context_dependent');
    resolution.resolveReview(reviewId, {
      resolution_id: 'resolve-3', relation: 'context_dependent',
      contexts: { 'mem-a': '工作日白天', 'mem-b': '周末约会' },
    });

    const workday = await runtime.memorySearchRecallHybrid({ query: '工作日' });
    expect(workday.map((item) => item.memory_id)).toEqual(['mem-a']);
    expect(workday[0].resolution_context).toBe('工作日白天');
    const weekend = await runtime.memorySearchRecallHybrid({ query: '周末约会' });
    expect(weekend.map((item) => item.memory_id)).toEqual(['mem-b']);
    expect(weekend[0].resolution_context).toBe('周末约会');
  });

  it('conflict suppresses uncertain facts from foreground while preserving maintenance access', async () => {
    const { store, runtime, resolution } = fixture();
    const reviewId = review(runtime, 'conflict');
    resolution.resolveReview(reviewId, { resolution_id: 'resolve-4', relation: 'conflict' });

    expect(await runtime.memorySearchRecallHybrid({})).toEqual([]);
    expect(runtime.memorySearch({}).map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);
    expect(store.listEvidence()).toHaveLength(2);
  });

  it('related keeps both memories and overlays symmetric lightweight links', async () => {
    const { runtime, resolution } = fixture();
    const reviewId = review(runtime, 'related');
    resolution.resolveReview(reviewId, { resolution_id: 'resolve-5', relation: 'related' });

    const current = await runtime.memorySearchRecallHybrid({});
    expect(current).toEqual(expect.arrayContaining([
      expect.objectContaining({ memory_id: 'mem-a', linked_memory_ids: ['mem-b'], resolution_relation: 'related' }),
      expect.objectContaining({ memory_id: 'mem-b', linked_memory_ids: ['mem-a'], resolution_relation: 'related' }),
    ]));
    expect((await runtime.memorySearchRecallHybrid({ linked_memory_id: 'mem-b' })).map((item) => item.memory_id)).toEqual(['mem-a']);
  });

  it('unrelated dismisses the review without changing the current memory view', async () => {
    const { store, runtime, resolution } = fixture();
    const reviewId = review(runtime, 'unrelated');
    resolution.resolveReview(reviewId, { resolution_id: 'resolve-6', relation: 'unrelated' });

    expect((await runtime.memorySearchRecallHybrid({})).map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);
    expect(store.getMaintenanceReview(reviewId)).toEqual(expect.objectContaining({ status: 'dismissed', resolved_relation: 'unrelated' }));
    expect(runtime.suggestMaintenanceReview('batch-repeat', 'relation', {
      memory_ids: ['mem-b', 'mem-a'], relation: 'same_meaning', reason: 'same set again',
    }).outcome).toBe('duplicate');
  });

  it('undo restores the independent current views without mutating genesis or evidence', async () => {
    const { store, runtime, resolution } = fixture();
    const reviewId = review(runtime, 'same_meaning');
    const memoriesBefore = fs.readFileSync(path.join(store.rootDir, 'memories.jsonl'), 'utf8');
    const evidenceBefore = fs.readFileSync(path.join(store.rootDir, 'evidence.jsonl'), 'utf8');
    resolution.resolveReview(reviewId, {
      resolution_id: 'resolve-7', relation: 'same_meaning', target_memory_id: 'mem-b', owner_summary: '合并后的版本',
    });
    expect((await runtime.memorySearchRecallHybrid({})).map((item) => item.memory_id)).toEqual(['mem-b']);

    resolution.undoReview(reviewId, { resolution_id: 'undo-7', note: 'owner changed mind' });
    expect((await runtime.memorySearchRecallHybrid({})).map((item) => item.memory_id)).toEqual(['mem-a', 'mem-b']);
    expect(store.getMaintenanceReview(reviewId)?.status).toBe('pending');
    expect(fs.readFileSync(path.join(store.rootDir, 'memories.jsonl'), 'utf8')).toBe(memoriesBefore);
    expect(fs.readFileSync(path.join(store.rootDir, 'evidence.jsonl'), 'utf8')).toBe(evidenceBefore);
  });

  it('validates relation-specific owner inputs and resolution ids', () => {
    const { store, runtime, resolution } = fixture();
    const reviewId = review(runtime, 'context_dependent');
    expect(() => resolution.resolveReview(reviewId, {
      resolution_id: 'bad-context', relation: 'context_dependent', contexts: { 'mem-a': 'only one' },
    })).toThrow(/one context for every reviewed memory_id/);

    const record = resolution.resolveReview(reviewId, {
      resolution_id: 'resolve-8', relation: 'context_dependent', contexts: { 'mem-a': 'A scope', 'mem-b': 'B scope' },
    });
    expect(resolution.resolveReview(reviewId, {
      resolution_id: 'resolve-8', relation: 'context_dependent', contexts: { 'mem-a': 'A scope', 'mem-b': 'B scope' },
    })).toEqual(record);
    expect(store.listMemoryResolutionRecords()).toHaveLength(1);
  });
});
