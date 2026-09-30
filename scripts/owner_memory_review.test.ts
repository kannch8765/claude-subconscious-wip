import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';
import { executeOwnerMemoryReviewCommand } from './owner_memory_review.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-review-cli-'));
  roots.push(root);
  const store = new RelationshipMemoryStore(root, 'kohaku');
  const memory: CanonicalMemoryRecord = {
    schema_version: 1,
    memory_id: 'mem-1',
    subject_id: 'kohaku',
    kind: 'user_preference',
    summary: '猫喜欢安静的咖啡店。',
    participants: ['user'],
    payload: { topic: '咖啡店', preference: '安静' },
    status: 'active',
    observed_at: '2026-09-30T00:00:00.000Z',
    created_at: '2026-09-30T00:00:00.000Z',
    source_key: 'source-1',
    dedupe_key: 'dedupe-1',
  };
  store.appendMemory(memory, []);
  const env = {
    RELATIONSHIP_MEMORY_DIR: root,
    RELATIONSHIP_MEMORY_SUBJECT_ID: 'kohaku',
  } as NodeJS.ProcessEnv;
  return { root, store, env };
}

describe('owner memory review command', () => {
  it('revises only the effective summary while preserving canonical genesis', () => {
    const { store, env } = fixture();
    const before = store.getMemory('mem-1');
    const result = executeOwnerMemoryReviewCommand({
      action: 'revise_summary',
      memory_id: 'mem-1',
      revision_id: 'telegram-1',
      summary: '猫喜欢安静、不吵、适合久坐的咖啡店。',
      note: 'telegram owner review',
    }, env) as any;

    expect(result.memory.summary).toBe('猫喜欢安静、不吵、适合久坐的咖啡店。');
    expect(result.memory.owner_corrected).toBe(true);
    expect(store.getMemory('mem-1')).toEqual(before);
    expect(store.listOwnerRevisions()).toEqual([
      expect.objectContaining({
        revision_id: 'telegram-1',
        memory_id: 'mem-1',
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
    const { store, env } = fixture();
    executeOwnerMemoryReviewCommand({
      action: 'deactivate',
      memory_id: 'mem-1',
      revision_id: 'telegram-off',
    }, env);
    expect((executeOwnerMemoryReviewCommand({ action: 'show', memory_id: 'mem-1' }, env) as any).memory.status).toBe('inactive');

    executeOwnerMemoryReviewCommand({
      action: 'restore',
      memory_id: 'mem-1',
      revision_id: 'telegram-on',
    }, env);
    expect((executeOwnerMemoryReviewCommand({ action: 'show', memory_id: 'mem-1' }, env) as any).memory.status).toBe('active');
    expect(store.getMemory('mem-1')?.summary).toBe('猫喜欢安静的咖啡店。');
  });
});
