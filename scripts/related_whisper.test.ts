import { describe, expect, it } from 'vitest';
import type { EffectiveMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { renderRelatedWhisperContext, selectRelatedWhisperContext } from './related_whisper.js';

function memory(id: string, summary: string, links: string[] = [], status: 'active'|'inactive' = 'active'): EffectiveMemoryRecord {
  return {
    schema_version: 1, memory_id: id, subject_id: 'kohaku', kind: 'user_preference',
    summary, participants: ['user'], payload: { topic: id, preference: summary }, status,
    observed_at: '2026-10-10T00:00:00.000Z', created_at: '2026-10-10T00:00:00.000Z',
    source_key: id, dedupe_key: id, linked_memory_ids: links, resolution_confirmed_related_memory_ids: links, owner_corrected: false,
  };
}

describe('automatic async related whisper context', () => {
  it('does not surface model-authored canonical links without owner confirmation', () => {
    const main = { ...memory('a', '猫喜欢东京 AI 活动', ['b']), resolution_confirmed_related_memory_ids: [] };
    const related = memory('b', '猫喜欢科技社区活动');
    expect(renderRelatedWhisperContext('a', [main, related], '东京 AI')).toBe('');
    expect(renderRelatedWhisperContext('a', [{ ...main, resolution_confirmed_related_memory_ids: ['b'] }, related], '东京 AI'))
      .toContain('猫喜欢科技社区活动');
  });

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

  it('uses MMR to prefer a complementary second related memory over a near-duplicate', () => {
    const view = [
      memory('main', '猫参加过东京 AI Meetup', ['b', 'c', 'd', 'e']),
      memory('b', '猫喜欢参加东京 AI 社区活动'),
      memory('c', '猫喜欢参加东京 AI 社区活动线下交流'),
      memory('d', '猫会在 connpass 寻找东京 AI 活动'),
      memory('e', '猫在 Meetup 拿到贴纸'),
    ];
    const output = renderRelatedWhisperContext('main', view, '东京 AI 活动');
    const lines = output.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toContain('猫喜欢参加东京 AI');
    expect(lines.join(' ')).toContain('connpass');
    expect(lines.filter((line) => line.includes('社区活动'))).toHaveLength(1);
  });

  it('uses diversity to break equally relevant candidates instead of choosing two near copies', () => {
    const view = [
      memory('main', 'notebook memory', ['b', 'c', 'd']),
      memory('b', 'alpha beta gamma delta'),
      memory('c', 'alpha beta gamma delta extra'),
      memory('d', 'alpha beta coffee tourism'),
    ];
    const output = renderRelatedWhisperContext('main', view, 'alpha beta');
    expect(output).toContain('alpha beta gamma delta');
    expect(output).toContain('alpha beta coffee tourism');
    expect(output).not.toContain('delta extra');
  });

  it('keeps at most two direct neighbors even when the graph degree is large', () => {
    const links = Array.from({ length: 80 }, (_, i) => `related-${i}`);
    const view = [memory('main', '猫关注 AI 线下活动', links),
      ...links.map((id, i) => memory(id, `东京 AI 活动 ${i} 在 connpass 上发布`))];
    const output = renderRelatedWhisperContext('main', view, '东京 AI 活动');
    expect(output.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  it('matches CJK bigrams and normalizes Latin case/full-width, without embeddings', () => {
    const view = [
      memory('main', '東京イベント', ['japan', 'other']),
      memory('japan', '東京のＡＩイベント情報をチェック'),
      memory('other', '猫喜欢咖啡店'),
    ];
    const output = renderRelatedWhisperContext('main', view, '東京 AI イベント', new Set(), 45);
    expect(output).toContain('東京のＡＩイベント');
    expect(output).not.toContain('咖啡店');
  });

  it('does not reintroduce a related merged family already known by its old source id', () => {
    const family = { ...memory('b', '合并后的记忆'), resolution_source_memory_ids: ['a', 'b'] };
    const main = memory('c', '本次主记忆', ['b']);
    expect(renderRelatedWhisperContext('c', [main, family], '记忆', new Set(['a']))).toBe('');
  });

  it('reports exactly the related summaries actually included and merged source identities', () => {
    const family = { ...memory('b', '东京科技社区活动'), resolution_source_memory_ids: ['old-b', 'b'] };
    const main = memory('a', '东京 Meetup', ['b', 'c']);
    const other = memory('c', '完全无关的信息');
    const result = selectRelatedWhisperContext('a', [main, family, other], '东京 Meetup');
    expect(result.text).toContain('东京科技社区活动');
    expect(result.text).not.toContain('完全无关');
    expect(result.includedMemoryIds).toEqual(['b', 'old-b']);
    expect(selectRelatedWhisperContext('a', [main, family, other], '东京 Meetup', new Set(['old-b', 'c'])))
      .toEqual({ text: '', includedMemoryIds: [] });
  });

  it('never marks a candidate skipped by the final transport budget', () => {
    const main = memory('a', '东京 Meetup', ['b', 'c']);
    const view = [main, memory('b', '东京 Meetup 专场'), memory('c', '东京 Meetup 超级冗长活动说明')];
    const selected = selectRelatedWhisperContext('a', view, '东京 Meetup', new Set(), 39);
    expect(selected.includedMemoryIds).toHaveLength(1);
    const included = selected.includedMemoryIds[0];
    expect(['b', 'c']).toContain(included);
    expect(selected.text).toContain(view.find((m) => m.memory_id === included)!.summary);
    expect(selected.text).not.toContain(view.find((m) => m.memory_id !== included && m.memory_id !== 'a')!.summary);
  });

  it('returns no related block for isolated or suppressed main memories', () => {
    expect(renderRelatedWhisperContext('a', [memory('a', 'A')], 'A')).toBe('');
    expect(renderRelatedWhisperContext('a', [memory('a', 'A', ['b'], 'inactive'), memory('b', 'B')], 'B')).toBe('');
  });
});
