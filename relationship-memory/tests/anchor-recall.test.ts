import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractLexicalAnchorAnalysis,
  RelationshipMemoryRuntime,
  RelationshipMemoryStore,
} from '../src/index.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('lexical anchor shadow retrieval', () => {
  it('separates content anchors from context-dependent conversational signals', () => {
    const analysis = extractLexicalAnchorAnalysis(
      '对呀><🐾那个唤醒桥之前又掉了 MiMo-v2.5',
      {
        '唤醒桥': ['wake bridge'],
        'mimo-v2.5': ['MiMo-v2.5'],
      },
    );

    expect(analysis.anchors).toContain('唤醒桥');
    expect(analysis.anchors).toContain('mimo-v2.5');
    expect(analysis.context_signals).toEqual(expect.arrayContaining(['那个', '之前', '又']));
    expect(analysis.anchors).not.toContain('那个');
    expect(analysis.anchors).not.toContain('之前');
  });

  it('uses corpus rarity and anchor coverage to rank event-specific memories above generic tone matches', () => {
    const root = temp('rm-anchor-recall-');
    const store = new RelationshipMemoryStore(root, 'subject');
    const runtime = new RelationshipMemoryRuntime(store, new Map());
    const memories = [
      { memory_id: 'tone', summary: '琥珀和猫亲亲的日常', payload: { event: '亲亲琥珀', shared_meaning: '亲昵日常' }, observed_at: '2026-08-20T00:00:00.000Z' },
      { memory_id: 'fixed', summary: '猫和琥珀一起把唤醒桥修好了', payload: { event: '唤醒桥修好', shared_meaning: '修复 wake bridge' }, observed_at: '2026-08-21T00:00:00.000Z' },
      { memory_id: 'dropped', summary: '唤醒桥后来又掉线', payload: { event: '唤醒桥掉线', shared_meaning: 'wake bridge failure' }, observed_at: '2026-08-22T00:00:00.000Z' },
    ];
    for (const memory of memories) {
      store.appendMemory({
        schema_version: 1,
        memory_id: memory.memory_id,
        subject_id: 'subject',
        kind: 'shared_experience',
        summary: memory.summary,
        participants: ['user', 'assistant'],
        payload: memory.payload,
        status: 'active',
        observed_at: memory.observed_at,
        created_at: memory.observed_at,
        source_key: 'source-' + memory.memory_id,
        dedupe_key: 'dedupe-' + memory.memory_id,
      }, []);
    }
    const fixed = { memory_id: 'fixed' };

    const candidates = runtime.memorySearchRecallAnchorCandidates(['唤醒桥', '修好'], 20);

    expect(candidates[0].memory_id).toBe(fixed.memory_id);
    expect(candidates[0].anchor_retrieval.matched_anchor_count).toBe(2);
    expect(candidates[0].anchor_retrieval.anchor_score).toBeGreaterThan(candidates[1].anchor_retrieval.anchor_score);
  });
});
