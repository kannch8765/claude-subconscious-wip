import { describe, expect, it } from 'vitest';
import type { EffectiveMemoryRecord } from '../relationship-memory/src/schema/index.js';
import { renderResolutionAwareWhisper } from './resolution_aware_whisper.js';

function memory(id: string, summary: string): EffectiveMemoryRecord {
  return {
    schema_version: 1, memory_id: id, subject_id: 'kohaku', kind: 'user_preference',
    summary, participants: ['user'], payload: { topic: '咖啡', preference: summary },
    status: 'active', observed_at: '2026-10-10T00:00:00.000Z',
    created_at: '2026-10-10T00:00:00.000Z', source_key: id, dedupe_key: id,
    owner_corrected: false,
  };
}
const selected = '记忆：猫现在喜欢轻食咖啡店。\n\n[2026-10-10]\n猫：「现在喜欢轻食咖啡店。」';

describe('resolution-aware Whisper transport-only formatting', () => {
  it('preserves default, same-meaning merged and unrelated content without fabricating quotes', () => {
    const merged = { ...memory('B', '猫现在喜欢轻食咖啡店。'), resolution_source_memory_ids: ['A', 'B'] };
    const unlinked = { ...merged, linked_memory_ids: ['C'] }; // unconfirmed hint
    for (const current of [merged, unlinked]) {
      expect(renderResolutionAwareWhisper({
        memoryId: 'B', historicalWindow: selected, currentMemories: [current, memory('C', '书店')],
        topic: '轻食',
      })).toBe(selected);
    }
  });

  it('renders time evolution with a bounded historical summary and unchanged selected original quotes', () => {
    const current = { ...memory('B', '猫现在喜欢轻食咖啡店。'), resolution_historical_memory_ids: ['A'] };
    const before = { ...memory('A', '猫以前更喜欢浓咖啡。'), observed_at: '2026-05-01T00:00:00.000Z' };
    const text = renderResolutionAwareWhisper({
      memoryId: 'B', historicalWindow: selected, currentMemories: [current],
      historicalMemories: [before],
      historicalEvidence: [{
        evidence_id: 'old-evidence', memory_id: 'A',
        conversation_id: 'old', message_id: 'msg-old', role: 'user',
        quote: '猫以前更喜欢浓咖啡。现在没有了。', captured_at: '2026-05-01T00:00:00.000Z',
        event_kind: 'user_text',
      }],
      topic: '咖啡',
    });
    expect(text).toContain('记忆：猫现在喜欢轻食咖啡店。');
    expect(text).toContain('历史阶段（不代表当前状态）：\n- [2026-05-01] 猫以前更喜欢浓咖啡。');
    expect(text).toContain('猫：「现在喜欢轻食咖啡店。」');
    expect(text).toContain('猫原话：「猫以前更喜欢浓咖啡。」');
    expect(text!.match(/猫：「/g)).toHaveLength(1);
    expect(text!.indexOf('历史阶段')).toBeLessThan(text!.indexOf('猫：「'));
  });

  it('shows the owner-reviewed condition without rewriting the quote', () => {
    const current = { ...memory('B', '猫现在喜欢轻食咖啡店。'), resolution_context: '仅周末与朋友外出时' };
    const rendered = renderResolutionAwareWhisper({
      memoryId: 'B', historicalWindow: selected, currentMemories: [current], topic: '咖啡',
    });
    expect(rendered).toContain('适用条件（已审核）：仅周末与朋友外出时');
    expect(rendered).toContain('猫：「现在喜欢轻食咖啡店。」');
    expect(rendered).not.toContain('历史阶段');
  });

  it('uses a late owner correction without altering the Agent-selected original quote', () => {
    const corrected = memory('B', '猫确认现在喜欢低咖啡因的饮品。');
    const rendered = renderResolutionAwareWhisper({
      memoryId: 'B', historicalWindow: selected, currentMemories: [corrected], topic: '咖啡',
    });
    expect(rendered).toContain('记忆：猫确认现在喜欢低咖啡因的饮品。');
    expect(rendered).not.toContain('记忆：猫现在喜欢轻食咖啡店。');
    expect(rendered).toContain('猫：「现在喜欢轻食咖啡店。」');
  });

  it('rejects any no-longer-current or conflict-hidden memory at delivery time', () => {
    const current = memory('B', 'B');
    const text = renderResolutionAwareWhisper({
      memoryId: 'A', historicalWindow: selected, currentMemories: [current],
      topic: '咖啡',
    });
    expect(text).toBeNull();
    expect(renderResolutionAwareWhisper({
      memoryId: 'A', historicalWindow: selected,
      currentMemories: [{ ...memory('A', 'A'), status: 'inactive' }], topic: '咖啡',
    })).toBeNull();
  });

  it('adds only reviewed direct related summaries, not original untyped links', () => {
    const current = { ...memory('B', '东京 AI Meetup'), linked_memory_ids: ['C', 'D'],
      resolution_confirmed_related_memory_ids: ['C'] };
    const output = renderResolutionAwareWhisper({
      memoryId: 'B', historicalWindow: '记忆：东京 AI Meetup', currentMemories: [
        current, memory('C', '猫去东京 AI 活动'), memory('D', '猫喜欢东京 AI 活动中的美食'),
      ], topic: '东京 AI',
    });
    expect(output).toContain('关联记忆（背景，仅摘要）：');
    expect(output).toContain('猫去东京 AI 活动');
    expect(output).not.toContain('美食');
  });

  it('does not add an automatic unrelated memory even when the raw graph holds an edge', () => {
    const current = { ...memory('B', '猫去东京活动'), linked_memory_ids: ['C'] };
    const output = renderResolutionAwareWhisper({
      memoryId: 'B', historicalWindow: '记忆：猫去东京活动', currentMemories: [current, memory('C', '独立的工作信息')],
      topic: '东京',
    });
    expect(output).toBe('记忆：猫去东京活动');
  });

  it('keeps the historical display bounded and stable when a memory has many prior states', () => {
    const history = Array.from({length: 20}, (_, i) => memory('old-'+i, '历史事实'+i));
    const current = { ...memory('B','猫现在的偏好'), resolution_historical_memory_ids: history.map(m=>m.memory_id) };
    const first = renderResolutionAwareWhisper({
      memoryId: 'B', historicalWindow: '记忆：猫现在的偏好',
      currentMemories: [current], historicalMemories: history, topic: '偏好',
    });
    expect(first?.split('\n').filter(x=>x.startsWith('- '))).toHaveLength(3);
    expect(first?.length).toBeLessThan(500);
  });
});
