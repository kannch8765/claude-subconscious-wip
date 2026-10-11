import { describe, expect, it } from 'vitest';
import type { EffectiveMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { renderRelatedWhisperContext } from './related_whisper.js';

function memory(id: string, summary: string, links: string[] = [], status: 'active'|'inactive' = 'active'): EffectiveMemoryRecord {
  return {
    schema_version: 1, memory_id: id, subject_id: 'kohaku', kind: 'user_preference',
    summary, participants: ['user'], payload: { topic: id, preference: summary }, status,
    observed_at: '2026-10-10T00:00:00.000Z', created_at: '2026-10-10T00:00:00.000Z',
    source_key: id, dedupe_key: id, linked_memory_ids: links, owner_corrected: false,
  };
}

describe('automatic async related whisper context', () => {
  it('follows only owner-projected direct links, never a neighbor of a neighbor', () => {
    const view = [
      memory('a', '东京 Meetup', ['b']),
      memory('b', '猫喜欢 AI 活动', ['a', 'c']),
      memory('c', '猫喜欢技术书', ['b']),
    ];
    expect(renderRelatedWhisperContext('a', view, 'meetup')).toContain('猫喜欢 AI 活动');
    expect(renderRelatedWhisperContext('a', view, 'meetup')).not.toContain('技术书');
  });

  it('filters missing, inactive, session-known, and duplicate summaries without treating background as delivered', () => {
    const view = [
      memory('a', '咖啡店', ['b', 'c', 'd', 'x', 'b']),
      memory('b', '咖啡店'),
      memory('c', '安静的咖啡', [], 'inactive'),
      memory('d', '适合久坐的咖啡店'),
    ];
    expect(renderRelatedWhisperContext('a', view, '咖啡店')).toContain('适合久坐');
    expect(renderRelatedWhisperContext('a', view, '咖啡店')).not.toContain('- 咖啡店\n');
    expect(renderRelatedWhisperContext('a', view, '咖啡店', new Set(['d']))).toBe('');
  });

  it('ranks direct neighbors by current topic within a text budget, without a graph-degree cutoff', () => {
    const view = [
      memory('a', '活动', ['b', 'c', 'd', 'e']),
      memory('b', '咖啡店与午饭'),
      memory('c', '学习案例面试的方法'),
      memory('d', '参加东京 AI 技术活动'),
      memory('e', '预订秋天的旅行'),
    ];
    const out = renderRelatedWhisperContext('a', view, '东京 AI 活动', new Set(), 35);
    expect(out).toContain('参加东京 AI 技术活动');
    expect(out).not.toContain('咖啡店');
    expect(out.length).toBeLessThanOrEqual(35);
  });

  it('does not reintroduce a related merged family already known by its old source id', () => {
    const family = { ...memory('b', '合并后的记忆'), resolution_source_memory_ids: ['a', 'b'] };
    const main = memory('c', '本次主记忆', ['b']);
    expect(renderRelatedWhisperContext('c', [main, family], '记忆', new Set(['a']))).toBe('');
  });

  it('returns no related block for isolated or suppressed main memories', () => {
    expect(renderRelatedWhisperContext('a', [memory('a', 'A')], 'A')).toBe('');
    expect(renderRelatedWhisperContext('a', [memory('a', 'A', ['b'], 'inactive'), memory('b', 'B')], 'B')).toBe('');
  });
});
